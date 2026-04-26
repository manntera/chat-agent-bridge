import { describe, it, expect } from 'vitest';
import { AccessControl } from '../domain/access-control.js';
import { Orchestrator } from '../domain/orchestrator.js';
import { Session } from '../domain/session.js';
import { SessionManager } from '../domain/session-manager.js';
import type { IClaudeProcess, Notification, SessionOptions } from '../domain/types.js';
import {
  createInteractionHandler,
  toCommand,
  type InteractionContext,
} from './interaction-handler.js';

// --- テスト用モック ---

class MockClaudeProcess implements IClaudeProcess {
  isRunning = false;
  interruptCalls = 0;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  spawn(_p: string, _s: string, _w: string, _r: boolean, _o?: SessionOptions): void {
    this.isRunning = true;
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
  const sessionManager = new SessionManager();
  const handler = createInteractionHandler(accessControl, sessionManager);

  function registerSession(threadId: string) {
    const session = new Session(WORK_DIR, 'test-project');
    const mockProcess = new MockClaudeProcess();
    const notifications: Notification[] = [];
    const notify = (n: Notification) => notifications.push(n);
    const orchestrator = new Orchestrator(session, mockProcess, notify);
    session.ensure();
    const ctx = {
      orchestrator,
      session,
      claudeProcess: mockProcess,
      threadId,
      setAuthorId: () => {},
    };
    sessionManager.register(threadId, ctx);
    return { orchestrator, session, mockProcess, notifications };
  }

  return { handler, sessionManager, registerSession };
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
    threadId: null,
    ...options,
  };
}

// =================================================================
// テスト本体
// =================================================================

describe('toCommand', () => {
  it('new → Command { type: "new" }', () => {
    const cmd = toCommand(validInteraction('new', { model: 'opus', effort: 'max' }));
    expect(cmd).toEqual({ type: 'new', options: { model: 'opus', effort: 'max' } });
  });

  it('interrupt → Command { type: "interrupt" }', () => {
    const cmd = toCommand(validInteraction('interrupt'));
    expect(cmd).toEqual({ type: 'interrupt' });
  });

  it('resume → null（index.ts で処理）', () => {
    const cmd = toCommand(validInteraction('resume'));
    expect(cmd).toBeNull();
  });

  it('不正な effort は無視される', () => {
    const cmd = toCommand(validInteraction('new', { effort: 'invalid' }));
    expect(cmd).toEqual({ type: 'new', options: {} });
  });

  it('model のみ指定時は model のみ含まれる', () => {
    const cmd = toCommand(validInteraction('new', { model: 'sonnet' }));
    expect(cmd).toEqual({ type: 'new', options: { model: 'sonnet' } });
  });

  it('effort のみ指定時は effort のみ含まれる', () => {
    const cmd = toCommand(validInteraction('new', { effort: 'high' }));
    expect(cmd).toEqual({ type: 'new', options: { effort: 'high' } });
  });

  it('low effort が受理される', () => {
    const cmd = toCommand(validInteraction('new', { effort: 'low' }));
    expect(cmd).toEqual({ type: 'new', options: { effort: 'low' } });
  });

  it('xhigh effort が受理される', () => {
    const cmd = toCommand(validInteraction('new', { effort: 'xhigh' }));
    expect(cmd).toEqual({ type: 'new', options: { effort: 'xhigh' } });
  });

  it('report → null（index.ts で処理）', () => {
    const cmd = toCommand(validInteraction('report'));
    expect(cmd).toBeNull();
  });

  it('オプションなしの new → 空の options', () => {
    const cmd = toCommand(validInteraction('new'));
    expect(cmd).toEqual({ type: 'new', options: {} });
  });
});

describe('createInteractionHandler', () => {
  describe('アクセス制御', () => {
    it('未許可ユーザーのインタラクションは無視される', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      handler({
        authorBot: false,
        authorId: 'unknown',
        channelId: CHANNEL_ID,
        subcommand: 'interrupt',
        threadId: 'thread-1',
      });

      expect(mockProcess.interruptCalls).toBe(0);
    });
  });

  describe('/cc interrupt', () => {
    it('スレッド内で実行するとそのセッションを中断する', () => {
      const { handler, registerSession } = createTestContext();
      const { orchestrator, mockProcess } = registerSession('thread-1');

      // Busy にする
      orchestrator.handleMessage('task');

      handler(validInteraction('interrupt', { threadId: 'thread-1' }));

      expect(mockProcess.interruptCalls).toBe(1);
    });

    it('スレッド外で実行すると何もしない', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      handler(validInteraction('interrupt', { threadId: null }));

      expect(mockProcess.interruptCalls).toBe(0);
    });

    it('未登録スレッドで実行すると何もしない', () => {
      const { handler } = createTestContext();

      handler(validInteraction('interrupt', { threadId: 'unknown-thread' }));
      // エラーにならない
    });
  });

  describe('/cc resume', () => {
    it('resume コマンドは handler で何もしない', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      // resume は toCommand で null を返す → handler は早期リターン
      handler(validInteraction('resume', { threadId: 'thread-1' }));

      expect(mockProcess.interruptCalls).toBe(0);
    });
  });

  describe('/cc new', () => {
    it('InteractionHandler では処理されない（index.ts で処理）', () => {
      const { handler, sessionManager } = createTestContext();

      handler(validInteraction('new', { threadId: null }));

      expect(sessionManager.size()).toBe(0);
    });

    it('new コマンドは interrupt ロジックに入らない', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      // new コマンドは handler 内で interrupt しない
      handler(validInteraction('new', { threadId: 'thread-1' }));

      expect(mockProcess.interruptCalls).toBe(0);
    });
  });
});
