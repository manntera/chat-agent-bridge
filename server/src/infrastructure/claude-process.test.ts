import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { ProgressEvent } from '../domain/types.js';
import { ClaudeProcess } from './claude-process.js';

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

function createTestContext() {
  const progressEvents: ProgressEvent[] = [];
  const endCalls: Array<{ exitCode: number; output: string }> = [];
  const spawnedProcesses: MockChildProcess[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mockSpawnFn = vi.fn((...args: [string, string[], SpawnOptions]) => {
    const proc = new MockChildProcess();
    spawnedProcesses.push(proc);
    return proc as unknown as ChildProcess;
  });

  const claudeProcess = new ClaudeProcess(
    '/usr/bin/claude',
    (event) => progressEvents.push(event),
    (exitCode, output) => endCalls.push({ exitCode, output }),
    mockSpawnFn,
  );

  return { claudeProcess, mockSpawnFn, progressEvents, endCalls, spawnedProcesses };
}

/** 最新の MockChildProcess を取得 */
function latestProcess(ctx: ReturnType<typeof createTestContext>): MockChildProcess {
  return ctx.spawnedProcesses[ctx.spawnedProcesses.length - 1];
}

/** stdout に stream-json 行を送信 */
function sendStdout(proc: MockChildProcess, line: string) {
  proc.stdout.emit('data', Buffer.from(line + '\n'));
}

/** プロセスの正常終了をシミュレート */
function simulateClose(proc: MockChildProcess, exitCode = 0) {
  proc.emit('close', exitCode);
}

// =================================================================
// テスト本体
// =================================================================

describe('ClaudeProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ----- spawn -----

  describe('spawn', () => {
    it('claude CLI を正しい引数で起動する', () => {
      const ctx = createTestContext();

      ctx.claudeProcess.spawn('hello', 'session-123', '/home/user/project');

      expect(ctx.mockSpawnFn).toHaveBeenCalledOnce();
      const [cmd, args, opts] = ctx.mockSpawnFn.mock.calls[0];
      expect(cmd).toBe('/usr/bin/claude');
      expect(args).toContain('-p');
      expect(args).toContain('hello');
      expect(args).toContain('--session-id');
      expect(args).toContain('session-123');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(opts.cwd).toBe('/home/user/project');
    });

    it('spawn 後 isRunning が true になる', () => {
      const ctx = createTestContext();
      expect(ctx.claudeProcess.isRunning).toBe(false);

      ctx.claudeProcess.spawn('hello', 'session-123', '/work');

      expect(ctx.claudeProcess.isRunning).toBe(true);
    });

    it('既にプロセス実行中の場合、二重起動しない', () => {
      const ctx = createTestContext();

      ctx.claudeProcess.spawn('first', 'session-1', '/work');
      ctx.claudeProcess.spawn('second', 'session-2', '/work');

      expect(ctx.mockSpawnFn).toHaveBeenCalledOnce();
    });
  });

  // ----- stdout パース -----

  describe('stdout パース', () => {
    it('ツール使用イベントを onProgress に通知する', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      sendStdout(
        proc,
        JSON.stringify({
          type: 'assistant',
          subtype: 'tool_use',
          tool: { name: 'Edit', input: { file_path: 'src/index.ts' } },
        }),
      );

      expect(ctx.progressEvents).toHaveLength(1);
      expect(ctx.progressEvents[0]).toEqual({
        kind: 'tool_use',
        toolName: 'Edit',
        target: 'src/index.ts',
      });
    });

    it('拡張思考イベントを onProgress に通知する', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      sendStdout(
        proc,
        JSON.stringify({
          type: 'assistant',
          subtype: 'thinking',
          content: [{ type: 'thinking', thinking: '分析中...' }],
        }),
      );

      expect(ctx.progressEvents).toHaveLength(1);
      expect(ctx.progressEvents[0]).toEqual({ kind: 'thinking', text: '分析中...' });
    });

    it('result イベントのテキストをプロセス終了時に渡す', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      sendStdout(proc, JSON.stringify({ type: 'result', result: '回答テキスト' }));
      simulateClose(proc, 0);

      expect(ctx.endCalls).toHaveLength(1);
      expect(ctx.endCalls[0]).toEqual({ exitCode: 0, output: '回答テキスト' });
    });

    it('system イベントは無視される', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      sendStdout(proc, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }));

      expect(ctx.progressEvents).toHaveLength(0);
    });

    it('不完全な行はバッファリングされ、次のチャンクと結合される', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      const fullLine = JSON.stringify({
        type: 'assistant',
        subtype: 'tool_use',
        tool: { name: 'Read', input: { file_path: 'file.ts' } },
      });

      // 行を途中で分割して送信
      const splitAt = Math.floor(fullLine.length / 2);
      proc.stdout.emit('data', Buffer.from(fullLine.slice(0, splitAt)));
      expect(ctx.progressEvents).toHaveLength(0);

      proc.stdout.emit('data', Buffer.from(fullLine.slice(splitAt) + '\n'));
      expect(ctx.progressEvents).toHaveLength(1);
      expect(ctx.progressEvents[0]).toEqual({
        kind: 'tool_use',
        toolName: 'Read',
        target: 'file.ts',
      });
    });
  });

  // ----- プロセス終了 -----

  describe('プロセス終了', () => {
    it('正常終了(exitCode=0) → onProcessEnd に結果を通知', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      sendStdout(proc, JSON.stringify({ type: 'result', result: 'done' }));
      simulateClose(proc, 0);

      expect(ctx.endCalls).toHaveLength(1);
      expect(ctx.endCalls[0]).toEqual({ exitCode: 0, output: 'done' });
      expect(ctx.claudeProcess.isRunning).toBe(false);
    });

    it('異常終了(exitCode≠0) → onProcessEnd にエラーを通知', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      simulateClose(proc, 1);

      expect(ctx.endCalls).toHaveLength(1);
      expect(ctx.endCalls[0].exitCode).toBe(1);
      expect(ctx.claudeProcess.isRunning).toBe(false);
    });

    it('result イベントがない場合は空文字列を出力として渡す', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      simulateClose(proc, 0);

      expect(ctx.endCalls[0]).toEqual({ exitCode: 0, output: '' });
    });

    it('プロセス終了後に再度 spawn できる', () => {
      const ctx = createTestContext();

      ctx.claudeProcess.spawn('first', 'session-1', '/work');
      simulateClose(latestProcess(ctx), 0);
      expect(ctx.claudeProcess.isRunning).toBe(false);

      ctx.claudeProcess.spawn('second', 'session-2', '/work');
      expect(ctx.claudeProcess.isRunning).toBe(true);
      expect(ctx.mockSpawnFn).toHaveBeenCalledTimes(2);
    });
  });

  // ----- error イベント（起動失敗） -----

  describe('error イベント（起動失敗）', () => {
    it('spawn 起動失敗 → onProcessEnd にエラーを通知', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);

      proc.emit('error', new Error('spawn ENOENT'));

      expect(ctx.endCalls).toHaveLength(1);
      expect(ctx.endCalls[0].exitCode).toBe(1);
      expect(ctx.endCalls[0].output).toContain('spawn ENOENT');
      expect(ctx.claudeProcess.isRunning).toBe(false);
    });
  });

  // ----- interrupt -----

  describe('interrupt', () => {
    it('SIGINT を送信する', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);
      const killSpy = vi.spyOn(proc, 'kill');

      ctx.claudeProcess.interrupt();

      expect(killSpy).toHaveBeenCalledWith('SIGINT');
    });

    it('プロセスが未起動の場合は何もしない', () => {
      const ctx = createTestContext();

      // エラーが発生しないことを確認
      expect(() => ctx.claudeProcess.interrupt()).not.toThrow();
    });

    it('10秒以内にプロセスが終了すれば SIGKILL は送信されない', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);
      const killSpy = vi.spyOn(proc, 'kill');

      ctx.claudeProcess.interrupt();
      simulateClose(proc, 0);

      // 10秒経過させても SIGKILL は呼ばれない
      vi.advanceTimersByTime(10_000);

      const killCalls = killSpy.mock.calls.map(([sig]) => sig);
      expect(killCalls).toEqual(['SIGINT']);
    });

    it('10秒経過してもプロセスが終了しない場合、SIGKILL を送信する', () => {
      const ctx = createTestContext();
      ctx.claudeProcess.spawn('hello', 'session-123', '/work');
      const proc = latestProcess(ctx);
      const killSpy = vi.spyOn(proc, 'kill');

      ctx.claudeProcess.interrupt();

      // 10秒経過
      vi.advanceTimersByTime(10_000);

      const killCalls = killSpy.mock.calls.map(([sig]) => sig);
      expect(killCalls).toEqual(['SIGINT', 'SIGKILL']);
    });
  });
});
