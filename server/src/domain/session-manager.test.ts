import { describe, it, expect } from 'vitest';
import { SessionManager, type SessionContext } from './session-manager.js';
import { Orchestrator } from './orchestrator.js';
import { Session } from './session.js';
import type { IClaudeProcess, Notification, SessionOptions } from './types.js';

// --- テスト用モック ---

class MockClaudeProcess implements IClaudeProcess {
  isRunning = false;
  spawnCalls: Array<{ prompt: string; sessionId: string }> = [];

  spawn(
    prompt: string,
    sessionId: string,
    workDir: string,
    resume: boolean,
    options?: SessionOptions,
  ): void {
    this.isRunning = true;
    this.spawnCalls.push({ prompt, sessionId });
    void workDir;
    void resume;
    void options;
  }

  interrupt(): void {}
}

const WORK_DIR = '/home/user/projects/test';

function createSessionContext(threadId: string): SessionContext {
  const session = new Session(WORK_DIR, 'test-project');
  const claudeProcess = new MockClaudeProcess();
  const notifications: Notification[] = [];
  const notify = (n: Notification) => notifications.push(n);
  const orchestrator = new Orchestrator(session, claudeProcess, notify);
  return { orchestrator, session, claudeProcess, threadId, setAuthorId: () => {} };
}

// =================================================================
// テスト本体
// =================================================================

describe('SessionManager', () => {
  it('登録したセッションを threadId で取得できる', () => {
    const manager = new SessionManager();
    const ctx = createSessionContext('thread-1');

    manager.register('thread-1', ctx);

    expect(manager.get('thread-1')).toBe(ctx);
  });

  it('未登録の threadId では null を返す', () => {
    const manager = new SessionManager();

    expect(manager.get('unknown')).toBeNull();
  });

  it('セッションを削除できる', () => {
    const manager = new SessionManager();
    const ctx = createSessionContext('thread-1');

    manager.register('thread-1', ctx);
    manager.remove('thread-1');

    expect(manager.get('thread-1')).toBeNull();
  });

  it('複数のセッションを独立して管理できる', () => {
    const manager = new SessionManager();
    const ctx1 = createSessionContext('thread-1');
    const ctx2 = createSessionContext('thread-2');

    manager.register('thread-1', ctx1);
    manager.register('thread-2', ctx2);

    expect(manager.get('thread-1')).toBe(ctx1);
    expect(manager.get('thread-2')).toBe(ctx2);
    expect(manager.size()).toBe(2);
  });

  it('all() で全セッションを取得できる', () => {
    const manager = new SessionManager();
    const ctx1 = createSessionContext('thread-1');
    const ctx2 = createSessionContext('thread-2');

    manager.register('thread-1', ctx1);
    manager.register('thread-2', ctx2);

    const all = manager.all();
    expect(all).toHaveLength(2);
    expect(all).toContain(ctx1);
    expect(all).toContain(ctx2);
  });

  it('size() でセッション数を取得できる', () => {
    const manager = new SessionManager();

    expect(manager.size()).toBe(0);

    manager.register('thread-1', createSessionContext('thread-1'));
    expect(manager.size()).toBe(1);

    manager.register('thread-2', createSessionContext('thread-2'));
    expect(manager.size()).toBe(2);

    manager.remove('thread-1');
    expect(manager.size()).toBe(1);
  });
});
