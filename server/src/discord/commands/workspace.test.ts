import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, StringSelectMenuInteraction } from 'discord.js';
import type { WorkspaceStore } from '../../infrastructure/workspace-store.js';
import { createWorkspaceCommands } from './workspace.js';

// listDirectories をモック化してファイルシステムに依存しない
vi.mock('../../infrastructure/workspace-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../infrastructure/workspace-store.js')>(
    '../../infrastructure/workspace-store.js',
  );
  return {
    ...actual,
    listDirectories: vi.fn<(dirPath: string) => string[]>().mockReturnValue([]),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workspaceStoreModule: any = await import('../../infrastructure/workspace-store.js');
const mockedListDirectories = workspaceStoreModule.listDirectories as ReturnType<typeof vi.fn>;

interface WorkspaceStoreMock {
  list: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  findByName: ReturnType<typeof vi.fn>;
}

function makeWorkspaceStore(): WorkspaceStoreMock {
  return {
    list: vi.fn().mockReturnValue([]),
    add: vi.fn(),
    remove: vi.fn().mockReturnValue(false),
    findByName: vi.fn().mockReturnValue(undefined),
  };
}

function coerceStore(s: WorkspaceStoreMock): WorkspaceStore {
  return s as unknown as WorkspaceStore;
}

interface ChatInputStubOptions {
  userId?: string;
  subcommand: 'add' | 'remove' | 'list';
  /** add: name option, remove: name option */
  name?: string | null;
  /** add: path option */
  path?: string | null;
  /** remove 時 `getString('name', true)` で null を返したい特殊ケース */
}

function makeChatInput(opts: ChatInputStubOptions): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
} {
  const { userId = 'user-1', subcommand, name = null, path = null } = opts;
  const reply = vi.fn().mockResolvedValue(undefined);
  const getString = vi.fn((key: string): string | null => {
    if (key === 'name') return name;
    if (key === 'path') return path;
    return null;
  });
  const interaction = {
    user: { id: userId },
    reply,
    options: {
      getSubcommand: () => subcommand,
      getString,
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

interface SelectMenuStubOptions {
  userId?: string;
  value: string;
}

function makeSelectMenu(opts: SelectMenuStubOptions): {
  interaction: StringSelectMenuInteraction;
  update: ReturnType<typeof vi.fn>;
} {
  const { userId = 'user-1', value } = opts;
  const update = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    user: { id: userId },
    values: [value],
    update,
  } as unknown as StringSelectMenuInteraction;
  return { interaction, update };
}

describe('createWorkspaceCommands', () => {
  let workspaceStore: WorkspaceStoreMock;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceStore = makeWorkspaceStore();
    mockedListDirectories.mockReturnValue([]);
  });

  function make() {
    return createWorkspaceCommands({
      workspaceStore: coerceStore(workspaceStore),
      workspaceBaseDir: '/base',
    });
  }

  it('browseCustomId は "cc_workspace_browse"', () => {
    const cmds = make();
    expect(cmds.browseCustomId).toBe('cc_workspace_browse');
  });

  describe('handleCommand — /cc workspace add', () => {
    it('name と path 指定 → workspaceStore.add が呼ばれ、成功メッセージを返す', async () => {
      const cmds = make();
      const { interaction, reply } = makeChatInput({
        subcommand: 'add',
        name: 'my-ws',
        path: '/home/user/project',
      });

      await cmds.handleCommand(interaction);

      expect(workspaceStore.add).toHaveBeenCalledWith({
        name: 'my-ws',
        path: '/home/user/project',
      });
      expect(reply).toHaveBeenCalledWith({
        content: '✅ ワークスペース「my-ws」を登録しました (/home/user/project)',
        ephemeral: true,
      });
    });

    it('path のみ指定 (name 省略) → basename(path) を name として登録する', async () => {
      const cmds = make();
      const { interaction, reply } = makeChatInput({
        subcommand: 'add',
        name: null,
        path: '/home/user/auto-named',
      });

      await cmds.handleCommand(interaction);

      expect(workspaceStore.add).toHaveBeenCalledWith({
        name: 'auto-named',
        path: '/home/user/auto-named',
      });
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('auto-named'),
          ephemeral: true,
        }),
      );
    });

    it('path 指定時に workspaceStore.add が例外を投げたら警告メッセージを返す', async () => {
      workspaceStore.add.mockImplementation(() => {
        throw new Error('既に登録されています');
      });
      const cmds = make();
      const { interaction, reply } = makeChatInput({
        subcommand: 'add',
        name: 'dup',
        path: '/tmp/dup',
      });

      await cmds.handleCommand(interaction);

      expect(reply).toHaveBeenCalledWith({
        content: '⚠️ 既に登録されています',
        ephemeral: true,
      });
    });

    it('path 指定時の add 例外が Error でなくても汎用メッセージにフォールバックする', async () => {
      workspaceStore.add.mockImplementation(() => {
        throw 'string error';
      });
      const cmds = make();
      const { interaction, reply } = makeChatInput({
        subcommand: 'add',
        name: 'x',
        path: '/tmp/x',
      });

      await cmds.handleCommand(interaction);

      expect(reply).toHaveBeenCalledWith({
        content: '⚠️ 登録に失敗しました',
        ephemeral: true,
      });
    });

    it('path 省略 → ブラウズ UI セレクトメニュー付きで reply する', async () => {
      mockedListDirectories.mockReturnValue(['projectA', 'projectB']);
      const cmds = make();
      const { interaction, reply } = makeChatInput({
        subcommand: 'add',
        name: 'custom-name',
        path: null,
      });

      await cmds.handleCommand(interaction);

      expect(workspaceStore.add).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(1);
      const call = reply.mock.calls[0][0];
      expect(call.content).toBe('📂 /base');
      expect(call.ephemeral).toBe(true);
      expect(Array.isArray(call.components)).toBe(true);
      expect(call.components).toHaveLength(1);
    });
  });

  describe('handleCommand — /cc workspace remove', () => {
    it('存在する name → 成功メッセージ', async () => {
      workspaceStore.remove.mockReturnValue(true);
      const cmds = make();
      const { interaction, reply } = makeChatInput({
        subcommand: 'remove',
        name: 'target',
      });

      await cmds.handleCommand(interaction);

      expect(workspaceStore.remove).toHaveBeenCalledWith('target');
      expect(reply).toHaveBeenCalledWith({
        content: '✅ ワークスペース「target」を削除しました',
        ephemeral: true,
      });
    });

    it('存在しない name → 警告メッセージ', async () => {
      workspaceStore.remove.mockReturnValue(false);
      const cmds = make();
      const { interaction, reply } = makeChatInput({
        subcommand: 'remove',
        name: 'missing',
      });

      await cmds.handleCommand(interaction);

      expect(reply).toHaveBeenCalledWith({
        content: '⚠️ ワークスペース「missing」が見つかりません',
        ephemeral: true,
      });
    });
  });

  describe('handleCommand — /cc workspace list', () => {
    it('0 件 → 登録促しメッセージ', async () => {
      workspaceStore.list.mockReturnValue([]);
      const cmds = make();
      const { interaction, reply } = makeChatInput({ subcommand: 'list' });

      await cmds.handleCommand(interaction);

      expect(reply).toHaveBeenCalledWith({
        content: 'ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
        ephemeral: true,
      });
    });

    it('複数件 → 連番付きの一覧メッセージ', async () => {
      workspaceStore.list.mockReturnValue([
        { name: 'alpha', path: '/a' },
        { name: 'beta', path: '/b' },
      ]);
      const cmds = make();
      const { interaction, reply } = makeChatInput({ subcommand: 'list' });

      await cmds.handleCommand(interaction);

      expect(reply).toHaveBeenCalledWith({
        content: '📁 登録済みワークスペース:\n1. **alpha** — /a\n2. **beta** — /b',
        ephemeral: true,
      });
    });
  });

  describe('handleBrowseSelect', () => {
    it('ブラウズ state が無い (期限切れ) → エラーメッセージを update', async () => {
      const cmds = make();
      const { interaction, update } = makeSelectMenu({ value: '__confirm__' });

      await cmds.handleBrowseSelect(interaction);

      expect(update).toHaveBeenCalledWith({
        content: 'ブラウズセッションが期限切れです。再度 `/cc workspace add` を実行してください。',
        components: [],
      });
      expect(workspaceStore.add).not.toHaveBeenCalled();
    });

    it('__confirm__ 選択 → customName があればそれを、無ければ basename を name として登録', async () => {
      const cmds = make();

      // まず add コマンドで state を仕込む
      const { interaction: addI } = makeChatInput({
        subcommand: 'add',
        name: 'override-name',
        path: null,
      });
      await cmds.handleCommand(addI);

      const { interaction: selI, update } = makeSelectMenu({ value: '__confirm__' });
      await cmds.handleBrowseSelect(selI);

      expect(workspaceStore.add).toHaveBeenCalledWith({
        name: 'override-name',
        path: '/base',
      });
      expect(update).toHaveBeenCalledWith({
        content: '✅ ワークスペース「override-name」を登録しました (/base)',
        components: [],
      });
    });

    it('__confirm__ 選択時に workspaceStore.add が例外を投げたら警告 update', async () => {
      workspaceStore.add.mockImplementation(() => {
        throw new Error('duplicate');
      });
      const cmds = make();
      const { interaction: addI } = makeChatInput({
        subcommand: 'add',
        name: null,
        path: null,
      });
      await cmds.handleCommand(addI);

      const { interaction: selI, update } = makeSelectMenu({ value: '__confirm__' });
      await cmds.handleBrowseSelect(selI);

      expect(update).toHaveBeenCalledWith({
        content: '⚠️ duplicate',
        components: [],
      });
    });

    it('__up__ 選択 → 親ディレクトリへ遷移したメニューを update', async () => {
      mockedListDirectories.mockReturnValue(['sub']);
      const cmds = createWorkspaceCommands({
        workspaceStore: coerceStore(workspaceStore),
        workspaceBaseDir: '/home/user/project',
      });

      // state を仕込む
      const { interaction: addI } = makeChatInput({
        subcommand: 'add',
        name: null,
        path: null,
      });
      await cmds.handleCommand(addI);

      const { interaction: selI, update } = makeSelectMenu({ value: '__up__' });
      await cmds.handleBrowseSelect(selI);

      expect(update).toHaveBeenCalledWith({
        content: '📂 /home/user',
        components: expect.any(Array),
      });
    });

    it('サブディレクトリ選択 → そのディレクトリに降りたメニューを update', async () => {
      mockedListDirectories.mockReturnValue(['foo', 'bar']);
      const cmds = make();

      const { interaction: addI } = makeChatInput({
        subcommand: 'add',
        name: null,
        path: null,
      });
      await cmds.handleCommand(addI);

      const { interaction: selI, update } = makeSelectMenu({ value: 'foo' });
      await cmds.handleBrowseSelect(selI);

      expect(update).toHaveBeenCalledWith({
        content: '📂 /base/foo',
        components: expect.any(Array),
      });
    });
  });

  describe('ブラウズメニュー構築の詳細', () => {
    it('listDirectories が 23 件超返しても 23 件までしかオプションに含めない', async () => {
      const manyDirs = Array.from({ length: 30 }, (_, i) => `dir${i}`);
      mockedListDirectories.mockReturnValue(manyDirs);
      const cmds = make();

      const { interaction, reply } = makeChatInput({
        subcommand: 'add',
        name: null,
        path: null,
      });
      await cmds.handleCommand(interaction);

      // row は components 配列の先頭、そこから options を取り出す
      const call = reply.mock.calls[0][0];
      const row = call.components[0];
      const selectMenu = row.components[0];
      // __confirm__ + __up__ + 23 サブディレクトリ = 最大 25 件
      expect(selectMenu.options.length).toBeLessThanOrEqual(25);
      expect(selectMenu.options.length).toBeGreaterThanOrEqual(24);
    });

    it('ルートディレクトリ (/) でブラウズ開始時は __up__ オプションを含まない', async () => {
      mockedListDirectories.mockReturnValue(['etc']);
      const cmds = createWorkspaceCommands({
        workspaceStore: coerceStore(workspaceStore),
        workspaceBaseDir: '/',
      });

      const { interaction, reply } = makeChatInput({
        subcommand: 'add',
        name: null,
        path: null,
      });
      await cmds.handleCommand(interaction);

      const call = reply.mock.calls[0][0];
      const selectMenu = call.components[0].components[0];
      const values = selectMenu.options.map((o: { data: { value: string } }) => o.data.value);
      expect(values).toContain('__confirm__');
      expect(values).not.toContain('__up__');
    });
  });
});
