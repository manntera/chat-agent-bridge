import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConversationRef,
  IClaudeProcess,
  OutboundMessage,
  ProgressEvent,
  SessionOptions,
} from '../core/types.js';
import { ConversationStore } from '../store/conversation-store.js';
import type { ConversationHandle } from './ports.js';
import { ConversationHub, type RuntimeDeps } from './runtime.js';

/**
 * ランタイム統合テスト:
 * フェイクの ClaudeProcess / Handle / インメモリ SQLite で
 * 「プロンプト → 進捗 → 完了 → usage → キュー消化 → 復元」の一連の流れを検証する。
 */

class FakeProcess implements IClaudeProcess {
  isRunning = false;
  spawnCalls: Array<{
    prompt: string;
    sessionId: string;
    workDir: string;
    resume: boolean;
    options?: SessionOptions;
  }> = [];
  interruptCalls = 0;
  onProgress!: (event: ProgressEvent) => void;
  onProcessEnd!: (exitCode: number, output: string) => void;

  spawn(
    prompt: string,
    sessionId: string,
    workDir: string,
    resume: boolean,
    options?: SessionOptions,
  ): void {
    this.isRunning = true;
    this.spawnCalls.push({ prompt, sessionId, workDir, resume, options });
  }

  interrupt(): void {
    this.interruptCalls = this.interruptCalls + 1;
  }

  finish(exitCode: number, output: string): void {
    this.isRunning = false;
    this.onProcessEnd(exitCode, output);
  }
}

class FakeHandle implements ConversationHandle {
  messages: OutboundMessage[] = [];
  titles: string[] = [];

  constructor(readonly ref: ConversationRef) {}

  send(message: OutboundMessage): void {
    this.messages.push(message);
  }

  setTitle(title: string): Promise<void> {
    this.titles.push(title);
    return Promise.resolve();
  }
}

const REF: ConversationRef = { platform: 'discord', id: 'thread-1' };
const WS = { name: 'proj', path: '' }; // path はテストごとに設定

let store: ConversationStore;
let tempWorkDir: string;

function createHub(processes: FakeProcess[]) {
  const deps: RuntimeDeps = {
    store,
    usageFetcher: {
      fetch: vi.fn().mockResolvedValue({
        fiveHour: { utilization: 10, resetsAt: 'x' },
        sevenDay: null,
        sevenDaySonnet: null,
      }),
    },
    titleGenerator: {
      generate: vi.fn().mockResolvedValue('生成されたタイトル'),
    },
    createProcess: (_ref, onProgress, onProcessEnd) => {
      const proc = new FakeProcess();
      proc.onProgress = onProgress;
      proc.onProcessEnd = onProcessEnd;
      processes.push(proc);
      return proc;
    },
    log: () => {},
  };
  return new ConversationHub(deps);
}

/** マイクロタスク(usage fetch / title 生成)を消化する */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  store = new ConversationStore(':memory:');
  tempWorkDir = mkdtempSync(join(tmpdir(), 'runtime-test-'));
  WS.path = tempWorkDir;
});

afterEach(() => {
  store.close();
  rmSync(tempWorkDir, { recursive: true, force: true });
});

describe('ConversationRuntime + Hub', () => {
  it('openNew: 初期状態がストアへ永続化される', () => {
    const processes: FakeProcess[] = [];
    const hub = createHub(processes);
    const handle = new FakeHandle(REF);

    hub.openNew(REF, handle, WS, { model: 'opus' }, 'sess-fixed');

    const rec = store.get('discord:thread-1');
    expect(rec).toMatchObject({
      sessionId: 'sess-fixed',
      workspaceName: 'proj',
      options: { model: 'opus' },
      turn: 0,
    });
  });

  it('プロンプト → 完了 → usage の一連の流れ', async () => {
    const processes: FakeProcess[] = [];
    const hub = createHub(processes);
    const handle = new FakeHandle(REF);
    const runtime = hub.openNew(REF, handle, WS, {}, 'sess-1');

    runtime.dispatch({ type: 'prompt', text: 'こんにちは', platformMessageId: 'msg-1' });

    const proc = processes[0];
    expect(proc.spawnCalls).toHaveLength(1);
    expect(proc.spawnCalls[0]).toMatchObject({ prompt: 'こんにちは', resume: false });

    // ターンがストアに記録されている
    expect(store.findTurnByMessage('discord:thread-1', 'msg-1')).toMatchObject({
      seq: 1,
      sessionId: 'sess-1',
    });

    // 進捗イベント → progress メッセージ
    proc.onProgress({ kind: 'tool_use', toolName: 'Read', target: 'a.ts' });
    expect(handle.messages.some((m) => m.kind === 'progress' && m.text.includes('Read'))).toBe(
      true,
    );

    // 完了 → usage 到着後に result が届く
    proc.finish(0, '最終回答');
    await flushAsync();

    const result = handle.messages.find((m) => m.kind === 'result');
    expect(result).toMatchObject({ text: '最終回答', footer: '📊 5h 10%' });

    // ターンカウンタが永続化されている
    expect(store.get('discord:thread-1')?.turn).toBe(1);
  });

  it('busy 中のプロンプトはキューされ、完了後に自動実行される', async () => {
    const processes: FakeProcess[] = [];
    const hub = createHub(processes);
    const handle = new FakeHandle(REF);
    const runtime = hub.openNew(REF, handle, WS, {}, 'sess-1');
    const proc = processes[0];

    runtime.dispatch({ type: 'prompt', text: '1つ目', platformMessageId: 'm1' });
    runtime.dispatch({ type: 'prompt', text: '2つ目', platformMessageId: 'm2' });

    expect(proc.spawnCalls).toHaveLength(1);
    expect(handle.messages.some((m) => m.kind === 'plain' && m.text.includes('キュー'))).toBe(true);

    proc.finish(0, '1つ目の回答');
    await flushAsync();

    expect(proc.spawnCalls).toHaveLength(2);
    expect(proc.spawnCalls[1]).toMatchObject({ prompt: '2つ目', resume: true });
    expect(store.findTurnByMessage('discord:thread-1', 'm2')?.seq).toBe(2);
  });

  it('ターン完了時にタイトルが生成される', async () => {
    const processes: FakeProcess[] = [];
    const hub = createHub(processes);
    const handle = new FakeHandle(REF);
    const runtime = hub.openNew(REF, handle, WS, {}, 'sess-1');

    runtime.dispatch({ type: 'prompt', text: 'q', platformMessageId: null });
    processes[0].finish(0, 'a');
    await flushAsync();

    expect(handle.titles).toEqual(['生成されたタイトル']);
  });

  it('tryRestore: ストアの行からランタイムを復元する', async () => {
    store.upsert({
      ref: 'discord:thread-1',
      platform: 'discord',
      sessionId: 'restored-sess',
      workDir: tempWorkDir,
      workspaceName: 'proj',
      options: { effort: 'high' },
      turn: 7,
    });

    const processes: FakeProcess[] = [];
    const hub = createHub(processes);
    const handle = new FakeHandle(REF);

    const runtime = await hub.tryRestore(REF, handle);

    expect(runtime).not.toBeNull();
    expect(runtime!.state.sessionId).toBe('restored-sess');
    expect(runtime!.state.turn).toBe(7);
    expect(runtime!.state.isNewSession).toBe(false);
    expect(hub.get(REF)).toBe(runtime);
  });

  it('tryRestore: workDir が存在しない場合はエラーメッセージを送って行を削除する', async () => {
    store.upsert({
      ref: 'discord:thread-1',
      platform: 'discord',
      sessionId: 's',
      workDir: join(tempWorkDir, 'does-not-exist'),
      workspaceName: 'proj',
      options: {},
      turn: 0,
    });

    const hub = createHub([]);
    const handle = new FakeHandle(REF);

    const runtime = await hub.tryRestore(REF, handle);

    expect(runtime).toBeNull();
    expect(handle.messages.some((m) => m.kind === 'plain' && m.text.includes('復元に失敗'))).toBe(
      true,
    );
    expect(store.get('discord:thread-1')).toBeNull();
  });

  it('tryRestore: ストアに行がなければ null', async () => {
    const hub = createHub([]);
    expect(await hub.tryRestore(REF, new FakeHandle(REF))).toBeNull();
  });

  it('並行 tryRestore は同一ランタイムを返す(二重復元しない)', async () => {
    store.upsert({
      ref: 'discord:thread-1',
      platform: 'discord',
      sessionId: 's',
      workDir: tempWorkDir,
      workspaceName: 'proj',
      options: {},
      turn: 0,
    });

    const hub = createHub([]);
    const handle = new FakeHandle(REF);

    const [a, b] = await Promise.all([hub.tryRestore(REF, handle), hub.tryRestore(REF, handle)]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});
