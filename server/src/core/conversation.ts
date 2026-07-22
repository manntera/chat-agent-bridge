import type { Notification, ProgressEvent, SessionOptions, Workspace } from './types.js';

/**
 * 会話の状態機械(純粋リデューサー)。
 *
 * 旧 Orchestrator のクラス+コールバック構造を `(state, event) → { state, effects }`
 * の純関数に置き換えたもの。副作用(プロセス起動・通知・永続化)はすべて
 * Effect データとして返し、実行は app/runtime.ts に委ねる。
 * これによりテストはテーブル駆動になり、再起動後の状態復元は
 * ストアの行から initialState / resumedState を作るだけで済む。
 */

export interface QueuedPrompt {
  text: string;
  platformMessageId: string | null;
}

export type Phase = 'idle' | 'busy' | 'interrupting';

export interface ConversationState {
  workspace: Workspace;
  sessionId: string;
  /** claude -p にまだ一度も渡していないセッション(--session-id で新規発行する) */
  isNewSession: boolean;
  options: SessionOptions;
  phase: Phase;
  turn: number;
  interruptReason: 'new' | 'interrupt' | null;
  /** busy 中に /cc new された場合の次セッション情報 */
  pendingNew: { sessionId: string; options: SessionOptions } | null;
  /** busy 中に届いたプロンプトの待ち行列 */
  queue: QueuedPrompt[];
}

export type ConversationEvent =
  | { type: 'prompt'; text: string; platformMessageId: string | null }
  | { type: 'new'; sessionId: string; options: SessionOptions }
  | { type: 'interrupt' }
  | { type: 'rewound'; newSessionId: string; targetTurn: number; prompt: QueuedPrompt | null }
  | { type: 'processEnded'; exitCode: number; output: string }
  | { type: 'progress'; event: ProgressEvent };

export type Effect =
  | {
      type: 'spawn';
      prompt: string;
      sessionId: string;
      workDir: string;
      resume: boolean;
      options: SessionOptions;
    }
  | { type: 'interruptProcess' }
  | { type: 'notify'; notification: Notification }
  | { type: 'recordTurn'; turn: number; platformMessageId: string | null; prompt: string }
  | { type: 'truncateTurnsAfter'; turn: number }
  | { type: 'fetchUsage' }
  | { type: 'turnCompleted' };

export interface ReduceResult {
  state: ConversationState;
  effects: Effect[];
}

export function initialState(
  workspace: Workspace,
  sessionId: string,
  options: SessionOptions = {},
): ConversationState {
  return {
    workspace,
    sessionId,
    isNewSession: true,
    options,
    phase: 'idle',
    turn: 0,
    interruptReason: null,
    pendingNew: null,
    queue: [],
  };
}

export function resumedState(
  workspace: Workspace,
  sessionId: string,
  turn: number,
  options: SessionOptions = {},
): ConversationState {
  return {
    ...initialState(workspace, sessionId, options),
    isNewSession: false,
    turn,
  };
}

function formatOptionsSuffix(options: SessionOptions): string {
  const details: string[] = [];
  if (options.model) details.push(`model: ${options.model}`);
  if (options.effort) details.push(`effort: ${options.effort}`);
  return details.length > 0 ? ` (${details.join(', ')})` : '';
}

function notify(notification: Notification): Effect {
  return { type: 'notify', notification };
}

function info(message: string): Effect {
  return notify({ type: 'info', message });
}

/** プロンプト実行を開始する状態遷移(idle 前提)。spawn + recordTurn + started 通知。 */
function startPrompt(state: ConversationState, prompt: QueuedPrompt): ReduceResult {
  const turn = state.turn + 1;
  const resume = !state.isNewSession;
  return {
    state: { ...state, phase: 'busy', turn, isNewSession: false },
    effects: [
      notify({ type: 'progress', event: { kind: 'started' } }),
      {
        type: 'recordTurn',
        turn,
        platformMessageId: prompt.platformMessageId,
        prompt: prompt.text,
      },
      {
        type: 'spawn',
        prompt: prompt.text,
        sessionId: state.sessionId,
        workDir: state.workspace.path,
        resume,
        options: state.options,
      },
    ],
  };
}

export function reduce(state: ConversationState, event: ConversationEvent): ReduceResult {
  switch (event.type) {
    case 'prompt': {
      const prompt: QueuedPrompt = {
        text: event.text.trim(),
        platformMessageId: event.platformMessageId,
      };
      if (state.phase === 'idle') {
        return startPrompt(state, prompt);
      }
      // busy / interrupting 中はキューに積む(旧実装は「処理中です」で破棄していた)
      const queue = [...state.queue, prompt];
      return {
        state: { ...state, queue },
        effects: [info(`⏳ 処理中のためキューに追加しました(待ち ${queue.length} 件)`)],
      };
    }

    case 'new': {
      if (state.phase === 'idle') {
        const next: ConversationState = {
          ...state,
          sessionId: event.sessionId,
          isNewSession: true,
          options: event.options,
          turn: 0,
          queue: [],
        };
        return {
          state: next,
          effects: [
            info(
              `新しいセッションを開始しました [${event.sessionId.slice(0, 8)}]${formatOptionsSuffix(event.options)}`,
            ),
          ],
        };
      }
      // busy 中: プロセスを中断し、終了後に新セッションへ切り替える
      return {
        state: {
          ...state,
          phase: 'interrupting',
          interruptReason: 'new',
          pendingNew: { sessionId: event.sessionId, options: event.options },
          queue: [],
        },
        effects: [{ type: 'interruptProcess' }],
      };
    }

    case 'interrupt': {
      if (state.phase !== 'busy') {
        return { state, effects: [] };
      }
      const dropped = state.queue.length;
      const effects: Effect[] = [{ type: 'interruptProcess' }];
      if (dropped > 0) {
        effects.push(info(`キューの ${dropped} 件を破棄しました`));
      }
      return {
        state: { ...state, phase: 'interrupting', interruptReason: 'interrupt', queue: [] },
        effects,
      };
    }

    case 'rewound': {
      if (state.phase !== 'idle') {
        return {
          state,
          effects: [info('処理中のため巻き戻しできません。完了後に再度お試しください。')],
        };
      }
      const rewound: ConversationState = {
        ...state,
        sessionId: event.newSessionId,
        isNewSession: false,
        turn: event.targetTurn,
      };
      const effects: Effect[] = [
        { type: 'truncateTurnsAfter', turn: event.targetTurn },
        info(`⏪ Turn ${event.targetTurn} まで巻き戻しました [${event.newSessionId.slice(0, 8)}]`),
      ];
      if (event.prompt) {
        const started = startPrompt(rewound, event.prompt);
        return { state: started.state, effects: [...effects, ...started.effects] };
      }
      return { state: rewound, effects };
    }

    case 'processEnded': {
      const base: ConversationState = {
        ...state,
        phase: 'idle',
        interruptReason: null,
        pendingNew: null,
      };
      const effects: Effect[] = [];

      if (state.interruptReason === 'interrupt') {
        effects.push(info('中断しました'));
      } else if (state.interruptReason === 'new' && state.pendingNew) {
        base.sessionId = state.pendingNew.sessionId;
        base.isNewSession = true;
        base.options = state.pendingNew.options;
        base.turn = 0;
        effects.push(
          info(
            `新しいセッションを開始しました [${state.pendingNew.sessionId.slice(0, 8)}]${formatOptionsSuffix(state.pendingNew.options)}`,
          ),
        );
      } else if (event.exitCode === 0) {
        effects.push(notify({ type: 'result', text: event.output }));
      } else {
        effects.push(notify({ type: 'error', message: event.output, exitCode: event.exitCode }));
      }

      effects.push({ type: 'fetchUsage' });
      // 中断・セッション切替時はターン成果がないため、タイトル生成などの後処理は行わない
      if (state.interruptReason === null) {
        effects.push({ type: 'turnCompleted' });
      }

      // 正常完了でキューに残りがあれば次のプロンプトを自動実行する
      if (state.interruptReason === null && state.queue.length > 0) {
        const [next, ...rest] = state.queue;
        const started = startPrompt({ ...base, queue: rest }, next);
        return { state: started.state, effects: [...effects, ...started.effects] };
      }

      return {
        state: { ...base, queue: state.interruptReason === null ? state.queue : [] },
        effects,
      };
    }

    case 'progress':
      return { state, effects: [notify({ type: 'progress', event: event.event })] };
  }
}
