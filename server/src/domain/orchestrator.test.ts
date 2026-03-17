import { describe, it, expect } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { Session } from './session.js';
import type { IClaudeProcess, Notification } from './types.js';

// --- テスト用モック ---

class MockClaudeProcess implements IClaudeProcess {
  isRunning = false;
  spawnCalls: Array<{ prompt: string; sessionId: string; workDir: string }> = [];
  interruptCalls = 0;

  spawn(prompt: string, sessionId: string, workDir: string): void {
    this.isRunning = true;
    this.spawnCalls.push({ prompt, sessionId, workDir });
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

/** Initial → Busy → Idle */
function toIdle(ctx: ReturnType<typeof createOrchestrator>) {
  ctx.orchestrator.handleMessage('setup prompt');
  ctx.mockProcess.simulateEnd();
  ctx.orchestrator.onProcessEnd(0, 'setup result');
  ctx.notifications.length = 0;
}

/** Initial → Busy */
function toBusy(ctx: ReturnType<typeof createOrchestrator>) {
  ctx.orchestrator.handleMessage('some prompt');
  ctx.notifications.length = 0;
}

/** Initial → Busy → Interrupting */
function toInterrupting(ctx: ReturnType<typeof createOrchestrator>, reason: 'new' | 'interrupt') {
  toBusy(ctx);
  ctx.orchestrator.handleMessage(reason === 'new' ? '!new' : '!interrupt');
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
    it('PromptInput → Session.ensure() + spawn → Busy', () => {
      const { orchestrator, session, mockProcess } = createOrchestrator();

      orchestrator.handleMessage('hello');

      expect(session.sessionId).not.toBeNull();
      expect(mockProcess.spawnCalls).toHaveLength(1);
      expect(mockProcess.spawnCalls[0]).toEqual({
        prompt: 'hello',
        sessionId: session.sessionId,
        workDir: WORK_DIR,
      });
      expect(orchestrator.state).toBe('busy');
    });

    it('NewCommand → 「セッションがありません」通知, Initial 維持', () => {
      const { orchestrator, notifications } = createOrchestrator();

      orchestrator.handleMessage('!new');

      expect(orchestrator.state).toBe('initial');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({ type: 'info', message: 'セッションがありません' });
    });

    it('InterruptCommand → 何もしない, Initial 維持', () => {
      const { orchestrator, notifications } = createOrchestrator();

      orchestrator.handleMessage('!interrupt');

      expect(orchestrator.state).toBe('initial');
      expect(notifications).toHaveLength(0);
    });
  });

  // ----- Idle 状態 -----

  describe('Idle 状態', () => {
    it('PromptInput → 既存セッションで spawn → Busy', () => {
      const ctx = createOrchestrator();
      toIdle(ctx);
      const sessionId = ctx.session.sessionId;

      ctx.orchestrator.handleMessage('next prompt');

      expect(ctx.session.sessionId).toBe(sessionId);
      expect(ctx.mockProcess.spawnCalls[ctx.mockProcess.spawnCalls.length - 1]).toEqual({
        prompt: 'next prompt',
        sessionId,
        workDir: WORK_DIR,
      });
      expect(ctx.orchestrator.state).toBe('busy');
    });

    it('NewCommand → Session.reset() + 通知 → Initial', () => {
      const ctx = createOrchestrator();
      toIdle(ctx);

      ctx.orchestrator.handleMessage('!new');

      expect(ctx.session.sessionId).toBeNull();
      expect(ctx.orchestrator.state).toBe('initial');
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました',
      });
    });

    it('InterruptCommand → 何もしない, Idle 維持', () => {
      const ctx = createOrchestrator();
      toIdle(ctx);

      ctx.orchestrator.handleMessage('!interrupt');

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
      // spawn は追加されていない
      expect(ctx.mockProcess.spawnCalls).toHaveLength(1);
    });

    it('NewCommand → interruptReason="new", interrupt() → Interrupting', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.orchestrator.handleMessage('!new');

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });

    it('InterruptCommand → interruptReason="interrupt", interrupt() → Interrupting', () => {
      const ctx = createOrchestrator();
      toBusy(ctx);

      ctx.orchestrator.handleMessage('!interrupt');

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

      ctx.orchestrator.handleMessage('!new');

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.notifications).toHaveLength(0);
      expect(ctx.mockProcess.interruptCalls).toBe(1); // 追加の interrupt なし
    });

    it('InterruptCommand → 無視（既に中断処理中）', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'new');

      ctx.orchestrator.handleMessage('!interrupt');

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.notifications).toHaveLength(0);
      expect(ctx.mockProcess.interruptCalls).toBe(1); // 追加の interrupt なし
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
    it('Session.reset() + 通知 → Initial', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'new');

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');

      expect(ctx.orchestrator.state).toBe('initial');
      expect(ctx.session.sessionId).toBeNull();
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました',
      });
    });
  });

  // ----- 複合シナリオ -----

  describe('複合シナリオ', () => {
    it('完全ライフサイクル: Initial → Busy → Idle → Busy → Idle → Initial', () => {
      const ctx = createOrchestrator();

      // Initial → Busy
      ctx.orchestrator.handleMessage('first task');
      expect(ctx.orchestrator.state).toBe('busy');
      const firstSessionId = ctx.session.sessionId;

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

      // Idle → Initial（!new でリセット）
      ctx.orchestrator.handleMessage('!new');
      expect(ctx.orchestrator.state).toBe('initial');
      expect(ctx.session.sessionId).toBeNull();
    });

    it('Busy 中に !interrupt: Busy → Interrupting → Idle', () => {
      const ctx = createOrchestrator();

      ctx.orchestrator.handleMessage('long task');
      expect(ctx.orchestrator.state).toBe('busy');

      ctx.orchestrator.handleMessage('!interrupt');
      expect(ctx.orchestrator.state).toBe('interrupting');

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');
      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBeNull();
    });

    it('Busy 中に !new: Busy → Interrupting → Initial', () => {
      const ctx = createOrchestrator();

      ctx.orchestrator.handleMessage('long task');
      expect(ctx.orchestrator.state).toBe('busy');

      ctx.orchestrator.handleMessage('!new');
      expect(ctx.orchestrator.state).toBe('interrupting');

      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, '');
      expect(ctx.orchestrator.state).toBe('initial');
      expect(ctx.session.sessionId).toBeNull();
    });

    it('リセット後に新しい会話を開始できる', () => {
      const ctx = createOrchestrator();

      // 最初の会話
      ctx.orchestrator.handleMessage('task 1');
      const firstSessionId = ctx.session.sessionId;
      ctx.mockProcess.simulateEnd();
      ctx.orchestrator.onProcessEnd(0, 'result 1');

      // リセット
      ctx.orchestrator.handleMessage('!new');

      // 新しい会話
      ctx.orchestrator.handleMessage('task 2');
      expect(ctx.session.sessionId).not.toBe(firstSessionId);
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
      // spawn は最初の1回のみ
      expect(ctx.mockProcess.spawnCalls).toHaveLength(1);
    });

    it('Interrupting 中に全種類の入力を送っても状態は変わらない', () => {
      const ctx = createOrchestrator();
      toInterrupting(ctx, 'interrupt');

      ctx.orchestrator.handleMessage('prompt');
      ctx.orchestrator.handleMessage('!new');
      ctx.orchestrator.handleMessage('!interrupt');
      ctx.orchestrator.handleMessage('another prompt');

      expect(ctx.orchestrator.state).toBe('interrupting');
      // PromptInput のみ通知あり（2回）
      expect(ctx.notifications.filter((n) => n.type === 'info')).toHaveLength(2);
      // interrupt は追加呼出なし
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });
  });
});
