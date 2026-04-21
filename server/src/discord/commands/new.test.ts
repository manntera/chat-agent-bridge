import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  TextChannel,
} from 'discord.js';
import type { SessionContext } from '../../domain/session-manager.js';
import type { Workspace } from '../../domain/types.js';
import type { IWorkspaceStore } from '../../infrastructure/workspace-store.js';
import type { CreateSessionFn, PersistMappingFn } from '../session-factory.js';
import { createNewCommand, __resetPendingOptionsForTesting } from './new.js';

/**
 * ユニットテスト方針:
 * - discord.js の Interaction は非常に大きな型なので、実際に使うプロパティだけを
 *   持たせたスタブを coerce して渡す (既存 rewind-handler.test.ts / message-controller.test.ts と同じ方針)。
 * - channel.threads.create は `{ id, name, ... }` の最低限の返却で十分。
 * - createSession と persistMapping も最小の mock に差し替える。
 * - pendingNewOptions は module-level の Map なので、2 件以上ワークスペース経路と
 *   SelectMenu 経路を続けて呼ぶことで実挙動を検証する。
 */

// ---------- Workspace Store -----------

function makeWorkspaceStore(workspaces: Workspace[]): IWorkspaceStore {
  const store: IWorkspaceStore = {
    list: vi.fn(() => [...workspaces]),
    add: vi.fn(),
    remove: vi.fn(() => false),
    findByName: vi.fn((name: string) => workspaces.find((w) => w.name === name)),
  };
  return store;
}

// ---------- Channel / Thread -----------

interface CreatedThread {
  id: string;
  name: string;
  send: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  setName: ReturnType<typeof vi.fn>;
}

function makeChannel(threadIdFactory?: () => string): {
  channel: Pick<TextChannel, 'threads'>;
  createCalls: Array<{ name: string; autoArchiveDuration?: number }>;
  threads: CreatedThread[];
  failNext: (err?: Error) => void;
} {
  const createCalls: Array<{ name: string; autoArchiveDuration?: number }> = [];
  const threads: CreatedThread[] = [];
  let shouldFail: Error | null = null;
  let counter = 0;

  const create = vi
    .fn<(opts: { name: string; autoArchiveDuration?: number }) => Promise<CreatedThread>>()
    .mockImplementation(async (opts) => {
      createCalls.push(opts);
      if (shouldFail) {
        const err = shouldFail;
        shouldFail = null;
        throw err;
      }
      const id = threadIdFactory ? threadIdFactory() : `thread-id-${++counter}`;
      const t: CreatedThread = {
        id,
        name: opts.name,
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
        setName: vi.fn().mockResolvedValue(undefined),
      };
      threads.push(t);
      return t;
    });

  const channel = {
    threads: { create },
  } as unknown as Pick<TextChannel, 'threads'>;

  return {
    channel,
    createCalls,
    threads,
    failNext: (err = new Error('create failed')) => {
      shouldFail = err;
    },
  };
}

// ---------- Session / Factory -----------

interface CtxStub {
  threadId: string;
  session: {
    reset: ReturnType<typeof vi.fn>;
    ensure: ReturnType<typeof vi.fn>;
    sessionId: string | null;
  };
}

function makeCreateSession(idFactory?: () => string): {
  fn: CreateSessionFn;
  calls: Array<{ threadId: string; workspace: Workspace }>;
  ctxs: CtxStub[];
} {
  const calls: Array<{ threadId: string; workspace: Workspace }> = [];
  const ctxs: CtxStub[] = [];
  let counter = 0;
  const fn = vi.fn((threadId, _thread, workspace) => {
    calls.push({ threadId, workspace });
    const ctx: CtxStub = {
      threadId,
      session: {
        reset: vi.fn(),
        ensure: vi.fn(),
        sessionId: null,
      },
    };
    ctx.session.reset = vi.fn(() => {
      ctx.session.sessionId = null;
    });
    ctx.session.ensure = vi.fn(() => {
      const id = idFactory ? idFactory() : `ctx-session-${++counter}`;
      ctx.session.sessionId = id;
      return id;
    });
    ctxs.push(ctx);
    return ctx as unknown as SessionContext;
  }) as unknown as CreateSessionFn;
  return { fn, calls, ctxs };
}

// ---------- Interaction stubs -----------

interface CommandInteractionStubOpts {
  userId?: string;
  channelId?: string;
  model?: string | null;
  effort?: string | null;
}

interface CommandInteractionStub {
  user: { id: string };
  channelId: string;
  options: {
    getString: ReturnType<typeof vi.fn>;
  };
  reply: ReturnType<typeof vi.fn>;
}

function makeCommandInteraction(opts: CommandInteractionStubOpts = {}): CommandInteractionStub {
  const { userId = 'user-1', channelId = 'parent-ch', model = null, effort = null } = opts;
  return {
    user: { id: userId },
    channelId,
    options: {
      getString: vi.fn((key: string) => {
        if (key === 'model') return model;
        if (key === 'effort') return effort;
        return null;
      }),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function coerceCommand(i: CommandInteractionStub): ChatInputCommandInteraction {
  return i as unknown as ChatInputCommandInteraction;
}

interface SelectInteractionStubOpts {
  userId?: string;
  value?: string;
}

interface SelectInteractionStub {
  user: { id: string };
  values: string[];
  update: ReturnType<typeof vi.fn>;
}

function makeSelectInteraction(opts: SelectInteractionStubOpts = {}): SelectInteractionStub {
  const { userId = 'user-1', value = 'ws-a' } = opts;
  return {
    user: { id: userId },
    values: [value],
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function coerceSelect(i: SelectInteractionStub): StringSelectMenuInteraction {
  return i as unknown as StringSelectMenuInteraction;
}

// =================================================================
// Tests
// =================================================================

const WS_A: Workspace = { name: 'ws-a', path: '/home/user/ws-a' };
const WS_B: Workspace = { name: 'ws-b', path: '/home/user/ws-b' };

describe('createNewCommand', () => {
  let persistMapping: ReturnType<typeof vi.fn<PersistMappingFn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPendingOptionsForTesting();
    persistMapping = vi.fn<PersistMappingFn>().mockResolvedValue(undefined);
  });

  it('customId が "cc_workspace_select" に固定されている', () => {
    const cmd = createNewCommand({
      workspaceStore: makeWorkspaceStore([]),
      createSession: makeCreateSession().fn,
      persistMapping,
      channel: makeChannel().channel,
    });
    expect(cmd.customId).toBe('cc_workspace_select');
  });

  describe('handleCommand', () => {
    it('WS 0 件: ephemeral で警告メッセージを返し、スレッドは作らない', async () => {
      const { channel, createCalls } = makeChannel();
      const { fn: createSession } = makeCreateSession();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([]),
        createSession,
        persistMapping,
        channel,
      });

      const i = makeCommandInteraction();
      await cmd.handleCommand(coerceCommand(i));

      expect(i.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('ワークスペースが登録されていません'),
        ephemeral: true,
      });
      expect(createCalls).toHaveLength(0);
      expect(persistMapping).not.toHaveBeenCalled();
    });

    it('WS 1 件: 自動選択でスレッドを作成し、createSession・persistMapping・thread.send を呼ぶ', async () => {
      const { channel, createCalls, threads } = makeChannel(() => 'thr-xyz');
      const createSessionHolder = makeCreateSession(() => 'ctx-sess-77');
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: createSessionHolder.fn,
        persistMapping,
        channel,
      });

      const i = makeCommandInteraction();
      await cmd.handleCommand(coerceCommand(i));

      // スレッドが作成された
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].name).toMatch(/^\[ws-a\] Session: [0-9a-f]{8}$/);
      expect(createCalls[0].autoArchiveDuration).toBe(60);

      // createSession が呼ばれた
      expect(createSessionHolder.calls).toHaveLength(1);
      expect(createSessionHolder.calls[0]).toEqual({ threadId: 'thr-xyz', workspace: WS_A });

      // persistMapping が実 sessionId で呼ばれた (ctx 側の UUID)
      expect(persistMapping).toHaveBeenCalledWith('thr-xyz', 'ctx-sess-77', WS_A);

      // thread.send でセッション開始メッセージが送信された
      expect(threads[0].send).toHaveBeenCalledWith(
        expect.stringContaining('セッションを開始しました'),
      );
      expect(threads[0].send).toHaveBeenCalledWith(expect.stringContaining('ws-a'));

      // interaction.reply で成功通知
      expect(i.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('<#thr-xyz>'),
        ephemeral: true,
      });
    });

    it('WS 1 件: --model 指定がスレッド名と開始メッセージに反映される', async () => {
      const { channel, createCalls, threads } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      const i = makeCommandInteraction({ model: 'opus' });
      await cmd.handleCommand(coerceCommand(i));

      expect(createCalls[0].name).toMatch(/ \(opus\)$/);
      expect(threads[0].send).toHaveBeenCalledWith(expect.stringContaining('(opus)'));
    });

    it('WS 1 件: --model と --effort を両方指定するとスレッド名に両方が反映される', async () => {
      const { channel, createCalls } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      const i = makeCommandInteraction({ model: 'opus', effort: 'high' });
      await cmd.handleCommand(coerceCommand(i));

      expect(createCalls[0].name).toMatch(/ \(opus, high\)$/);
    });

    it('WS 1 件: オプションなしならスレッド名に括弧が付かない', async () => {
      const { channel, createCalls } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      const i = makeCommandInteraction();
      await cmd.handleCommand(coerceCommand(i));

      expect(createCalls[0].name).not.toContain('(');
    });

    it('WS 1 件: invalid な effort ("low" 等) は options から落とされ、スレッド名にも出ない', async () => {
      // toCommand 内部の VALID_EFFORTS で弾かれる仕様 (medium/high/max のみ)。
      const { channel, createCalls } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      const i = makeCommandInteraction({ effort: 'low' });
      await cmd.handleCommand(coerceCommand(i));

      expect(createCalls[0].name).not.toContain('low');
    });

    it('WS 2 件以上: SelectMenu を reply で返し、スレッドは作らない', async () => {
      const { channel, createCalls } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A, WS_B]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      const i = makeCommandInteraction();
      await cmd.handleCommand(coerceCommand(i));

      expect(createCalls).toHaveLength(0);
      expect(persistMapping).not.toHaveBeenCalled();
      expect(i.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('作業ディレクトリを選択してください'),
          components: expect.any(Array),
          ephemeral: true,
        }),
      );
      const replyArg = i.reply.mock.calls[0][0];
      expect(replyArg.components).toHaveLength(1);
    });

    it('threads.create が reject した場合は "スレッドの作成に失敗しました" を ephemeral で返す', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ch = makeChannel();
      ch.failNext(new Error('boom'));
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel: ch.channel,
      });

      const i = makeCommandInteraction();
      await cmd.handleCommand(coerceCommand(i));

      expect(i.reply).toHaveBeenCalledWith({
        content: 'スレッドの作成に失敗しました',
        ephemeral: true,
      });
      expect(persistMapping).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('handleSelect', () => {
    it('ワークスペース未発見: update で警告、スレッドは作らない', async () => {
      const { channel, createCalls } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      const i = makeSelectInteraction({ value: 'non-existent' });
      await cmd.handleSelect(coerceSelect(i));

      expect(i.update).toHaveBeenCalledWith({
        content: expect.stringContaining('ワークスペース「non-existent」が見つかりません'),
        components: [],
      });
      expect(createCalls).toHaveLength(0);
      expect(persistMapping).not.toHaveBeenCalled();
    });

    it('pendingNewOptions あり: 保存された options でスレッド作成 → map から削除される', async () => {
      // 先に handleCommand を呼んで pending を登録、続いて handleSelect を呼ぶ。
      const { channel, createCalls } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A, WS_B]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      // 2 件以上なので pending に格納されるだけ
      const cmdI = makeCommandInteraction({ userId: 'u-1', model: 'opus', effort: 'high' });
      await cmd.handleCommand(coerceCommand(cmdI));
      expect(createCalls).toHaveLength(0);

      // 選択 → pending を復元してスレッド作成
      const selI = makeSelectInteraction({ userId: 'u-1', value: 'ws-b' });
      await cmd.handleSelect(coerceSelect(selI));

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].name).toMatch(/^\[ws-b\] Session: [0-9a-f]{8} \(opus, high\)$/);

      // 同じユーザーがもう一度 select すると pending は消えているので options なし経路
      const selI2 = makeSelectInteraction({ userId: 'u-1', value: 'ws-b' });
      await cmd.handleSelect(coerceSelect(selI2));

      expect(createCalls).toHaveLength(2);
      expect(createCalls[1].name).not.toContain('opus');
      expect(createCalls[1].name).not.toContain('high');
    });

    it('pendingNewOptions なし: オプション無しでスレッド作成する (session.ensure に {} が渡る)', async () => {
      const { channel, createCalls, threads } = makeChannel(() => 'thr-1');
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession(() => 'ctx-sess').fn,
        persistMapping,
        channel,
      });

      const i = makeSelectInteraction({ userId: 'no-pending-user', value: 'ws-a' });
      await cmd.handleSelect(coerceSelect(i));

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].name).not.toContain('(');
      expect(persistMapping).toHaveBeenCalledWith('thr-1', 'ctx-sess', WS_A);
      expect(threads[0].send).toHaveBeenCalledWith(
        expect.stringContaining('セッションを開始しました'),
      );
      expect(i.update).toHaveBeenCalledWith({
        content: expect.stringContaining('<#thr-1>'),
        components: [],
      });
    });

    it('threads.create が reject: update で失敗通知、persistMapping は呼ばれない', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ch = makeChannel();
      ch.failNext(new Error('disc down'));
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel: ch.channel,
      });

      const i = makeSelectInteraction({ value: 'ws-a' });
      await cmd.handleSelect(coerceSelect(i));

      expect(i.update).toHaveBeenCalledWith({
        content: 'スレッドの作成に失敗しました',
        components: [],
      });
      expect(persistMapping).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('複数ユーザー同時実行: ユーザーごとに独立した pendingOptions が扱われる', async () => {
      const { channel, createCalls } = makeChannel();
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A, WS_B]),
        createSession: makeCreateSession().fn,
        persistMapping,
        channel,
      });

      // user A: model=opus
      await cmd.handleCommand(
        coerceCommand(makeCommandInteraction({ userId: 'A', model: 'opus' })),
      );
      // user B: effort=max
      await cmd.handleCommand(
        coerceCommand(makeCommandInteraction({ userId: 'B', effort: 'max' })),
      );

      expect(createCalls).toHaveLength(0);

      // user B が先に選択
      await cmd.handleSelect(coerceSelect(makeSelectInteraction({ userId: 'B', value: 'ws-a' })));
      // user A が続いて選択
      await cmd.handleSelect(coerceSelect(makeSelectInteraction({ userId: 'A', value: 'ws-b' })));

      expect(createCalls).toHaveLength(2);
      expect(createCalls[0].name).toMatch(/\[ws-a\] Session: [0-9a-f]{8} \(max\)$/);
      expect(createCalls[1].name).toMatch(/\[ws-b\] Session: [0-9a-f]{8} \(opus\)$/);
    });

    it('2 段階 sessionId 生成: スレッド名の sessionId と persistMapping の sessionId は別物 (既存挙動維持)', async () => {
      // スレッド名に入る sessionId はコマンド内で生成した session.ensure() の UUID、
      // persistMapping に渡る sessionId は createSession 後の ctx.session.reset + ensure で
      // 生成された別の UUID。issue #23 の指示どおりこの挙動を変えない。
      const { channel, createCalls } = makeChannel(() => 'thr-1');

      const { fn: createSession } = makeCreateSession(() => 'CTX-SESS-ID');
      const cmd = createNewCommand({
        workspaceStore: makeWorkspaceStore([WS_A]),
        createSession,
        persistMapping,
        channel,
      });

      const i = makeSelectInteraction({ userId: 'solo', value: 'ws-a' });
      await cmd.handleSelect(coerceSelect(i));

      const threadName = createCalls[0].name;
      // スレッド名に含まれる 8 桁 sessionId を抽出
      const match = threadName.match(/Session: ([0-9a-f]{8})/);
      expect(match).not.toBeNull();
      const threadSessionId8 = match![1];

      // persistMapping に渡された sessionId は ctx 側の UUID であり、
      // スレッド名用の UUID とは別物であることを確認する。
      expect(persistMapping).toHaveBeenCalledWith('thr-1', 'CTX-SESS-ID', WS_A);
      expect('CTX-SESS-ID').not.toContain(threadSessionId8);
    });
  });
});

// ---------- 外部非公開の確認 -----------
describe('new.ts のモジュール非公開性', () => {
  it('pendingNewOptions が export されていない (間接確認)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('./new.js');
    expect(mod.pendingNewOptions).toBeUndefined();
  });
});
