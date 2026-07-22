import { describe, it, expect } from 'vitest';
import {
  initialState,
  reduce,
  resumedState,
  type ConversationState,
  type Effect,
} from './conversation.js';
import type { Notification } from './types.js';

const WS = { name: 'proj', path: '/work/proj' };

function effectTypes(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

function notifications(effects: Effect[]): Notification[] {
  return effects
    .filter((e): e is Extract<Effect, { type: 'notify' }> => e.type === 'notify')
    .map((e) => e.notification);
}

describe('initialState / resumedState', () => {
  it('initialState は新規セッション・idle・turn 0', () => {
    const s = initialState(WS, 'sess-1', { model: 'opus' });
    expect(s.phase).toBe('idle');
    expect(s.isNewSession).toBe(true);
    expect(s.turn).toBe(0);
    expect(s.options).toEqual({ model: 'opus' });
  });

  it('resumedState は既存セッション・ターン数復元', () => {
    const s = resumedState(WS, 'sess-1', 5);
    expect(s.isNewSession).toBe(false);
    expect(s.turn).toBe(5);
  });
});

describe('prompt', () => {
  it('idle 時: turn を進めて spawn し、recordTurn と started を発行する', () => {
    const s = initialState(WS, 'sess-1');
    const { state, effects } = reduce(s, {
      type: 'prompt',
      text: ' hello ',
      platformMessageId: 'msg-1',
    });

    expect(state.phase).toBe('busy');
    expect(state.turn).toBe(1);
    expect(state.isNewSession).toBe(false);
    expect(effectTypes(effects)).toEqual(['notify', 'recordTurn', 'spawn']);

    const spawn = effects.find((e) => e.type === 'spawn')!;
    expect(spawn).toMatchObject({
      prompt: 'hello',
      sessionId: 'sess-1',
      workDir: '/work/proj',
      resume: false,
    });

    const record = effects.find((e) => e.type === 'recordTurn')!;
    expect(record).toMatchObject({ turn: 1, platformMessageId: 'msg-1', prompt: 'hello' });
  });

  it('再開済みセッションでは resume: true で spawn する', () => {
    const s = resumedState(WS, 'sess-1', 3);
    const { effects } = reduce(s, { type: 'prompt', text: 'hi', platformMessageId: null });
    const spawn = effects.find((e) => e.type === 'spawn')!;
    expect(spawn).toMatchObject({ resume: true });
  });

  it('busy 時: キューに積み、件数を通知する', () => {
    const s: ConversationState = { ...initialState(WS, 'sess-1'), phase: 'busy' };
    const { state, effects } = reduce(s, { type: 'prompt', text: 'next', platformMessageId: 'm2' });

    expect(state.queue).toHaveLength(1);
    expect(effectTypes(effects)).toEqual(['notify']);
    const n = notifications(effects)[0];
    expect(n.type).toBe('info');
  });
});

describe('new', () => {
  it('idle 時: セッションを置き換えて turn をリセットする', () => {
    const s = { ...resumedState(WS, 'old', 5) };
    const { state, effects } = reduce(s, {
      type: 'new',
      sessionId: 'new-sess',
      options: { effort: 'max' },
    });

    expect(state.sessionId).toBe('new-sess');
    expect(state.isNewSession).toBe(true);
    expect(state.turn).toBe(0);
    expect(state.options).toEqual({ effort: 'max' });
    const n = notifications(effects)[0];
    expect(n).toMatchObject({ type: 'info' });
    expect((n as { message: string }).message).toContain('new-sess'.slice(0, 8));
  });

  it('busy 時: 中断し、pendingNew を積む', () => {
    const s: ConversationState = { ...initialState(WS, 'sess-1'), phase: 'busy' };
    const { state, effects } = reduce(s, { type: 'new', sessionId: 'next', options: {} });

    expect(state.phase).toBe('interrupting');
    expect(state.interruptReason).toBe('new');
    expect(state.pendingNew).toEqual({ sessionId: 'next', options: {} });
    expect(effectTypes(effects)).toEqual(['interruptProcess']);
  });
});

describe('interrupt', () => {
  it('busy 時: interrupting に遷移してプロセスを中断する', () => {
    const s: ConversationState = { ...initialState(WS, 'sess-1'), phase: 'busy' };
    const { state, effects } = reduce(s, { type: 'interrupt' });

    expect(state.phase).toBe('interrupting');
    expect(state.interruptReason).toBe('interrupt');
    expect(effectTypes(effects)).toEqual(['interruptProcess']);
  });

  it('busy 時にキューがあれば破棄して通知する', () => {
    const s: ConversationState = {
      ...initialState(WS, 'sess-1'),
      phase: 'busy',
      queue: [{ text: 'queued', platformMessageId: null }],
    };
    const { state, effects } = reduce(s, { type: 'interrupt' });

    expect(state.queue).toHaveLength(0);
    expect(effectTypes(effects)).toEqual(['interruptProcess', 'notify']);
  });

  it('idle 時: 何もしない', () => {
    const s = initialState(WS, 'sess-1');
    const { state, effects } = reduce(s, { type: 'interrupt' });
    expect(state).toBe(s);
    expect(effects).toHaveLength(0);
  });
});

describe('processEnded', () => {
  function busyState(overrides: Partial<ConversationState> = {}): ConversationState {
    return { ...initialState(WS, 'sess-1'), phase: 'busy', turn: 1, ...overrides };
  }

  it('正常終了: result 通知 + fetchUsage + turnCompleted', () => {
    const { state, effects } = reduce(busyState(), {
      type: 'processEnded',
      exitCode: 0,
      output: '回答',
    });

    expect(state.phase).toBe('idle');
    expect(effectTypes(effects)).toEqual(['notify', 'fetchUsage', 'turnCompleted']);
    expect(notifications(effects)[0]).toEqual({ type: 'result', text: '回答' });
  });

  it('異常終了: error 通知', () => {
    const { effects } = reduce(busyState(), { type: 'processEnded', exitCode: 1, output: 'err' });
    expect(notifications(effects)[0]).toEqual({ type: 'error', message: 'err', exitCode: 1 });
  });

  it('interrupt 起因: 「中断しました」を通知する', () => {
    const { state, effects } = reduce(
      busyState({ phase: 'interrupting', interruptReason: 'interrupt' }),
      { type: 'processEnded', exitCode: 130, output: '' },
    );

    expect(state.phase).toBe('idle');
    expect(state.interruptReason).toBeNull();
    const n = notifications(effects)[0];
    expect((n as { message: string }).message).toBe('中断しました');
    // 中断時はタイトル生成などの後処理(turnCompleted)を行わない
    expect(effectTypes(effects)).toEqual(['notify', 'fetchUsage']);
  });

  it('new 起因: pendingNew のセッションへ切り替わる', () => {
    const { state, effects } = reduce(
      busyState({
        phase: 'interrupting',
        interruptReason: 'new',
        pendingNew: { sessionId: 'next-sess', options: { model: 'haiku' } },
      }),
      { type: 'processEnded', exitCode: 130, output: '' },
    );

    expect(state.sessionId).toBe('next-sess');
    expect(state.isNewSession).toBe(true);
    expect(state.turn).toBe(0);
    expect(state.options).toEqual({ model: 'haiku' });
    const n = notifications(effects)[0];
    expect((n as { message: string }).message).toContain('model: haiku');
  });

  it('キューに残りがあれば次のプロンプトを自動実行する', () => {
    const { state, effects } = reduce(
      busyState({
        isNewSession: false, // 1ターン目の実行時に消費済み
        queue: [{ text: 'queued prompt', platformMessageId: 'm9' }],
      }),
      { type: 'processEnded', exitCode: 0, output: 'done' },
    );

    expect(state.phase).toBe('busy');
    expect(state.turn).toBe(2);
    expect(state.queue).toHaveLength(0);
    expect(effectTypes(effects)).toEqual([
      'notify', // result
      'fetchUsage',
      'turnCompleted',
      'notify', // started
      'recordTurn',
      'spawn',
    ]);
    const spawn = effects.find((e) => e.type === 'spawn')!;
    expect(spawn).toMatchObject({ prompt: 'queued prompt', resume: true });
  });
});

describe('rewound', () => {
  it('idle 時: セッションを差し替え、ターンを巻き戻し、truncate する', () => {
    const s = resumedState(WS, 'old-sess', 5);
    const { state, effects } = reduce(s, {
      type: 'rewound',
      newSessionId: 'branch-sess',
      targetTurn: 2,
      prompt: null,
    });

    expect(state.sessionId).toBe('branch-sess');
    expect(state.turn).toBe(2);
    expect(effectTypes(effects)).toEqual(['truncateTurnsAfter', 'notify']);
  });

  it('idle 時 + prompt 付き: 巻き戻し後にそのままプロンプトを実行する', () => {
    const s = resumedState(WS, 'old-sess', 5);
    const { state, effects } = reduce(s, {
      type: 'rewound',
      newSessionId: 'branch-sess',
      targetTurn: 2,
      prompt: { text: '修正して', platformMessageId: 'm5' },
    });

    expect(state.phase).toBe('busy');
    expect(state.turn).toBe(3);
    const spawn = effects.find((e) => e.type === 'spawn')!;
    expect(spawn).toMatchObject({ prompt: '修正して', sessionId: 'branch-sess', resume: true });
    const record = effects.find((e) => e.type === 'recordTurn')!;
    expect(record).toMatchObject({ turn: 3, platformMessageId: 'm5' });
  });

  it('busy 時: 巻き戻せない旨を通知して状態を変えない', () => {
    const s: ConversationState = { ...resumedState(WS, 'sess', 5), phase: 'busy' };
    const { state, effects } = reduce(s, {
      type: 'rewound',
      newSessionId: '',
      targetTurn: 2,
      prompt: null,
    });

    expect(state).toBe(s);
    expect(effectTypes(effects)).toEqual(['notify']);
  });
});

describe('progress', () => {
  it('progress イベントを通知に変換する', () => {
    const s = initialState(WS, 'sess-1');
    const { effects } = reduce(s, {
      type: 'progress',
      event: { kind: 'tool_use', toolName: 'Read', target: 'a.ts' },
    });
    expect(notifications(effects)[0]).toEqual({
      type: 'progress',
      event: { kind: 'tool_use', toolName: 'Read', target: 'a.ts' },
    });
  });
});
