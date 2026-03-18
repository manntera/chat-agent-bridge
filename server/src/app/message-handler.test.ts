import { describe, it, expect } from 'vitest';
import { AccessControl } from '../domain/access-control.js';
import { Orchestrator } from '../domain/orchestrator.js';
import { Session } from '../domain/session.js';
import type { IClaudeProcess, Notification } from '../domain/types.js';
import { createMessageHandler } from './message-handler.js';

// --- テスト用モック ---

class MockClaudeProcess implements IClaudeProcess {
  isRunning = false;
  spawnCalls: Array<{ prompt: string; sessionId: string; workDir: string; resume: boolean }> = [];
  interruptCalls = 0;

  spawn(prompt: string, sessionId: string, workDir: string, resume: boolean): void {
    this.isRunning = true;
    this.spawnCalls.push({ prompt, sessionId, workDir, resume });
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
  const session = new Session(WORK_DIR);
  const mockProcess = new MockClaudeProcess();
  const notifications: Notification[] = [];
  const notify = (n: Notification) => notifications.push(n);
  const orchestrator = new Orchestrator(session, mockProcess, notify);
  const handler = createMessageHandler(accessControl, orchestrator);
  return { handler, orchestrator, mockProcess, notifications };
}

function validMessage(content: string) {
  return {
    authorBot: false,
    authorId: ALLOWED_USER_ID,
    channelId: CHANNEL_ID,
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
      const { handler, mockProcess, notifications } = createTestContext();

      handler({
        authorBot: true,
        authorId: ALLOWED_USER_ID,
        channelId: CHANNEL_ID,
        content: 'hello',
      });

      expect(mockProcess.spawnCalls).toHaveLength(0);
      expect(notifications).toHaveLength(0);
    });

    it('許可されていないユーザーのメッセージは無視される', () => {
      const { handler, mockProcess, notifications } = createTestContext();

      handler({
        authorBot: false,
        authorId: 'unknown-user',
        channelId: CHANNEL_ID,
        content: 'hello',
      });

      expect(mockProcess.spawnCalls).toHaveLength(0);
      expect(notifications).toHaveLength(0);
    });

    it('異なるチャンネルのメッセージは無視される', () => {
      const { handler, mockProcess, notifications } = createTestContext();

      handler({
        authorBot: false,
        authorId: ALLOWED_USER_ID,
        channelId: 'wrong-channel',
        content: 'hello',
      });

      expect(mockProcess.spawnCalls).toHaveLength(0);
      expect(notifications).toHaveLength(0);
    });
  });

  // ----- Orchestrator への委譲 -----

  describe('Orchestrator への委譲', () => {
    it('許可されたメッセージは Orchestrator.handleMessage に渡される', () => {
      const { handler, mockProcess } = createTestContext();

      handler(validMessage('!new'));
      handler(validMessage('hello'));

      expect(mockProcess.spawnCalls).toHaveLength(1);
      expect(mockProcess.spawnCalls[0].prompt).toBe('hello');
    });

    it('コマンドメッセージも正しく Orchestrator に委譲される', () => {
      const { handler, mockProcess } = createTestContext();

      handler(validMessage('!new'));
      handler(validMessage('some task'));
      expect(mockProcess.spawnCalls).toHaveLength(1);

      handler(validMessage('!interrupt'));

      expect(mockProcess.interruptCalls).toBe(1);
    });

    it('複数メッセージが順番に処理される', () => {
      const { handler, orchestrator, mockProcess } = createTestContext();

      handler(validMessage('!new'));

      // 1つ目のメッセージ → Busy
      handler(validMessage('first task'));
      expect(mockProcess.spawnCalls).toHaveLength(1);

      // プロセス終了 → Idle
      mockProcess.simulateEnd();
      orchestrator.onProcessEnd(0, 'result');

      // 2つ目のメッセージ → 再び Busy
      handler(validMessage('second task'));
      expect(mockProcess.spawnCalls).toHaveLength(2);
      expect(mockProcess.spawnCalls[1].prompt).toBe('second task');
    });
  });
});
