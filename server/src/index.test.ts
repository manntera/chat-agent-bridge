import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Session } from './domain/session.js';
import { AccessControl } from './domain/access-control.js';
import { Orchestrator } from './domain/orchestrator.js';
import { SessionManager } from './domain/session-manager.js';
import type { ProgressEvent } from './domain/types.js';
import { ClaudeProcess } from './infrastructure/claude-process.js';
import {
  createNotifier,
  type SendOptions,
  type ThreadSender,
} from './infrastructure/discord-notifier.js';
import { createMessageHandler, type DiscordMessage } from './app/message-handler.js';

// --- モック用ヘルパー ---

class MockChildProcess extends EventEmitter {
  readonly stdin = null;
  readonly stderr = null;
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
  type: 'text' | 'embed';
  content: string | SendOptions;
}

// --- 統合テスト用セットアップ ---

const CONFIG = {
  allowedUserIds: ['user1'],
  channelId: 'channel1',
  workDir: '/home/user/projects/test',
  claudePath: '/usr/bin/claude',
};

const THREAD_ID = 'thread-1';

function createIntegrationContext() {
  const sent: SentItem[] = [];
  const mockThread: ThreadSender = {
    send: vi.fn((content: string | SendOptions) => {
      const type = typeof content === 'string' ? 'text' : 'embed';
      sent.push({ type, content });
      return Promise.resolve();
    }),
    setName: vi.fn(() => Promise.resolve()),
  };

  const spawnedProcesses: MockChildProcess[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mockSpawnFn = vi.fn((_cmd: string, _args: string[], _opts: SpawnOptions) => {
    const proc = new MockChildProcess();
    spawnedProcesses.push(proc);
    return proc as unknown as ChildProcess;
  });

  // ドメインオブジェクト
  const accessControl = new AccessControl({
    allowedUserIds: CONFIG.allowedUserIds,
    channelId: CONFIG.channelId,
  });
  const sessionManager = new SessionManager();

  // セッションを作成してスレッドに紐づける
  const session = new Session(CONFIG.workDir, 'test-project');

  let onProgress: (event: ProgressEvent) => void = () => {};
  let onProcessEnd: (exitCode: number, output: string) => void = () => {};

  const claudeProcess = new ClaudeProcess(
    CONFIG.claudePath,
    (event) => onProgress(event),
    (exitCode, output) => onProcessEnd(exitCode, output),
    mockSpawnFn,
  );

  const notifier = createNotifier(mockThread);
  const orchestrator = new Orchestrator(session, claudeProcess, notifier.notify);

  onProgress = (event) => orchestrator.onProgress(event);
  onProcessEnd = (exitCode, output) => orchestrator.onProcessEnd(exitCode, output);

  session.ensure();
  sessionManager.register(THREAD_ID, {
    orchestrator,
    session,
    claudeProcess,
    threadId: THREAD_ID,
    setAuthorId: (authorId) => notifier.setAuthorId(authorId),
  });

  // App 層
  const rawHandleMessage = createMessageHandler(accessControl, sessionManager);

  const handleMessage = (msg: DiscordMessage) => {
    rawHandleMessage(msg);
  };

  return {
    handleMessage,
    orchestrator,
    session,
    sent,
    mockSpawnFn,
    spawnedProcesses,
    sessionManager,
  };
}

function validMessage(content: string): DiscordMessage {
  return {
    authorBot: false,
    authorId: 'user1',
    channelId: 'channel1',
    threadId: THREAD_ID,
    content,
  };
}

function latestProcess(ctx: ReturnType<typeof createIntegrationContext>): MockChildProcess {
  return ctx.spawnedProcesses[ctx.spawnedProcesses.length - 1];
}

function sendStdout(proc: MockChildProcess, line: string) {
  proc.stdout.emit('data', Buffer.from(line + '\n'));
}

function simulateClose(proc: MockChildProcess, exitCode = 0) {
  proc.emit('close', exitCode);
}

function getTextMessages(sent: SentItem[]): string[] {
  return sent.filter((s) => s.type === 'text').map((s) => s.content as string);
}

function getEmbeds(sent: SentItem[]): SendOptions[] {
  return sent.filter((s) => s.type === 'embed').map((s) => s.content as SendOptions);
}

// =================================================================
// テスト本体
// =================================================================

describe('統合テスト: コンポーネント配線', () => {
  describe('メッセージ → ClaudeCode → 結果通知', () => {
    it('スレッド内のメッセージが ClaudeCode に送信され、結果が Embed で通知される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('テストを書いて'));

      // ClaudeProcess が起動されている
      expect(ctx.mockSpawnFn).toHaveBeenCalledOnce();
      const [cmd, args] = ctx.mockSpawnFn.mock.calls[0];
      expect(cmd).toBe(CONFIG.claudePath);
      expect(args).toContain('テストを書いて');

      // 結果を返す
      const proc = latestProcess(ctx);
      sendStdout(proc, JSON.stringify({ type: 'result', result: '完了しました' }));
      simulateClose(proc, 0);

      // result は usage 到着後に Embed で送信される
      const embeds = getEmbeds(ctx.sent);
      expect(embeds).toHaveLength(1);
      expect(embeds[0].embeds[0].description).toBe('完了しました');
      expect(embeds[0].embeds[0].color).toBe(0x00c853);
    });

    it('連続したメッセージが同一セッションで処理される', () => {
      const ctx = createIntegrationContext();

      // 1つ目のメッセージ
      ctx.handleMessage(validMessage('最初のタスク'));
      const proc1 = latestProcess(ctx);
      sendStdout(proc1, JSON.stringify({ type: 'result', result: '結果1' }));
      simulateClose(proc1, 0);

      // 2つ目のメッセージ（同一セッション）
      ctx.handleMessage(validMessage('次のタスク'));
      const proc2 = latestProcess(ctx);

      // 1回目は --session-id、2回目は --resume で同じ ID が使われている
      const args1 = ctx.mockSpawnFn.mock.calls[0][1];
      const args2 = ctx.mockSpawnFn.mock.calls[1][1];
      const sessionId1 = args1[args1.indexOf('--session-id') + 1];
      const sessionId2 = args2[args2.indexOf('--resume') + 1];
      expect(args1).toContain('--session-id');
      expect(args2).toContain('--resume');
      expect(sessionId1).toBe(sessionId2);

      sendStdout(proc2, JSON.stringify({ type: 'result', result: '結果2' }));
      simulateClose(proc2, 0);

      const embeds = getEmbeds(ctx.sent);
      expect(embeds).toHaveLength(2);
      expect(embeds[0].embeds[0].description).toBe('結果1');
      expect(embeds[1].embeds[0].description).toBe('結果2');
    });
  });

  describe('途中経過のリアルタイム通知', () => {
    it('ツール使用イベントがプレーンテキストで通知される', async () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('ファイルを編集して'));
      const proc = latestProcess(ctx);

      sendStdout(
        proc,
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-6',
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Edit',
                input: { file_path: 'src/index.ts' },
              },
            ],
          },
        }),
      );

      const textMessages = getTextMessages(ctx.sent);
      expect(textMessages).toContain('🔧 Edit: src/index.ts');
    });

    it('拡張思考イベントがプレーンテキストで通知される', async () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('分析して'));
      const proc = latestProcess(ctx);

      sendStdout(
        proc,
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-6',
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'コードを分析中...', signature: 'sig' }],
          },
        }),
      );

      const textMessages = getTextMessages(ctx.sent);
      expect(textMessages).toContain('💭 コードを分析中...');
    });
  });

  describe('アクセス制御', () => {
    it('未許可ユーザーのメッセージは無視される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage({
        authorBot: false,
        authorId: 'unknown-user',
        channelId: 'channel1',
        threadId: THREAD_ID,
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
      expect(ctx.sent).toHaveLength(0);
    });

    it('Bot のメッセージは無視される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage({
        authorBot: true,
        authorId: 'user1',
        channelId: 'channel1',
        threadId: THREAD_ID,
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
      expect(ctx.sent).toHaveLength(0);
    });

    it('スレッド外のメッセージは無視される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage({
        authorBot: false,
        authorId: 'user1',
        channelId: 'channel1',
        threadId: null,
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
      expect(ctx.sent).toHaveLength(0);
    });
  });

  describe('コマンド処理', () => {
    it('処理中に入力すると「処理中です」とスレッドに通知される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('長い処理'));
      ctx.handleMessage(validMessage('もう一つ'));

      const textMessages = getTextMessages(ctx.sent);
      expect(textMessages).toContain('処理中です');
    });

    it('/cc interrupt でプロセスが中断される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('長い処理'));
      const proc = latestProcess(ctx);
      const killSpy = vi.spyOn(proc, 'kill');

      ctx.orchestrator.handleCommand({ type: 'interrupt' });

      expect(killSpy).toHaveBeenCalledWith('SIGINT');

      // プロセス終了をシミュレート
      simulateClose(proc, 0);

      const textMessages = getTextMessages(ctx.sent);
      expect(textMessages).toContain('中断しました');
    });
  });

  describe('エラーハンドリング', () => {
    it('ClaudeCode が異常終了した場合、エラーが Embed で通知される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('hello'));
      const proc = latestProcess(ctx);

      simulateClose(proc, 1);

      // error は usage 到着後に Embed で送信される
      const embeds = getEmbeds(ctx.sent);
      expect(embeds).toHaveLength(1);
      expect(embeds[0].embeds[0].color).toBe(0xff1744);
      expect(embeds[0].embeds[0].title).toContain('エラー');
    });
  });

  describe('並列セッション', () => {
    it('複数スレッドで独立したセッションが並列に動作する', () => {
      const ctx = createIntegrationContext();

      // 2つ目のセッションを作成
      const sent2: SentItem[] = [];
      const mockThread2: ThreadSender = {
        send: vi.fn((content: string | SendOptions) => {
          sent2.push({ type: typeof content === 'string' ? 'text' : 'embed', content });
          return Promise.resolve();
        }),
        setName: vi.fn(() => Promise.resolve()),
      };

      const session2 = new Session(CONFIG.workDir, 'test-project');
      let onProgress2: (event: ProgressEvent) => void = () => {};
      let onProcessEnd2: (exitCode: number, output: string) => void = () => {};
      const claudeProcess2 = new ClaudeProcess(
        CONFIG.claudePath,
        (event) => onProgress2(event),
        (exitCode, output) => onProcessEnd2(exitCode, output),
        ctx.mockSpawnFn,
      );
      const notifier2 = createNotifier(mockThread2);
      const orchestrator2 = new Orchestrator(session2, claudeProcess2, notifier2.notify);
      onProgress2 = (event) => orchestrator2.onProgress(event);
      onProcessEnd2 = (exitCode, output) => orchestrator2.onProcessEnd(exitCode, output);
      session2.ensure();

      ctx.sessionManager.register('thread-2', {
        orchestrator: orchestrator2,
        session: session2,
        claudeProcess: claudeProcess2,
        threadId: 'thread-2',
        setAuthorId: (authorId) => notifier2.setAuthorId(authorId),
      });

      // スレッド1にメッセージ送信
      ctx.handleMessage(validMessage('タスクA'));
      expect(ctx.mockSpawnFn).toHaveBeenCalledTimes(1);

      // スレッド2にメッセージ送信（スレッド1がbusy中でもOK）
      ctx.handleMessage({
        authorBot: false,
        authorId: 'user1',
        channelId: 'channel1',
        threadId: 'thread-2',
        content: 'タスクB',
      });
      expect(ctx.mockSpawnFn).toHaveBeenCalledTimes(2);

      // 両方とも別のプロンプトで起動されている
      expect(ctx.mockSpawnFn.mock.calls[0][1]).toContain('タスクA');
      expect(ctx.mockSpawnFn.mock.calls[1][1]).toContain('タスクB');
    });
  });
});
