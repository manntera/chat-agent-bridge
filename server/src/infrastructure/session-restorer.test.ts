import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionContext } from '../domain/session-manager.js';
import type { ThreadSender } from './discord-notifier.js';
import { SessionRestorer, type SessionRestorerDeps } from './session-restorer.js';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

import { stat } from 'node:fs/promises';
const mockStat = vi.mocked(stat);

function createMockThread(): ThreadSender {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSessionContext(): SessionContext {
  return {
    orchestrator: {} as never,
    session: {
      restore: vi.fn(),
      sessionId: 'mock-session-id',
    } as never,
    claudeProcess: {} as never,
    threadId: 'thread-1',
    setAuthorId: vi.fn(),
  };
}

describe('SessionRestorer', () => {
  let deps: SessionRestorerDeps;
  let restorer: SessionRestorer;
  let mockThread: ThreadSender;

  beforeEach(() => {
    vi.clearAllMocks();
    mockThread = createMockThread();
    deps = {
      threadMappingStore: {
        get: vi.fn().mockReturnValue(null),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      sessionManager: { remove: vi.fn() },
      createSession: vi.fn(),
      log: vi.fn(),
    };
    restorer = new SessionRestorer(deps);
  });

  it('マッピングが存在しない場合は null を返す', async () => {
    const result = await restorer.tryRestore('thread-1', mockThread);

    expect(result).toBeNull();
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('workDir が存在しない場合はエラーメッセージを送信し null を返す', async () => {
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/nonexistent/path',
      workspaceName: 'my-project',
    });
    mockStat.mockRejectedValue(new Error('ENOENT'));

    const result = await restorer.tryRestore('thread-1', mockThread);

    expect(result).toBeNull();
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.stringContaining('ワークディレクトリが見つかりません'),
    );
    expect(deps.threadMappingStore.remove).toHaveBeenCalledWith('thread-1');
  });

  it('workDir がファイルの場合はエラーメッセージを送信し null を返す', async () => {
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/some/file',
      workspaceName: 'my-project',
    });
    mockStat.mockResolvedValue({ isDirectory: () => false } as never);

    const result = await restorer.tryRestore('thread-1', mockThread);

    expect(result).toBeNull();
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.stringContaining('ワークディレクトリが見つかりません'),
    );
    expect(deps.threadMappingStore.remove).toHaveBeenCalledWith('thread-1');
  });

  it('正常にセッションを復元できる', async () => {
    const mockCtx = createMockSessionContext();
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
    mockStat.mockResolvedValue({ isDirectory: () => true } as never);
    vi.mocked(deps.createSession).mockReturnValue(mockCtx);

    const result = await restorer.tryRestore('thread-1', mockThread);

    expect(result).toBe(mockCtx);
    expect(mockCtx.session.restore).toHaveBeenCalledWith('session-abc');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('セッション復元: my-project'));
  });

  it('session.restore() が失敗した場合はクリーンアップしてエラーメッセージを返す', async () => {
    const mockCtx = createMockSessionContext();
    vi.mocked(mockCtx.session.restore as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('restore failed');
    });
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
    mockStat.mockResolvedValue({ isDirectory: () => true } as never);
    vi.mocked(deps.createSession).mockReturnValue(mockCtx);

    const result = await restorer.tryRestore('thread-1', mockThread);

    expect(result).toBeNull();
    expect(deps.sessionManager.remove).toHaveBeenCalledWith('thread-1');
    expect(deps.threadMappingStore.remove).toHaveBeenCalledWith('thread-1');
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.stringContaining('セッションの復元に失敗しました'),
    );
  });

  it('createSession() が失敗した場合もクリーンアップしてエラーメッセージを返す', async () => {
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
    mockStat.mockResolvedValue({ isDirectory: () => true } as never);
    vi.mocked(deps.createSession).mockImplementation(() => {
      throw new Error('createSession failed');
    });

    const result = await restorer.tryRestore('thread-1', mockThread);

    expect(result).toBeNull();
    expect(deps.sessionManager.remove).toHaveBeenCalledWith('thread-1');
    expect(deps.threadMappingStore.remove).toHaveBeenCalledWith('thread-1');
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.stringContaining('セッションの復元に失敗しました'),
    );
  });

  it('並行復元時は最初の結果を共有し createSession は1回だけ呼ばれる', async () => {
    const mockCtx = createMockSessionContext();
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });

    let resolveStat!: () => void;
    mockStat.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          resolveStat = () => resolve({ isDirectory: () => true } as never);
        }),
    );
    vi.mocked(deps.createSession).mockReturnValue(mockCtx);

    const promise1 = restorer.tryRestore('thread-1', mockThread);
    const promise2 = restorer.tryRestore('thread-1', mockThread);

    resolveStat();

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toBe(result2);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });

  it('threadMappingStore.remove() が失敗しても復元失敗が正常に処理される', async () => {
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/nonexistent',
      workspaceName: 'my-project',
    });
    mockStat.mockRejectedValue(new Error('ENOENT'));
    vi.mocked(deps.threadMappingStore.remove).mockRejectedValue(new Error('disk full'));

    const result = await restorer.tryRestore('thread-1', mockThread);

    expect(result).toBeNull();
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.stringContaining('ワークディレクトリが見つかりません'),
    );
  });

  it('workDir 復元失敗時に thread.send() が拒否されても正常に null を返す', async () => {
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/nonexistent',
      workspaceName: 'my-project',
    });
    mockStat.mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mockThread.send).mockRejectedValue(new Error('Discord error'));

    const result = await restorer.tryRestore('thread-1', mockThread);
    expect(result).toBeNull();
  });

  it('セッション復元失敗時に remove/send 両方が拒否されても正常に null を返す', async () => {
    vi.mocked(deps.threadMappingStore.get).mockReturnValue({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
    mockStat.mockResolvedValue({ isDirectory: () => true } as never);
    vi.mocked(deps.createSession).mockImplementation(() => {
      throw new Error('createSession failed');
    });
    vi.mocked(deps.threadMappingStore.remove).mockRejectedValue(new Error('disk full'));
    vi.mocked(mockThread.send).mockRejectedValue(new Error('Discord error'));

    const result = await restorer.tryRestore('thread-1', mockThread);
    expect(result).toBeNull();
  });
});
