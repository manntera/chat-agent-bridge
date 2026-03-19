import { describe, it, expect } from 'vitest';
import { AccessControl } from '../domain/access-control.js';
import { Orchestrator } from '../domain/orchestrator.js';
import { Session } from '../domain/session.js';
import type { IClaudeProcess, Notification, SessionOptions } from '../domain/types.js';
import { createInteractionHandler, type InteractionContext } from './interaction-handler.js';

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
const ALLOWED_USER_ID = 'user1';
const CHANNEL_ID = 'channel1';

function createTestContext() {
  const accessControl = new AccessControl({
    allowedUserIds: [ALLOWED_USER_ID],
    channelId: CHANNEL_ID,
  });
  const session = new Session(WORK_DIR);
  const mockProcess = new MockClaudeProcess();
  const notifications: Notification[] = [];
  const notify = (n: Notification) => notifications.push(n);
  const orchestrator = new Orchestrator(session, mockProcess, notify);
  const handler = createInteractionHandler(accessControl, orchestrator);
  return { handler, orchestrator, session, mockProcess, notifications };
}

function validInteraction(
  subcommand: string,
  options: Partial<InteractionContext> = {},
): InteractionContext {
  return {
    authorBot: false,
    authorId: ALLOWED_USER_ID,
    channelId: CHANNEL_ID,
    subcommand,
    ...options,
  };
}

// =================================================================
// テスト本体
// =================================================================

describe('createInteractionHandler', () => {
  describe('アクセス制御', () => {
    it('未許可ユーザーのインタラクションは無視される', () => {
      const { handler, notifications } = createTestContext();

      handler({ authorBot: false, authorId: 'unknown', channelId: CHANNEL_ID, subcommand: 'new' });

      expect(notifications).toHaveLength(0);
    });

    it('異なるチャンネルのインタラクションは無視される', () => {
      const { handler, notifications } = createTestContext();

      handler({
        authorBot: false,
        authorId: ALLOWED_USER_ID,
        channelId: 'wrong',
        subcommand: 'new',
      });

      expect(notifications).toHaveLength(0);
    });
  });

  describe('/cc new', () => {
    it('セッションを作成して Idle に遷移する', () => {
      const { handler, orchestrator, session } = createTestContext();

      handler(validInteraction('new'));

      expect(orchestrator.state).toBe('idle');
      expect(session.sessionId).not.toBeNull();
    });

    it('オプションなしで通知メッセージが送信される', () => {
      const { handler, notifications } = createTestContext();

      handler(validInteraction('new'));

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました',
      });
    });

    it('model と effort オプションが Session に保存される', () => {
      const { handler, session } = createTestContext();

      handler(validInteraction('new', { model: 'sonnet', effort: 'max' }));

      expect(session.options).toEqual({ model: 'sonnet', effort: 'max' });
    });

    it('オプション付きの通知メッセージが送信される', () => {
      const { handler, notifications } = createTestContext();

      handler(validInteraction('new', { model: 'opus', effort: 'high' }));

      expect(notifications[0]).toEqual({
        type: 'info',
        message: '新しいセッションを開始しました (model: opus, effort: high)',
      });
    });

    it('不正な effort は無視される', () => {
      const { handler, session } = createTestContext();

      handler(validInteraction('new', { effort: 'invalid' }));

      expect(session.options).toEqual({});
    });

    it('Busy 中は中断処理を開始する', () => {
      const ctx = createTestContext();
      // Idle → Busy
      ctx.handler(validInteraction('new'));
      ctx.orchestrator.handleMessage('some prompt');
      ctx.notifications.length = 0;

      ctx.handler(validInteraction('new', { model: 'sonnet' }));

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });
  });

  describe('/cc interrupt', () => {
    it('Busy 中に中断処理を開始する', () => {
      const ctx = createTestContext();
      ctx.handler(validInteraction('new'));
      ctx.orchestrator.handleMessage('task');
      ctx.notifications.length = 0;

      ctx.handler(validInteraction('interrupt'));

      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(ctx.mockProcess.interruptCalls).toBe(1);
    });

    it('Busy でない場合は何もしない', () => {
      const { handler, orchestrator, notifications } = createTestContext();

      handler(validInteraction('interrupt'));

      expect(orchestrator.state).toBe('initial');
      expect(notifications).toHaveLength(0);
    });
  });

  describe('/cc resume', () => {
    it('InteractionHandler では処理されない（index.ts で直接ハンドリング）', () => {
      const { handler, orchestrator, notifications } = createTestContext();

      handler(validInteraction('resume'));

      expect(orchestrator.state).toBe('initial');
      expect(notifications).toHaveLength(0);
    });
  });

  describe('未知のサブコマンド', () => {
    it('無視される', () => {
      const { handler, notifications } = createTestContext();

      handler(validInteraction('unknown'));

      expect(notifications).toHaveLength(0);
    });
  });
});
