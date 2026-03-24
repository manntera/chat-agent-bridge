import { describe, it, expect } from 'vitest';
import { AccessControl } from '../domain/access-control.js';
import { Orchestrator } from '../domain/orchestrator.js';
import { Session } from '../domain/session.js';
import { SessionManager } from '../domain/session-manager.js';
import type { IClaudeProcess, Notification, SessionOptions } from '../domain/types.js';
import { createMessageHandler, type DiscordMessage } from './message-handler.js';

// --- テスト用モック ---

class MockClaudeProcess implements IClaudeProcess {
  isRunning = false;
  spawnCalls: Array<{ prompt: string }> = [];
  interruptCalls = 0;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  spawn(prompt: string, _sid: string, _wd: string, _r: boolean, _o?: SessionOptions): void {
    this.isRunning = true;
    this.spawnCalls.push({ prompt });
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
    allowedUserIds: [ALLOWED_USER_ID, 'user2'],
    channelId: CHANNEL_ID,
  });
  const sessionManager = new SessionManager();
  const handler = createMessageHandler(accessControl, sessionManager);

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
    return { orchestrator, session, mockProcess: mockProcess, notifications };
  }

  return { handler, sessionManager, registerSession };
}

function validThreadMessage(threadId: string, content: string): DiscordMessage {
  return {
    authorBot: false,
    authorId: ALLOWED_USER_ID,
    channelId: CHANNEL_ID,
    threadId,
    content,
  };
}

// =================================================================
// テスト本体
// =================================================================

describe('createMessageHandler', () => {
  // ----- フィルタリング -----

  describe('メッセージのフィルタリング', () => {
    it('Bot のメッセージは無視される', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      handler({
        authorBot: true,
        authorId: ALLOWED_USER_ID,
        channelId: CHANNEL_ID,
        threadId: 'thread-1',
        content: 'hello',
      });

      expect(mockProcess.spawnCalls).toHaveLength(0);
    });

    it('許可されていないユーザーのメッセージは無視される', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      handler({
        authorBot: false,
        authorId: 'unknown-user',
        channelId: CHANNEL_ID,
        threadId: 'thread-1',
        content: 'hello',
      });

      expect(mockProcess.spawnCalls).toHaveLength(0);
    });

    it('異なるチャンネルのメッセージは無視される', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      handler({
        authorBot: false,
        authorId: ALLOWED_USER_ID,
        channelId: 'wrong-channel',
        threadId: 'thread-1',
        content: 'hello',
      });

      expect(mockProcess.spawnCalls).toHaveLength(0);
    });

    it('スレッド外のメッセージは無視される', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      handler({
        authorBot: false,
        authorId: ALLOWED_USER_ID,
        channelId: CHANNEL_ID,
        threadId: null,
        content: 'hello',
      });

      expect(mockProcess.spawnCalls).toHaveLength(0);
    });

    it('未登録スレッドのメッセージは無視される', () => {
      const { handler } = createTestContext();

      handler(validThreadMessage('unknown-thread', 'hello'));
      // エラーにならないことを確認
    });
  });

  // ----- プロンプトとしての処理 -----

  describe('プロンプトとしての処理', () => {
    it('登録済みスレッドのメッセージが正しいセッションにルーティングされる', () => {
      const { handler, registerSession } = createTestContext();
      const { mockProcess } = registerSession('thread-1');

      handler(validThreadMessage('thread-1', 'テスト追加して'));

      expect(mockProcess.spawnCalls).toHaveLength(1);
      expect(mockProcess.spawnCalls[0].prompt).toBe('テスト追加して');
    });

    it('複数スレッドへのメッセージが正しいセッションにルーティングされる', () => {
      const { handler, registerSession } = createTestContext();
      const s1 = registerSession('thread-1');
      const s2 = registerSession('thread-2');

      handler(validThreadMessage('thread-1', 'task A'));
      handler(validThreadMessage('thread-2', 'task B'));

      expect(s1.mockProcess.spawnCalls[0].prompt).toBe('task A');
      expect(s2.mockProcess.spawnCalls[0].prompt).toBe('task B');
    });

    it('同一スレッドで複数メッセージが順番に処理される', () => {
      const { handler, registerSession } = createTestContext();
      const { orchestrator, mockProcess } = registerSession('thread-1');

      handler(validThreadMessage('thread-1', 'first task'));
      expect(mockProcess.spawnCalls).toHaveLength(1);

      mockProcess.simulateEnd();
      orchestrator.onProcessEnd(0, 'result');

      handler(validThreadMessage('thread-1', 'second task'));
      expect(mockProcess.spawnCalls).toHaveLength(2);
      expect(mockProcess.spawnCalls[1].prompt).toBe('second task');
    });
  });
});
