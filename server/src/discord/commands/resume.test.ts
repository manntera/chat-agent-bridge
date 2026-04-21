import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import type { SessionContext } from '../../domain/session-manager.js';
import type { ISessionStore, SessionSummary, Workspace } from '../../domain/types.js';
import type { IWorkspaceStore } from '../../infrastructure/workspace-store.js';
import type { TurnStore } from '../../infrastructure/turn-store.js';
import type { CreateSessionFn, PersistMappingFn } from '../session-factory.js';
import { createResumeCommand } from './resume.js';

/** SelectMenu の option (ActionRowBuilder.toJSON() 経由で得られる形) */
interface SelectOption {
  label: string;
  description?: string;
  value: string;
}

/** editReply 呼び出しに渡された ActionRow を toJSON して 1 枚目の SelectMenu の options を取り出す */
function extractSelectOptions(editReply: ReturnType<typeof vi.fn>, callIndex = 0): SelectOption[] {
  const payload = editReply.mock.calls[callIndex][0] as {
    components: ActionRowBuilder<StringSelectMenuBuilder>[];
  };
  const row = payload.components[0];
  const json = row.toJSON() as {
    components: Array<{ options: SelectOption[] }>;
  };
  return json.components[0].options;
}

interface WorkspaceStoreMock {
  list: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  findByName: ReturnType<typeof vi.fn>;
}

interface SessionStoreMock {
  listSessions: ReturnType<typeof vi.fn>;
}

interface TurnStoreMock {
  maxTurn: ReturnType<typeof vi.fn>;
}

function makeWorkspaceStore(workspaces: Workspace[] = []): WorkspaceStoreMock {
  const list = [...workspaces];
  return {
    list: vi.fn(() => [...list]),
    add: vi.fn(),
    remove: vi.fn(),
    findByName: vi.fn((name: string) => list.find((w) => w.name === name)),
  };
}

function makeSessionStore(): SessionStoreMock {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
  };
}

function makeTurnStore(): TurnStoreMock {
  return {
    maxTurn: vi.fn().mockResolvedValue(0),
  };
}

function coerceWorkspaceStore(m: WorkspaceStoreMock): IWorkspaceStore {
  return m as unknown as IWorkspaceStore;
}

function coerceSessionStore(m: SessionStoreMock): ISessionStore {
  return m as unknown as ISessionStore;
}

function coerceTurnStore(m: TurnStoreMock): TurnStore {
  return m as unknown as TurnStore;
}

/** ChatInputCommandInteraction のモック。deferReply / editReply / user を持つ */
function makeCommandInteraction(): {
  interaction: ChatInputCommandInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    deferReply,
    editReply,
    user: { id: 'user-1', username: 'alice' },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, deferReply, editReply };
}

/** StringSelectMenuInteraction のモック */
function makeSelectInteraction(selectedValue: string): {
  interaction: StringSelectMenuInteraction;
  update: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    values: [selectedValue],
    user: { id: 'user-1', username: 'alice' },
    update,
  } as unknown as StringSelectMenuInteraction;
  return { interaction, update };
}

/** TextChannel のモック (threads.create のみ) */
function makeChannel(threadId = 'new-thread-1'): {
  channel: TextChannel;
  threadsCreate: ReturnType<typeof vi.fn>;
  thread: {
    id: string;
    send: ReturnType<typeof vi.fn>;
    sendTyping: ReturnType<typeof vi.fn>;
    setName: ReturnType<typeof vi.fn>;
  };
} {
  const thread = {
    id: threadId,
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
  };
  const threadsCreate = vi.fn().mockResolvedValue(thread);
  const channel = { threads: { create: threadsCreate } } as unknown as TextChannel;
  return { channel, threadsCreate, thread };
}

/** SessionContext のモック */
function makeSessionContext(): {
  ctx: SessionContext;
  restore: ReturnType<typeof vi.fn>;
  restoreTurnCount: ReturnType<typeof vi.fn>;
} {
  const restore = vi.fn();
  const restoreTurnCount = vi.fn();
  const ctx = {
    session: { restore },
    orchestrator: { restoreTurnCount },
  } as unknown as SessionContext;
  return { ctx, restore, restoreTurnCount };
}

function makeSessionSummary(
  options: Partial<SessionSummary> & { sessionId: string; lastModified: Date },
): SessionSummary {
  const { sessionId, lastModified, firstUserMessage = 'hello world', slug = null } = options;
  return { sessionId, firstUserMessage, slug, lastModified };
}

describe('createResumeCommand', () => {
  let workspaceStore: WorkspaceStoreMock;
  let sessionStore: SessionStoreMock;
  let turnStore: TurnStoreMock;
  let createSession: ReturnType<typeof vi.fn<CreateSessionFn>>;
  let persistMapping: ReturnType<typeof vi.fn<PersistMappingFn>>;
  let channelMock: ReturnType<typeof makeChannel>;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceStore = makeWorkspaceStore();
    sessionStore = makeSessionStore();
    turnStore = makeTurnStore();
    createSession = vi.fn<CreateSessionFn>();
    persistMapping = vi.fn<PersistMappingFn>().mockResolvedValue(undefined);
    channelMock = makeChannel();
  });

  function build() {
    return createResumeCommand({
      workspaceStore: coerceWorkspaceStore(workspaceStore),
      sessionStore: coerceSessionStore(sessionStore),
      turnStore: coerceTurnStore(turnStore),
      createSession,
      persistMapping,
      channel: channelMock.channel,
    });
  }

  it('customId は cc_resume_select で公開される', () => {
    const cmd = build();
    expect(cmd.customId).toBe('cc_resume_select');
  });

  describe('handleCommand', () => {
    it('ワークスペース 0 件 → 登録を促すメッセージで editReply', async () => {
      workspaceStore.list.mockReturnValueOnce([]);
      const cmd = build();
      const { interaction, deferReply, editReply } = makeCommandInteraction();

      await cmd.handleCommand(interaction);

      expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(editReply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledWith(
        expect.stringContaining('ワークスペースが登録されていません'),
      );
      expect(sessionStore.listSessions).not.toHaveBeenCalled();
    });

    it('ワークスペースはあるがセッション 0 件 → 「再開できるセッションがありません」', async () => {
      workspaceStore = makeWorkspaceStore([{ name: 'ws1', path: '/w1' }]);
      sessionStore.listSessions.mockResolvedValueOnce([]);
      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();

      await cmd.handleCommand(interaction);

      expect(editReply).toHaveBeenLastCalledWith('再開できるセッションがありません');
    });

    it('複数セッションを lastModified 降順でソートし、SelectMenu components を返す', async () => {
      workspaceStore = makeWorkspaceStore([
        { name: 'alpha', path: '/a' },
        { name: 'bravo', path: '/b' },
      ]);
      const t1 = new Date('2026-01-01T00:00:00Z');
      const t2 = new Date('2026-01-02T00:00:00Z');
      const t3 = new Date('2026-01-03T00:00:00Z');

      sessionStore.listSessions.mockImplementation(async (workDir: string) => {
        if (workDir === '/a') {
          return [
            makeSessionSummary({ sessionId: 'sid-a1', lastModified: t1 }),
            makeSessionSummary({ sessionId: 'sid-a3', lastModified: t3 }),
          ];
        }
        if (workDir === '/b') {
          return [makeSessionSummary({ sessionId: 'sid-b2', lastModified: t2 })];
        }
        return [];
      });

      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();

      await cmd.handleCommand(interaction);

      expect(editReply).toHaveBeenCalledTimes(1);
      const payload = editReply.mock.calls[0][0] as {
        content: string;
        components: ActionRowBuilder<StringSelectMenuBuilder>[];
      };

      expect(payload.content).toContain('再開するセッションを選択してください');
      const options = extractSelectOptions(editReply);
      expect(options).toHaveLength(3);

      // 降順: t3 (sid-a3) → t2 (sid-b2) → t1 (sid-a1)
      expect(options[0].value).toBe('alpha:sid-a3');
      expect(options[1].value).toBe('bravo:sid-b2');
      expect(options[2].value).toBe('alpha:sid-a1');
    });

    it('25 件を超えるセッションは上位 25 件のみ返す', async () => {
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      const summaries: SessionSummary[] = Array.from({ length: 30 }, (_, i) =>
        makeSessionSummary({
          sessionId: `sid-${i}`,
          // i が大きいほど新しい
          lastModified: new Date(2026, 0, i + 1),
        }),
      );
      sessionStore.listSessions.mockResolvedValueOnce(summaries);

      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await cmd.handleCommand(interaction);

      const options = extractSelectOptions(editReply);
      expect(options).toHaveLength(25);
      // 最初は i=29 (最新)
      expect(options[0].value).toBe('ws:sid-29');
    });

    it('ワークスペース名が長くても label は 100 文字以内に収まる', async () => {
      const longName = 'a'.repeat(50); // NAME_PATTERN では任意長可
      workspaceStore = makeWorkspaceStore([{ name: longName, path: '/w' }]);
      const longMsg = 'x'.repeat(500);
      sessionStore.listSessions.mockResolvedValueOnce([
        makeSessionSummary({
          sessionId: 'sid-1',
          lastModified: new Date(),
          firstUserMessage: longMsg,
        }),
      ]);

      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await cmd.handleCommand(interaction);

      const option = extractSelectOptions(editReply)[0];
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect(option.description?.length ?? 0).toBeLessThanOrEqual(100);
    });

    it('slug がある場合は slug を label に使い、description に firstUserMessage を入れる', async () => {
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      sessionStore.listSessions.mockResolvedValueOnce([
        makeSessionSummary({
          sessionId: 'sid-1',
          lastModified: new Date(),
          slug: 'fix-bug-xyz',
          firstUserMessage: 'please fix the bug in xyz module',
        }),
      ]);
      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await cmd.handleCommand(interaction);

      const option = extractSelectOptions(editReply)[0];
      expect(option.label).toBe('[ws] fix-bug-xyz');
      expect(option.description).toBe('please fix the bug in xyz module');
    });

    it('firstUserMessage が空の場合は "(空のメッセージ)" を用いる', async () => {
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      sessionStore.listSessions.mockResolvedValueOnce([
        makeSessionSummary({
          sessionId: 'sid-1',
          lastModified: new Date(),
          firstUserMessage: '',
        }),
      ]);
      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await cmd.handleCommand(interaction);

      const option = extractSelectOptions(editReply)[0];
      expect(option.label).toBe('[ws] (空のメッセージ)');
    });

    it('slug が長すぎる場合は label として切り詰められる', async () => {
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      const longSlug = 'a'.repeat(200);
      sessionStore.listSessions.mockResolvedValueOnce([
        makeSessionSummary({
          sessionId: 'sid-1',
          lastModified: new Date(),
          slug: longSlug,
          firstUserMessage: 'short msg',
        }),
      ]);
      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await cmd.handleCommand(interaction);

      const option = extractSelectOptions(editReply)[0];
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect(option.label.endsWith('...')).toBe(true);
      expect(option.label.startsWith('[ws] ')).toBe(true);
    });

    it('slug があり firstUserMessage が 100 文字超の場合、description は 100 文字以内に切り詰められる', async () => {
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      const longMsg = 'y'.repeat(300);
      sessionStore.listSessions.mockResolvedValueOnce([
        makeSessionSummary({
          sessionId: 'sid-1',
          lastModified: new Date(),
          slug: 'slug-name',
          firstUserMessage: longMsg,
        }),
      ]);
      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await cmd.handleCommand(interaction);

      const option = extractSelectOptions(editReply)[0];
      expect(option.description?.length ?? 0).toBeLessThanOrEqual(100);
      expect(option.description?.endsWith('...')).toBe(true);
    });

    it('slug があり firstUserMessage が空文字の場合、description は相対日付にフォールバックする', async () => {
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      sessionStore.listSessions.mockResolvedValueOnce([
        makeSessionSummary({
          sessionId: 'sid-1',
          lastModified: new Date(),
          slug: 'slug-only',
          firstUserMessage: '',
        }),
      ]);
      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await cmd.handleCommand(interaction);

      const option = extractSelectOptions(editReply)[0];
      // cleanMsg が空 → slug 経路の desc は '' → '|| formatRelativeDate' にフォールバック
      expect(option.description).toMatch(/分前|時間前|日前|たった今|\d{4}\/\d{1,2}\/\d{1,2}/);
    });

    it('sessionStore.listSessions が throw した場合はエラーメッセージで editReply し例外は伝播しない', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      sessionStore.listSessions.mockRejectedValueOnce(new Error('disk error'));

      const cmd = build();
      const { interaction, editReply } = makeCommandInteraction();
      await expect(cmd.handleCommand(interaction)).resolves.toBeUndefined();
      expect(editReply).toHaveBeenLastCalledWith('セッション一覧の取得に失敗しました');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('handleSelect', () => {
    it('indexOf(:) で value をパースし、正常系は threads.create → createSession → restore → maxTurn → restoreTurnCount → persistMapping → update の順で呼ばれる', async () => {
      const workspace: Workspace = { name: 'my-ws', path: '/work/ws' };
      workspaceStore = makeWorkspaceStore([workspace]);
      turnStore.maxTurn.mockResolvedValueOnce(7);

      const { ctx, restore, restoreTurnCount } = makeSessionContext();
      createSession.mockReturnValueOnce(ctx);

      const cmd = build();
      const { interaction, update } = makeSelectInteraction(
        'my-ws:12345678-1234-1234-1234-123456789abc',
      );

      await cmd.handleSelect(interaction);

      // 呼び出し順序
      const order = [
        channelMock.threadsCreate.mock.invocationCallOrder[0],
        createSession.mock.invocationCallOrder[0],
        restore.mock.invocationCallOrder[0],
        turnStore.maxTurn.mock.invocationCallOrder[0],
        restoreTurnCount.mock.invocationCallOrder[0],
        persistMapping.mock.invocationCallOrder[0],
        update.mock.invocationCallOrder[0],
      ];
      // 全て増加順
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).toBeGreaterThan(order[i - 1]);
      }

      // 引数検証
      expect(channelMock.threadsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringContaining('my-ws'),
          autoArchiveDuration: 60,
        }),
      );
      expect(createSession).toHaveBeenCalledWith(
        channelMock.thread.id,
        channelMock.thread,
        workspace,
      );
      expect(restore).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789abc');
      expect(turnStore.maxTurn).toHaveBeenCalledWith(
        '12345678-1234-1234-1234-123456789abc',
        '/work/ws',
      );
      expect(restoreTurnCount).toHaveBeenCalledWith(7);
      expect(persistMapping).toHaveBeenCalledWith(
        channelMock.thread.id,
        '12345678-1234-1234-1234-123456789abc',
        workspace,
      );
      expect(channelMock.thread.send).toHaveBeenCalledWith(
        expect.stringContaining('セッションを再開しました'),
      );
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('を再開しました'),
          components: [],
        }),
      );
    });

    it('value にコロンがない場合は wsName が rawValue 全体、sessionId が空になる (indexOf 挙動の確認)', async () => {
      // indexOf(':') が -1 → slice(0, -1) = 先頭〜末尾-1、slice(0) = 全体
      // 実運用ではこの経路は通らないが、indexOf 実装の挙動を固定化する
      workspaceStore = makeWorkspaceStore([]);
      const cmd = build();
      const { interaction, update } = makeSelectInteraction('no-colon');

      await cmd.handleSelect(interaction);
      // findByName は 'no-colo' (no-colon の最後の文字を落とした文字列) で呼ばれる
      // indexOf = -1 → slice(0, -1) = 'no-colo'
      expect(workspaceStore.findByName).toHaveBeenCalledWith('no-colo');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('ワークスペース「no-colo」が見つかりません'),
        }),
      );
    });

    it('ワークスペースが削除済みなら findByName で undefined を返し、エラー通知で終了する', async () => {
      workspaceStore = makeWorkspaceStore([]); // 空
      const cmd = build();
      const { interaction, update } = makeSelectInteraction('removed-ws:sid-1');

      await cmd.handleSelect(interaction);

      expect(update).toHaveBeenCalledWith({
        content: 'ワークスペース「removed-ws」が見つかりません',
        components: [],
      });
      expect(channelMock.threadsCreate).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(persistMapping).not.toHaveBeenCalled();
    });

    it('sessionId にハイフンが含まれていても indexOf(:) で正しく分割される', async () => {
      const workspace: Workspace = { name: 'ws-1', path: '/w' };
      workspaceStore = makeWorkspaceStore([workspace]);
      const { ctx, restore } = makeSessionContext();
      createSession.mockReturnValueOnce(ctx);

      const cmd = build();
      const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const { interaction } = makeSelectInteraction(`ws-1:${sid}`);

      await cmd.handleSelect(interaction);

      expect(workspaceStore.findByName).toHaveBeenCalledWith('ws-1');
      expect(restore).toHaveBeenCalledWith(sid);
    });

    it('channel.threads.create が reject した場合はエラー通知で update し、例外は伝播しない', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      workspaceStore = makeWorkspaceStore([{ name: 'ws', path: '/w' }]);
      channelMock.threadsCreate.mockRejectedValueOnce(new Error('thread creation failed'));

      const cmd = build();
      const { interaction, update } = makeSelectInteraction('ws:sid-1');

      await expect(cmd.handleSelect(interaction)).resolves.toBeUndefined();

      expect(update).toHaveBeenCalledWith({
        content: 'セッションの再開に失敗しました',
        components: [],
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(persistMapping).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('persistMapping が reject した場合もエラー通知で終了する', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const workspace: Workspace = { name: 'ws', path: '/w' };
      workspaceStore = makeWorkspaceStore([workspace]);
      const { ctx } = makeSessionContext();
      createSession.mockReturnValueOnce(ctx);
      persistMapping.mockRejectedValueOnce(new Error('write failed'));

      const cmd = build();
      const { interaction, update } = makeSelectInteraction('ws:sid-1');

      await expect(cmd.handleSelect(interaction)).resolves.toBeUndefined();
      // 成功経路の update ではなく、catch 内の update が呼ばれる
      expect(update).toHaveBeenCalledWith({
        content: 'セッションの再開に失敗しました',
        components: [],
      });
      consoleErrorSpy.mockRestore();
    });
  });
});
