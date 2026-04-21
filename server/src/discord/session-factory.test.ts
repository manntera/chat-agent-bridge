import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../domain/session-manager.js';
import type { IUsageFetcher, ProgressEvent, Workspace } from '../domain/types.js';
import type { ITitleGenerator } from '../infrastructure/title-generator.js';
import type { ThreadSender } from '../infrastructure/discord-notifier.js';
import type { ThreadMappingStore } from '../infrastructure/thread-mapping-store.js';
import { createSessionFactory, createPersistMapping } from './session-factory.js';

// ClaudeProcess を最小限のモックに差し替える。
// constructor に渡された onProgress / onProcessEnd をインスタンスに保持することで
// テスト側から明示的にコールバックを発火できる。
vi.mock('../infrastructure/claude-process.js', () => {
  class MockClaudeProcess {
    isRunning = false;
    spawn = vi.fn();
    interrupt = vi.fn();
    constructor(
      public readonly claudePath: string,
      public readonly onProgress: (event: ProgressEvent) => void,
      public readonly onProcessEnd: (exitCode: number, output: string) => void,
    ) {}
  }
  return { ClaudeProcess: MockClaudeProcess };
});

interface MockClaudeProcessLike {
  claudePath: string;
  onProgress: (event: ProgressEvent) => void;
  onProcessEnd: (exitCode: number, output: string) => void;
}

function createMockThread(): ThreadSender {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockUsageFetcher(): IUsageFetcher {
  return {
    fetch: vi.fn().mockResolvedValue({
      fiveHour: null,
      sevenDay: null,
      sevenDaySonnet: null,
    }),
  };
}

function createMockTitleGenerator(): ITitleGenerator {
  return {
    generate: vi.fn().mockResolvedValue('生成されたタイトル'),
  };
}

/** 保留中の非同期マイクロタスク・Promise をまとめて消化する */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

const WORKSPACE: Workspace = { name: 'my-project', path: '/home/user/project' };

describe('createSessionFactory', () => {
  let sessionManager: SessionManager;
  let usageFetcher: IUsageFetcher;
  let thread: ThreadSender;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager = new SessionManager();
    usageFetcher = createMockUsageFetcher();
    thread = createMockThread();
  });

  it('依存を受け取り、SessionContext を返す関数を生成する', () => {
    const createSession = createSessionFactory({
      config: { claudePath: '/usr/bin/claude' },
      sessionManager,
      usageFetcher,
      titleGenerator: null,
    });

    const ctx = createSession('thread-1', thread, WORKSPACE);

    expect(ctx.threadId).toBe('thread-1');
    expect(ctx.session.workDir).toBe(WORKSPACE.path);
    expect(ctx.session.workspaceName).toBe(WORKSPACE.name);
    expect(ctx.session.sessionId).toBeNull();
    expect(ctx.orchestrator).toBeDefined();
    expect(ctx.claudeProcess).toBeDefined();
    expect(typeof ctx.setAuthorId).toBe('function');
  });

  it('生成された SessionContext を SessionManager に登録する', () => {
    const createSession = createSessionFactory({
      config: { claudePath: '/usr/bin/claude' },
      sessionManager,
      usageFetcher,
      titleGenerator: null,
    });

    const ctx = createSession('thread-42', thread, WORKSPACE);

    expect(sessionManager.get('thread-42')).toBe(ctx);
    expect(sessionManager.size()).toBe(1);
  });

  it('ClaudeProcess に config.claudePath が渡される', () => {
    const createSession = createSessionFactory({
      config: { claudePath: '/custom/path/to/claude' },
      sessionManager,
      usageFetcher,
      titleGenerator: null,
    });

    const ctx = createSession('thread-1', thread, WORKSPACE);
    const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;

    expect(mockProc.claudePath).toBe('/custom/path/to/claude');
  });

  it('titleGenerator が null でも例外なく動作する', () => {
    const createSession = createSessionFactory({
      config: { claudePath: '/usr/bin/claude' },
      sessionManager,
      usageFetcher,
      titleGenerator: null,
    });

    expect(() => createSession('thread-1', thread, WORKSPACE)).not.toThrow();
  });

  it('setAuthorId で設定したユーザーへのメンションが result 送信に付与される', async () => {
    const createSession = createSessionFactory({
      config: { claudePath: '/usr/bin/claude' },
      sessionManager,
      usageFetcher,
      titleGenerator: null,
    });

    const ctx = createSession('thread-1', thread, WORKSPACE);
    ctx.setAuthorId('user-123');
    ctx.session.ensure();

    // 正常系: onProcessEnd(0, output) → orchestrator が result 通知を発火 → notifier が pendingResult にバッファ
    // → orchestrator が usageFetcher.fetch() を経て usage 通知を発火 → notifier.flush() で mention 付きで送信
    const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;
    mockProc.onProcessEnd(0, '回答本文');

    await flushAsync();

    const sendMock = vi.mocked(thread.send);
    // result はプレーンテキスト送信、mention は先頭に付与される (discord-notifier.ts:140-148)
    const resultCall = sendMock.mock.calls.find(
      ([arg]) => typeof arg === 'string' && arg.includes('<@user-123>'),
    );
    expect(resultCall).toBeDefined();
    expect(resultCall?.[0]).toContain('回答本文');
  });

  describe('プロセス終了時のタイトル生成', () => {
    it('titleGenerator が指定され sessionId がある場合、生成されたタイトルでスレッド名を更新する', async () => {
      const titleGenerator = createMockTitleGenerator();
      vi.mocked(titleGenerator.generate).mockResolvedValue('テスト用タイトル');

      const createSession = createSessionFactory({
        config: { claudePath: '/usr/bin/claude' },
        sessionManager,
        usageFetcher,
        titleGenerator,
      });

      const ctx = createSession('thread-1', thread, WORKSPACE);
      ctx.session.ensure();
      const sessionId = ctx.session.sessionId!;

      const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;
      mockProc.onProcessEnd(0, 'output');

      await flushAsync();

      expect(titleGenerator.generate).toHaveBeenCalledWith(sessionId, WORKSPACE.path);
      expect(thread.setName).toHaveBeenCalledWith('テスト用タイトル');
    });

    it('titleGenerator が null の場合はタイトル更新を試みない', async () => {
      const createSession = createSessionFactory({
        config: { claudePath: '/usr/bin/claude' },
        sessionManager,
        usageFetcher,
        titleGenerator: null,
      });

      const ctx = createSession('thread-1', thread, WORKSPACE);
      ctx.session.ensure();

      const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;
      mockProc.onProcessEnd(0, 'output');

      await flushAsync();
      expect(thread.setName).not.toHaveBeenCalled();
    });

    it('titleGenerator が指定されても session.sessionId が null なら呼ばない', async () => {
      const titleGenerator = createMockTitleGenerator();
      const createSession = createSessionFactory({
        config: { claudePath: '/usr/bin/claude' },
        sessionManager,
        usageFetcher,
        titleGenerator,
      });

      const ctx = createSession('thread-1', thread, WORKSPACE);
      // session.ensure() を呼ばない → sessionId は null のまま

      const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;
      mockProc.onProcessEnd(0, 'output');

      await flushAsync();
      expect(titleGenerator.generate).not.toHaveBeenCalled();
      expect(thread.setName).not.toHaveBeenCalled();
    });

    it('titleGenerator.generate が null を返した場合はスレッド名を更新しない', async () => {
      const titleGenerator = createMockTitleGenerator();
      vi.mocked(titleGenerator.generate).mockResolvedValueOnce(null);

      const createSession = createSessionFactory({
        config: { claudePath: '/usr/bin/claude' },
        sessionManager,
        usageFetcher,
        titleGenerator,
      });

      const ctx = createSession('thread-1', thread, WORKSPACE);
      ctx.session.ensure();

      const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;
      mockProc.onProcessEnd(0, 'output');

      await flushAsync();
      expect(thread.setName).not.toHaveBeenCalled();
    });

    it('titleGenerator.generate が reject してもエラーを伝播させない', async () => {
      const titleGenerator = createMockTitleGenerator();
      vi.mocked(titleGenerator.generate).mockRejectedValueOnce(new Error('API error'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const createSession = createSessionFactory({
        config: { claudePath: '/usr/bin/claude' },
        sessionManager,
        usageFetcher,
        titleGenerator,
      });

      const ctx = createSession('thread-1', thread, WORKSPACE);
      ctx.session.ensure();

      const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;
      expect(() => mockProc.onProcessEnd(0, 'output')).not.toThrow();

      await flushAsync();
      expect(thread.setName).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('thread.setName が reject してもエラーを伝播させない', async () => {
      const titleGenerator = createMockTitleGenerator();
      vi.mocked(thread.setName).mockRejectedValueOnce(new Error('Discord error'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const createSession = createSessionFactory({
        config: { claudePath: '/usr/bin/claude' },
        sessionManager,
        usageFetcher,
        titleGenerator,
      });

      const ctx = createSession('thread-1', thread, WORKSPACE);
      ctx.session.ensure();

      const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;
      mockProc.onProcessEnd(0, 'output');

      await flushAsync();
      // 例外が伝播しなければ成功
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Orchestrator / Notifier との配線', () => {
    it('ClaudeProcess の onProgress コールバックが notifier に届き、started で typing が始まる', () => {
      const createSession = createSessionFactory({
        config: { claudePath: '/usr/bin/claude' },
        sessionManager,
        usageFetcher,
        titleGenerator: null,
      });

      const ctx = createSession('thread-1', thread, WORKSPACE);
      const mockProc = ctx.claudeProcess as unknown as MockClaudeProcessLike;

      mockProc.onProgress({ kind: 'started' });

      expect(thread.sendTyping).toHaveBeenCalled();
    });
  });
});

describe('createPersistMapping', () => {
  it('ThreadMappingStore.set に正しい引数を渡す', async () => {
    const mockStore = {
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadMappingStore;

    const persistMapping = createPersistMapping(mockStore);
    await persistMapping('thread-1', 'session-abc', {
      name: 'my-ws',
      path: '/home/user/ws',
    });

    expect(mockStore.set).toHaveBeenCalledWith('thread-1', {
      sessionId: 'session-abc',
      workDir: '/home/user/ws',
      workspaceName: 'my-ws',
    });
  });

  it('ThreadMappingStore.set の Promise を返す', async () => {
    const mockStore = {
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadMappingStore;

    const persistMapping = createPersistMapping(mockStore);
    const result = persistMapping('t', 's', { name: 'w', path: '/w' });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('複数回の呼び出しをそれぞれ別の set 呼び出しとして処理する', async () => {
    const mockStore = {
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadMappingStore;

    const persistMapping = createPersistMapping(mockStore);
    await persistMapping('t1', 's1', { name: 'w1', path: '/w1' });
    await persistMapping('t2', 's2', { name: 'w2', path: '/w2' });

    expect(mockStore.set).toHaveBeenCalledTimes(2);
    expect(mockStore.set).toHaveBeenNthCalledWith(1, 't1', {
      sessionId: 's1',
      workDir: '/w1',
      workspaceName: 'w1',
    });
    expect(mockStore.set).toHaveBeenNthCalledWith(2, 't2', {
      sessionId: 's2',
      workDir: '/w2',
      workspaceName: 'w2',
    });
  });
});
