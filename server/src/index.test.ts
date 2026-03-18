import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Session } from './domain/session.js';
import { AccessControl } from './domain/access-control.js';
import { Orchestrator } from './domain/orchestrator.js';
import type { ProgressEvent } from './domain/types.js';
import { ClaudeProcess } from './infrastructure/claude-process.js';
import { createNotifier } from './infrastructure/discord-notifier.js';
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

// --- 統合テスト用セットアップ ---

const CONFIG = {
  allowedUserIds: ['user1'],
  channelId: 'channel1',
  workDir: '/home/user/projects/test',
  claudePath: '/usr/bin/claude',
};

function createIntegrationContext() {
  const sentMessages: string[] = [];
  const threadMessages: string[] = [];
  const mockThread = {
    send: vi.fn((content: string) => {
      threadMessages.push(content);
      return Promise.resolve();
    }),
  };
  const sender = {
    send: vi.fn((content: string) => {
      sentMessages.push(content);
      return Promise.resolve();
    }),
  };

  const spawnedProcesses: MockChildProcess[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mockSpawnFn = vi.fn((_cmd: string, _args: string[], _opts: SpawnOptions) => {
    const proc = new MockChildProcess();
    spawnedProcesses.push(proc);
    return proc as unknown as ChildProcess;
  });

  // ドメインオブジェクト
  const session = new Session(CONFIG.workDir);
  const accessControl = new AccessControl({
    allowedUserIds: CONFIG.allowedUserIds,
    channelId: CONFIG.channelId,
  });

  // インフラオブジェクト + 循環依存の解決
  const discordNotifier = createNotifier(sender);

  let onProgress: (event: ProgressEvent) => void = () => {};
  let onProcessEnd: (exitCode: number, output: string) => void = () => {};

  const claudeProcess = new ClaudeProcess(
    CONFIG.claudePath,
    (event) => onProgress(event),
    (exitCode, output) => onProcessEnd(exitCode, output),
    mockSpawnFn,
  );

  const orchestrator = new Orchestrator(session, claudeProcess, discordNotifier);

  onProgress = (event) => orchestrator.onProgress(event);
  onProcessEnd = (exitCode, output) => orchestrator.onProcessEnd(exitCode, output);

  // App 層
  const rawHandleMessage = createMessageHandler(accessControl, orchestrator);

  // index.ts と同様、メッセージ処理前に setThreadOrigin を呼ぶ
  const handleMessage = (msg: DiscordMessage) => {
    if (!msg.authorBot) {
      const state = orchestrator.state;
      if (state === 'initial' || state === 'idle') {
        discordNotifier.setThreadOrigin({
          startThread: vi.fn(() => Promise.resolve(mockThread)),
        });
      }
    }
    rawHandleMessage(msg);
  };

  return { handleMessage, orchestrator, sender, sentMessages, threadMessages, mockSpawnFn, spawnedProcesses };
}

function validMessage(content: string): DiscordMessage {
  return { authorBot: false, authorId: 'user1', channelId: 'channel1', content };
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

// =================================================================
// テスト本体
// =================================================================

describe('統合テスト: コンポーネント配線', () => {
  describe('メッセージ → ClaudeCode → 結果通知', () => {
    it('許可されたメッセージが ClaudeCode に送信され、結果が通知される', () => {
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

      expect(ctx.sentMessages).toContain('完了しました');
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

      expect(ctx.sentMessages).toContain('結果1');
      expect(ctx.sentMessages).toContain('結果2');
    });
  });

  describe('途中経過のリアルタイム通知', () => {
    it('ツール使用イベントがスレッドに通知される', async () => {
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
              { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'src/index.ts' } },
            ],
          },
        }),
      );

      await vi.waitFor(() => {
        expect(ctx.threadMessages).toContain('🔧 Edit: src/index.ts');
      });
    });

    it('拡張思考イベントがスレッドに通知される', async () => {
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

      await vi.waitFor(() => {
        expect(ctx.threadMessages).toContain('💭 コードを分析中...');
      });
    });
  });

  describe('アクセス制御', () => {
    it('未許可ユーザーのメッセージは無視される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage({
        authorBot: false,
        authorId: 'unknown-user',
        channelId: 'channel1',
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
      expect(ctx.sentMessages).toHaveLength(0);
    });

    it('Bot のメッセージは無視される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage({
        authorBot: true,
        authorId: 'user1',
        channelId: 'channel1',
        content: 'hello',
      });

      expect(ctx.mockSpawnFn).not.toHaveBeenCalled();
      expect(ctx.sentMessages).toHaveLength(0);
    });
  });

  describe('コマンド処理', () => {
    it('処理中に入力すると「処理中です」と通知される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('長い処理'));
      ctx.handleMessage(validMessage('もう一つ'));

      expect(ctx.sentMessages).toContain('処理中です');
    });

    it('!interrupt でプロセスが中断される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('長い処理'));
      const proc = latestProcess(ctx);
      const killSpy = vi.spyOn(proc, 'kill');

      ctx.handleMessage(validMessage('!interrupt'));

      expect(killSpy).toHaveBeenCalledWith('SIGINT');

      // プロセス終了をシミュレート
      simulateClose(proc, 0);

      expect(ctx.sentMessages).toContain('中断しました');
    });

    it('!new でセッションがリセットされ、新しいセッションで再開できる', () => {
      const ctx = createIntegrationContext();

      // セッションを開始
      ctx.handleMessage(validMessage('最初のタスク'));
      const proc1 = latestProcess(ctx);
      sendStdout(proc1, JSON.stringify({ type: 'result', result: '結果' }));
      simulateClose(proc1, 0);

      // !new でリセット
      ctx.handleMessage(validMessage('!new'));
      expect(ctx.sentMessages).toContain('新しいセッションを開始しました');

      // 新しいセッションでメッセージを送信
      ctx.handleMessage(validMessage('新しいタスク'));
      const proc2 = latestProcess(ctx);

      // 異なる session-id が使われている
      const sessionId1 =
        ctx.mockSpawnFn.mock.calls[0][1][
          ctx.mockSpawnFn.mock.calls[0][1].indexOf('--session-id') + 1
        ];
      const sessionId2 =
        ctx.mockSpawnFn.mock.calls[1][1][
          ctx.mockSpawnFn.mock.calls[1][1].indexOf('--session-id') + 1
        ];
      expect(sessionId1).not.toBe(sessionId2);

      sendStdout(proc2, JSON.stringify({ type: 'result', result: '新しい結果' }));
      simulateClose(proc2, 0);
    });
  });

  describe('エラーハンドリング', () => {
    it('ClaudeCode が異常終了した場合、エラーが通知される', () => {
      const ctx = createIntegrationContext();

      ctx.handleMessage(validMessage('hello'));
      const proc = latestProcess(ctx);

      simulateClose(proc, 1);

      expect(ctx.sentMessages.some((msg) => msg.includes('エラー'))).toBe(true);
    });
  });
});
