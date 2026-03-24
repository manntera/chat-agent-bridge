/**
 * 統合テスト
 *
 * 外部依存（Discord API, Claude CLI, Gemini API, Anthropic API）のみモックし、
 * 内部モジュール間の連携をリアルに動かして検証する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { AccessControl } from '../domain/access-control.js';
import { Orchestrator } from '../domain/orchestrator.js';
import { Session } from '../domain/session.js';
import { SessionManager } from '../domain/session-manager.js';
import { createMessageHandler } from '../app/message-handler.js';
import { ClaudeProcess } from '../infrastructure/claude-process.js';
import { createNotifier } from '../infrastructure/discord-notifier.js';
import type { SendOptions, ThreadSender } from '../infrastructure/discord-notifier.js';
import type { IUsageFetcher, UsageInfo } from '../domain/types.js';

// ============================================================
// モック用ヘルパー
// ============================================================

class MockChildProcess extends EventEmitter {
  readonly stdin = null;
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  pid = 1234;
  killed = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  kill(signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

interface SentItem {
  content: string | SendOptions;
}

function createIntegrationContext() {
  // --- モック: spawnFn (Claude CLI) ---
  const spawnedProcesses: MockChildProcess[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mockSpawnFn = vi.fn((..._args: [string, string[], SpawnOptions]) => {
    const proc = new MockChildProcess();
    spawnedProcesses.push(proc);
    return proc as unknown as ChildProcess;
  });

  // --- モック: ThreadSender (Discord) ---
  const sent: SentItem[] = [];
  const thread: ThreadSender = {
    send: vi.fn((content) => {
      sent.push({ content });
      return Promise.resolve();
    }),
    setName: vi.fn(() => Promise.resolve()),
  };

  // --- モック: UsageFetcher (Anthropic API) ---
  const mockUsage: UsageInfo = {
    fiveHour: { utilization: 45, resetsAt: '2026-01-01T00:00:00Z' },
    sevenDay: null,
    sevenDaySonnet: null,
  };
  const usageFetcher: IUsageFetcher = {
    fetch: vi.fn(() => Promise.resolve(mockUsage)),
  };

  // --- リアル: ドメイン+インフラ ---
  const WORK_DIR = '/test/workspace';
  const session = new Session(WORK_DIR, 'test-project');
  const notifier = createNotifier(thread);

  const claudeProcess = new ClaudeProcess(
    '/usr/bin/claude',
    (event) => orchestrator.onProgress(event),
    (exitCode, output) => orchestrator.onProcessEnd(exitCode, output),
    mockSpawnFn,
  );

  const orchestrator = new Orchestrator(
    session,
    claudeProcess,
    (n) => notifier.notify(n),
    usageFetcher,
  );

  // --- リアル: App層 ---
  const accessControl = new AccessControl({
    allowedUserIds: ['user-1'],
    channelId: 'channel-1',
  });
  const sessionManager = new SessionManager();
  const THREAD_ID = 'thread-1';
  sessionManager.register(THREAD_ID, {
    orchestrator,
    session,
    claudeProcess,
    threadId: THREAD_ID,
    setAuthorId: (id) => notifier.setAuthorId(id),
  });
  const handleMessage = createMessageHandler(accessControl, sessionManager);

  return {
    spawnedProcesses,
    mockSpawnFn,
    sent,
    thread,
    usageFetcher,
    session,
    orchestrator,
    claudeProcess,
    sessionManager,
    handleMessage,
    notifier,
    accessControl,
    THREAD_ID,
    WORK_DIR,
  };
}

type Ctx = ReturnType<typeof createIntegrationContext>;

function latestProcess(ctx: Ctx): MockChildProcess {
  return ctx.spawnedProcesses[ctx.spawnedProcesses.length - 1];
}

function sendStdout(proc: MockChildProcess, line: string): void {
  proc.stdout.emit('data', Buffer.from(line + '\n'));
}

function sendStderr(proc: MockChildProcess, text: string): void {
  proc.stderr.emit('data', Buffer.from(text));
}

function simulateClose(proc: MockChildProcess, exitCode = 0): void {
  proc.emit('close', exitCode);
}

/** Claude の stream-json 形式で result を返す */
function sendResult(proc: MockChildProcess, text: string): void {
  sendStdout(proc, JSON.stringify({ type: 'result', result: text }));
}

/** Claude の stream-json 形式で tool_use を返す */
function sendToolUse(proc: MockChildProcess, toolName: string, target: string): void {
  sendStdout(
    proc,
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: toolName, input: { file_path: target } },
        ],
      },
    }),
  );
}

function sendUserMessage(ctx: Ctx, text: string): void {
  ctx.handleMessage({
    authorBot: false,
    authorId: 'user-1',
    channelId: 'channel-1',
    threadId: ctx.THREAD_ID,
    content: text,
  });
}

/** usage の非同期通知が flush されるのを待つ */
async function waitForUsage(): Promise<void> {
  await vi.waitFor(() => {}, { timeout: 100 });
}

// ============================================================
// テスト本体
// ============================================================

describe('統合テスト', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----- フロー 1 -----

  describe('/cc new → メッセージ → Claude実行 → 結果通知', () => {
    it('一連のフローが正常に動作する', async () => {
      const ctx = createIntegrationContext();

      // 1. /cc new でセッション作成
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBeNull();
      expect(ctx.sent).toHaveLength(1);
      expect(ctx.sent[0].content as string).toMatch(/新しいセッションを開始しました/);

      // 2. メッセージ送信 → Claude spawn
      sendUserMessage(ctx, 'テストを書いて');
      expect(ctx.orchestrator.state).toBe('busy');
      expect(ctx.mockSpawnFn).toHaveBeenCalledTimes(1);
      // started 通知
      expect(ctx.sent).toHaveLength(2);
      expect(ctx.sent[1].content).toBe('📨 受信しました。処理を開始します...');

      // 3. tool_use 進捗
      const proc = latestProcess(ctx);
      sendToolUse(proc, 'Edit', 'src/app.ts');
      expect(ctx.sent).toHaveLength(3);
      expect(ctx.sent[2].content).toBe('🔧 Edit: src/app.ts');

      // 4. 結果 + 終了
      sendResult(proc, '完了しました');
      simulateClose(proc, 0);
      await waitForUsage();

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.usageFetcher.fetch).toHaveBeenCalledTimes(1);

      // result + usage → Embed で送信される
      const lastSent = ctx.sent[ctx.sent.length - 1].content as SendOptions;
      expect(lastSent.embeds).toHaveLength(1);
      expect(lastSent.embeds[0].description).toBe('完了しました');
      expect(lastSent.embeds[0].color).toBe(0x00c853);
    });

    it('新セッションでは resume=false で spawn される', () => {
      const ctx = createIntegrationContext();
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      sendUserMessage(ctx, 'hello');

      const args = ctx.mockSpawnFn.mock.calls[0][1] as string[];
      expect(args).toContain('--session-id');
      expect(args).not.toContain('--resume');
    });

    it('2回目以降のメッセージは resume=true で spawn される', async () => {
      const ctx = createIntegrationContext();
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });

      // 1回目
      sendUserMessage(ctx, 'first');
      const proc1 = latestProcess(ctx);
      sendResult(proc1, 'done');
      simulateClose(proc1, 0);
      await waitForUsage();

      // 2回目
      sendUserMessage(ctx, 'second');
      const args = ctx.mockSpawnFn.mock.calls[1][1] as string[];
      expect(args).toContain('--resume');
    });
  });

  // ----- フロー 2 -----

  describe('/cc interrupt → 中断処理', () => {
    it('実行中に interrupt すると中断される', async () => {
      const ctx = createIntegrationContext();
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      const sessionIdBefore = ctx.session.sessionId;

      sendUserMessage(ctx, 'タスク実行');
      expect(ctx.orchestrator.state).toBe('busy');

      // interrupt
      ctx.orchestrator.handleCommand({ type: 'interrupt' });
      expect(ctx.orchestrator.state).toBe('interrupting');
      expect(latestProcess(ctx).killed).toBe(true);

      // プロセス終了
      simulateClose(latestProcess(ctx), 0);
      await waitForUsage();

      expect(ctx.orchestrator.state).toBe('idle');
      // セッションは維持される
      expect(ctx.session.sessionId).toBe(sessionIdBefore);
      // 中断通知
      const interruptMsg = ctx.sent.find(
        (s) => typeof s.content === 'string' && s.content === '中断しました',
      );
      expect(interruptMsg).toBeDefined();
    });
  });

  // ----- フロー 3 -----

  describe('実行中に /cc new → セッション切り替え', () => {
    it('実行中に new すると旧セッションが中断され新セッションが作成される', async () => {
      const ctx = createIntegrationContext();
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      const oldSessionId = ctx.session.sessionId;

      sendUserMessage(ctx, '旧タスク');
      expect(ctx.orchestrator.state).toBe('busy');

      // 実行中に /cc new
      ctx.orchestrator.handleCommand({ type: 'new', options: { model: 'sonnet' } });
      expect(ctx.orchestrator.state).toBe('interrupting');

      // プロセス終了
      simulateClose(latestProcess(ctx), 0);
      await waitForUsage();

      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).not.toBe(oldSessionId);
      expect(ctx.session.options.model).toBe('sonnet');

      // 新セッション通知（最初のものとは別に2つ目がある）
      const newSessionMsgs = ctx.sent.filter(
        (s) =>
          typeof s.content === 'string' && s.content.includes('新しいセッションを開始しました'),
      );
      expect(newSessionMsgs.length).toBeGreaterThanOrEqual(2);

      // 新セッションでメッセージ送信
      sendUserMessage(ctx, '新タスク');
      expect(ctx.mockSpawnFn).toHaveBeenCalledTimes(2);
      const args = ctx.mockSpawnFn.mock.calls[1][1] as string[];
      expect(args).toContain('--session-id');
      expect(args).not.toContain('--resume');
    });
  });

  // ----- フロー 4 -----

  describe('/cc resume → メッセージ → 結果通知', () => {
    it('既存セッションを resume して結果を受け取る', async () => {
      const ctx = createIntegrationContext();

      ctx.orchestrator.handleCommand({ type: 'resume', sessionId: 'existing-session-id-12345' });
      expect(ctx.orchestrator.state).toBe('idle');
      expect(ctx.session.sessionId).toBe('existing-session-id-12345');

      const resumeMsg = ctx.sent.find(
        (s) => typeof s.content === 'string' && s.content.includes('セッションを再開しました'),
      );
      expect(resumeMsg).toBeDefined();
      expect(resumeMsg!.content as string).toContain('existing');

      // メッセージ送信 → resume=true で spawn
      sendUserMessage(ctx, '続きをお願い');
      expect(ctx.orchestrator.state).toBe('busy');
      const args = ctx.mockSpawnFn.mock.calls[0][1] as string[];
      expect(args).toContain('--resume');
      expect(args).toContain('existing-session-id-12345');

      // 結果通知
      const proc = latestProcess(ctx);
      sendResult(proc, '続きの結果');
      simulateClose(proc, 0);
      await waitForUsage();

      expect(ctx.orchestrator.state).toBe('idle');
      const lastSent = ctx.sent[ctx.sent.length - 1].content as SendOptions;
      expect(lastSent.embeds[0].description).toBe('続きの結果');
    });
  });

  // ----- フロー 5 -----

  describe('エラー時のフロー（Claude が非0で終了）', () => {
    it('非0終了時にエラーEmbed が送信され、その後リカバリできる', async () => {
      const ctx = createIntegrationContext();
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      sendUserMessage(ctx, 'タスク');

      const proc = latestProcess(ctx);
      sendStderr(proc, 'Error: rate limit exceeded');
      simulateClose(proc, 1);
      await waitForUsage();

      expect(ctx.orchestrator.state).toBe('idle');

      // エラー Embed
      const errorSent = ctx.sent.find((s) => {
        if (typeof s.content === 'string') return false;
        const opts = s.content as SendOptions;
        return opts.embeds?.[0]?.color === 0xff1744;
      });
      expect(errorSent).toBeDefined();
      const errorEmbed = (errorSent!.content as SendOptions).embeds[0];
      expect(errorEmbed.title).toBe('エラー (exit 1)');
      expect(errorEmbed.description).toBe('Error: rate limit exceeded');

      // リカバリ: 再度メッセージ送信
      sendUserMessage(ctx, '再試行');
      expect(ctx.orchestrator.state).toBe('busy');
      expect(ctx.mockSpawnFn).toHaveBeenCalledTimes(2);
      const args = ctx.mockSpawnFn.mock.calls[1][1] as string[];
      expect(args).toContain('--resume');
    });
  });

  // ----- フロー 6 -----

  describe('AccessControl による拒否', () => {
    it('許可されていないユーザーのメッセージは無視される', () => {
      const ctx = createIntegrationContext();
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      ctx.sent.length = 0;

      ctx.handleMessage({
        authorBot: false,
        authorId: 'unauthorized-user',
        channelId: 'channel-1',
        threadId: ctx.THREAD_ID,
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
      expect(ctx.sent).toHaveLength(0);
    });

    it('Bot からのメッセージは無視される', () => {
      const ctx = createIntegrationContext();
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      ctx.sent.length = 0;

      ctx.handleMessage({
        authorBot: true,
        authorId: 'user-1',
        channelId: 'channel-1',
        threadId: ctx.THREAD_ID,
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
      expect(ctx.sent).toHaveLength(0);
    });
  });

  // ----- フロー 7 -----

  describe('未登録スレッドからのメッセージ', () => {
    it('セッション未登録のスレッドからのメッセージは無視される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage({
        authorBot: false,
        authorId: 'user-1',
        channelId: 'channel-1',
        threadId: 'unknown-thread',
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
    });
  });

  // ----- フロー 8 -----

  describe('メンション付き通知', () => {
    it('result 通知に質問者のメンションが付く', async () => {
      const ctx = createIntegrationContext();
      ctx.notifier.setAuthorId('user-1');
      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      sendUserMessage(ctx, 'hello');

      const proc = latestProcess(ctx);
      sendResult(proc, '回答です');
      simulateClose(proc, 0);
      await waitForUsage();

      // Embed 送信時に content にメンションが含まれる
      const embedSent = ctx.sent.find((s) => {
        if (typeof s.content === 'string') return false;
        const opts = s.content as SendOptions;
        return opts.content === '<@user-1>';
      });
      expect(embedSent).toBeDefined();
    });
  });

  // ----- フロー 9 -----

  describe('UsageFetcher がエラーの場合', () => {
    it('usage 取得失敗でも結果は正常に通知される', async () => {
      const ctx = createIntegrationContext();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      (ctx.usageFetcher.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API error'),
      );

      ctx.orchestrator.handleCommand({ type: 'new', options: {} });
      sendUserMessage(ctx, 'hello');

      const proc = latestProcess(ctx);
      sendResult(proc, '結果です');
      simulateClose(proc, 0);
      await waitForUsage();

      expect(ctx.orchestrator.state).toBe('idle');
      // result Embed は送信される
      const embedSent = ctx.sent.find((s) => {
        if (typeof s.content === 'string') return false;
        const opts = s.content as SendOptions;
        return opts.embeds?.[0]?.description === '結果です';
      });
      expect(embedSent).toBeDefined();
    });
  });
});
