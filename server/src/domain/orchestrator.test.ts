import { describe, it, expect } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { Session } from './session.js';
import type { IClaudeProcess, Notification, ProgressEvent, SessionOptions } from './types.js';

// --- テスト用モック ---

class MockClaudeProcess implements IClaudeProcess {
  isRunning = false;
  spawnCalls: Array<{
    prompt: string;
    sessionId: string;
    workDir: string;
    resume: boolean;
    options?: SessionOptions;
  }> = [];
  interruptCalls = 0;

  spawn(
    prompt: string,
    sessionId: string,
    workDir: string,
    resume: boolean,
    options?: SessionOptions,
  ): void {
    this.isRunning = true;
    this.spawnCalls.push({ prompt, sessionId, workDir, resume, options });
  }

  interrupt(): void {
    this.interruptCalls++;
  }

  simulateEnd(): void {
    this.isRunning = false;
  }
}

// --- ヘルパー ---

const WORK_DIR = '/home/user/projects/test';

function createOrchestrator() {
  const session = new Session(WORK_DIR);
  const mockProcess = new MockClaudeProcess();
  const notifications: Notification[] = [];
  const notify = (n: Notification) => notifications.push(n);
  const orchestrator = new Orchestrator(session, mockProcess, notify);
  return { orchestrator, session, mockProcess, notifications };
}

/** Initial → Idle（!new でセッション作成） */
function toIdle(ctx: ReturnType<typeof createOrchestrator>) {
  ctx.orchestrator.handleCommand({ type: 'new', options: {} });
  ctx.notifications.length = 0;
}

/** Initial → Idle → Busy */
function toBusy(ctx: ReturnType<typeof createOrchestrator>) {
  toIdle(ctx);
  ctx.orchestrator.handleMessage('some prompt');
  ctx.notifications.length = 0;
}

/** Initial → Idle → Busy → Idle（一度処理を完了） */
function toIdleAfterTask(ctx: ReturnType<typeof createOrchestrator>) {
  toBusy(ctx);
  ctx.mockProcess.simulateEnd();
  ctx.orchestrator.onProcessEnd(0, 'done');
  ctx.notifications.length = 0;
}

/** Initial → Idle → Busy → Interrupting */
function toInterrupting(ctx: ReturnType<typeof createOrchestrator>, reason: 'new' | 'interrupt') {
  toBusy(ctx);
  ctx.orchestrator.handleCommand(
    reason === 'new' ? { type: 'new', options: {} } : { type: 'interrupt' },
  );
  ctx.notifications.length = 0;
}

// =================================================================
// テスト本体
// =================================================================

describe('Orchestrator', () => {
  // ----- 状態導出 -----

  describe('状態導出', () => {
    it('sessionId=null, process停止 → "initial"', () => {
      const { orchestrator } = createOrchestrator();
      expect(orchestrator.state).toBe('initial');
    });

    it('sessionId≠null, process停止 → "idle"', () => {
      const ctx = createOrchestrator();
      toIdle(ctx);
      expect(ctx.orchestrator.state).toBe('idle');
    });

    it('process実行中, interruptReason=null → "busy"', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);
      expect(ctx.orchestrator.state).toBe('busy');
    });

    it('process実行中, interruptReason≠null → "interrupting"', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');
      expect(ctx.orchestrator.state).toBe('interrupting');
    });
  });

  // ----- Initial 状態 -----

  describe('Initial 状態', () => {
    it('PromptInput → セッション開始を促す通知, Initial 維持', () => {
      const { orchestrator, mockProcess, notifications } = createOrchestrator();

      orchestrator.handleMessage('hello');

      expect(orchestrator.state).toBe('initial');
      expect(mockProcess.spawnCalls).toHaveLength(0);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        type: 'info',
        message: '`/cc new` でセッションを開始してください',
      });
    });

    it('NewCommand → セッション作成 + 通知 → Idle', () => {
      const { orchestrator, session, notifications } = createOrchestrator();

      orchestrator.handleCommand({ type: 'new', options: {} });

      expect(orchestrator.state).toBe('idle');
      expect(session.sessionId).not.toBeNull();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました',
      });
    });

    it('InterruptCommand → 何もしない, Initial 維持', () => {
      const { orchestrator, notifications } = createOrchestrator();

      orchestrator.handleCommand({ type: 'interrupt' });

      expect(orchestrator.state).toBe('initial');
      expect(notifications).toHaveLength(0);
    });
  });

  // ----- Idle 状態 -----

  describe('Idle 状態', () => {
    it('PromptInput（新規セッション初回）→ resume=false で spawn → Busy', () => {
      const ctx = createOrchestrator();
      toIdle(ctx);
      const sessionId = ctx.session.sessionId;

      ctx.orchestrator.handleMessage('first prompt');

      expect(ctx.mockProcess.spawnCalls).toHaveLength(1);
      expect(ctx.mockProcess.spawnCalls[0]).toEqual({
        prompt: 'first prompt',
        sessionId,
        workDir: WORK_DIR,
        resume: false,
        options: {},
      });
      expect(ctx.orchestrator.state).toBe('busy');
    });

    it('PromptInput（既存セッション継続）→ resume=true で spawn → Busy', () => {
      const ctx = createOrchestrator();
      toIdleAfterTask(ctx);
      const sessionId = ctx.session.sessionId;

      ctx.orchestrator.handleMessage('next prompt');

      const lastCall = ctx.mockProcess.spawnCalls[ctx.mockProcess.spawnCalls.length - 1];
      expect(lastCall).toEqual({
        prompt: 'next prompt',
        sessionId,
        workDir: WORK_DIR,
        resume: true,
        options: {},
      });
      expect(ctx.orchestrator.state).toBe('busy');
    });

    it('NewCommand → セッションリセット + 新規作成 → Idle（新しい sessionId）', () => {
      const ctx = createOrchestrator();
      toIdle(ctx);
      const oldSessionId = ctx.session.sessionId;

      ctx.orchestrator.handleCommand({ type: 'new', options: {} });

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBeNull();
      expect(ctx.session.sessionId).not.toBe(oldSessionId);
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました',
      });
    });

    it('InterruptCommand → 何もしない, Idle 維持', () => {
      const ctx = createOrchestrator();
      toIdle(ctx);

      ctx.orchestrator.handleCommand({ type: 'interrupt' });

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.notifications).toHaveLength(0);
    });
  });

  // ----- Busy 状態 -----

  describe('Busy 状態', () => {
    it('PromptInput → 「処理中です」通知, Busy 維持', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.orchestrator.handleMessage('another prompt');

      expect(ctx.orchestrator.state).toBe('busy');
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({ type: 'info', message: '処理中です' });
      expect(ctx.mockProcess.spawnCalls).toHaveLength(1);
    });

    it('NewCommand → interruptReason="new", interrupt() → Interrupting', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.orchestrator.handleCommand({ type: 'new', options: {} });

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });

    it('InterruptCommand → interruptReason="interrupt", interrupt() → Interrupting', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.orchestrator.handleCommand({ type: 'interrupt' });

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });
  });

  // ----- Interrupting 状態 -----

  describe('Interrupting 状態', () => {
    it('PromptInput → 「処理中です」通知, Interrupting 維持', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');

      ctx.orchestrator.handleMessage('hello');

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({ type: 'info', message: '処理中です' });
    });

    it('NewCommand → 無視（既に中断処理中）', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');

      ctx.orchestrator.handleCommand({ type: 'new', options: {} });

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.notifications).toHaveLength(0);
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });

    it('InterruptCommand → 無視（既に中断処理中）', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'new');

      ctx.orchestrator.handleCommand({ type: 'interrupt' });

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.notifications).toHaveLength(0);
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });
  });

  // ----- プロセス終了 -----

  describe('onProcessEnd（Busy からの自然終了）', () => {
    it('正常終了(exitCode=0) → 結果テキスト通知, Idle', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, 'result text');

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({ type: 'result', text: 'result text' });
    });

    it('異常終了(exitCode≠0) → エラー通知, Idle', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(1, 'something failed');

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({
        type: 'error',
        message: 'something failed',
        exitCode: 1,
      });
    });

    it('正常終了後も sessionId は維持される', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);
      const sessionId = ctx.session.sessionId;

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, 'done');

      expect(ctx.session.sessionId).toBe(sessionId);
    });
  });

  describe('onProcessEnd（Interrupting, reason="interrupt"）', () => {
    it('「中断しました」通知, Idle', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({ type: 'info', message: '中断しました' });
    });

    it('sessionId は維持される', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');
      const sessionId = ctx.session.sessionId;

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');

      expect(ctx.session.sessionId).toBe(sessionId);
    });
  });

  describe('onProcessEnd（Interrupting, reason="new"）', () => {
    it('セッションリセット + 新規作成 → Idle', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'new');
      const oldSessionId = ctx.session.sessionId;

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBeNull();
      expect(ctx.session.sessionId).not.toBe(oldSessionId);
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました',
      });
    });
  });

  // ----- 途中経過の通知 -----

  describe('onProgress（途中経過の通知）', () => {
    it('Busy 中のツール使用イベントが通知される', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      const event: ProgressEvent = { kind: 'tool_use', toolName: 'Edit', target: 'src/index.ts' };
      ctx.orchestrator.onProgress(event);

      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({ type: 'progress', event });
    });

    it('Busy 中の拡張思考イベントが通知される', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      const event: ProgressEvent = { kind: 'thinking', text: 'Let me think about this...' };
      ctx.orchestrator.onProgress(event);

      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({ type: 'progress', event });
    });

    it('Interrupting 中でも途中経過が通知される', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');

      const event: ProgressEvent = { kind: 'tool_use', toolName: 'Bash', target: 'npm test' };
      ctx.orchestrator.onProgress(event);

      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({ type: 'progress', event });
    });

    it('途中経過通知は状態遷移を起こさない', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.orchestrator.onProgress({ kind: 'tool_use', toolName: 'Edit', target: 'file.ts' });
      ctx.orchestrator.onProgress({ kind: 'thinking', text: 'thinking...' });

      expect(ctx.orchestrator.state).toBe('busy');
    });
  });

  // ----- セッションオプション -----

  describe('セッションオプション', () => {
    it('/cc new にオプションを指定すると通知メッセージに含まれる', () => {
      const { orchestrator, notifications } = createOrchestrator();

      orchestrator.handleCommand({ type: 'new', options: { model: 'sonnet', effort: 'max' } });

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました (model: sonnet, effort: max)',
      });
    });

    it('/cc new のオプションが Session に保存される', () => {
      const { orchestrator, session } = createOrchestrator();

      orchestrator.handleCommand({ type: 'new', options: { model: 'opus', effort: 'high' } });

      expect(session.options).toEqual({ model: 'opus', effort: 'high' });
    });

    it('オプションが spawn に渡される', () => {
      const ctx = createOrchestrator();

      ctx.orchestrator.handleCommand({ type: 'new', options: { model: 'sonnet', effort: 'max' } });
      ctx.orchestrator.handleMessage('hello');

      expect(ctx.mockProcess.spawnCalls[0].options).toEqual({ model: 'sonnet', effort: 'max' });
    });

    it('オプションなしの !new では空オプション', () => {
      const { orchestrator, session } = createOrchestrator();

      orchestrator.handleCommand({ type: 'new', options: {} });

      expect(session.options).toEqual({});
    });

    it('Busy 中の !new オプションが中断後の新セッションに引き継がれる', () => {
      const ctx = createOrchestrator();

      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      ctx.orchestrator.handleMessage('task');
      ctx.notifications.length = 0;

      // Busy 中に !new --model sonnet
      ctx.orchestrator.handleCommand({ type: 'new', options: { model: 'sonnet', effort: 'max' } });
      expect(ctx.orchestrator.state).toBe('interrupting');

      // プロセス終了 → 新セッション
      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');

      expect(ctx.session.options).toEqual({ model: 'sonnet', effort: 'max' });
      expect(ctx.notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました (model: sonnet, effort: max)',
      });
    });
  });

  // ----- 複合シナリオ -----

  describe('複合シナリオ', () => {
    it('完全ライフサイクル: !new → Idle → Busy → Idle → !new → Idle', () => {
      const ctx = createOrchestrator();

      // !new → Idle
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      expect(ctx.orchestrator.state).toBe('idle');
      const firstSessionId = ctx.session.sessionId;

      // Idle → Busy
      ctx.orchestrator.handleMessage('first task');
      expect(ctx.orchestrator.state).toBe('busy');

      // Busy → Idle
      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, 'done 1');
      expect(ctx.orchestrator.state).toBe('idle');

      // Idle → Busy（同一セッション）
      ctx.orchestrator.handleMessage('second task');
      expect(ctx.orchestrator.state).toBe('busy');
      expect(ctx.session.sessionId).toBe(firstSessionId);

      // Busy → Idle
      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, 'done 2');
      expect(ctx.orchestrator.state).toBe('idle');

      // !new → Idle（新しいセッション）
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBe(firstSessionId);
    });

    it('Busy 中に /cc interrupt: Busy → Interrupting → Idle', () => {
      const ctx = createOrchestrator();

      toIdle(ctx);
      ctx.orchestrator.handleMessage('long task');
      expect(ctx.orchestrator.state).toBe('busy');

      ctx.orchestrator.handleCommand({ type: 'interrupt' });
      expect(ctx.orchestrator.state).toBe('interrupting');

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');
      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBeNull();
    });

    it('Busy 中に !new: Busy → Interrupting → Idle（新セッション）', () => {
      const ctx = createOrchestrator();

      toIdle(ctx);
      ctx.orchestrator.handleMessage('long task');
      const oldSessionId = ctx.session.sessionId;
      expect(ctx.orchestrator.state).toBe('busy');

      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      expect(ctx.orchestrator.state).toBe('interrupting');

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');
      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBe(oldSessionId);
    });

    it('/cc new 後に新しい会話を開始できる', () => {
      const ctx = createOrchestrator();

      // 最初の会話
      toIdle(ctx);
      ctx.orchestrator.handleMessage('task 1');
      const firstSessionId = ctx.session.sessionId;
      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, 'result 1');

      // リセット + 新セッション
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      expect(ctx.session.sessionId).not.toBe(firstSessionId);

      // 新しい会話
      ctx.orchestrator.handleMessage('task 2');
      expect(ctx.orchestrator.state).toBe('busy');
    });

    it('Busy 中に複数の PromptInput は全て拒否される', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.orchestrator.handleMessage('prompt 1');
      ctx.orchestrator.handleMessage('prompt 2');
      ctx.orchestrator.handleMessage('prompt 3');

      expect(ctx.notifications).toHaveLength(3);
      ctx.notifications.forEach((n) => {
        expect(n).toEqual({ type: 'info', message: '処理中です' });
      });
      expect(ctx.mockProcess.spawnCalls).toHaveLength(1);
    });

    it('Interrupting 中に全種類の入力を送っても状態は変わらない', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');

      ctx.orchestrator.handleMessage('prompt');
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      ctx.orchestrator.handleCommand({ type: 'interrupt' });
      ctx.orchestrator.handleMessage('another prompt');

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.notifications.filter((n) => n.type === 'info')).toHaveLength(2);
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });
  });
});
