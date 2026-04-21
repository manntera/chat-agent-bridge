import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import { toCommand } from '../../app/interaction-handler.js';
import { Session } from '../../domain/session.js';
import type { SessionOptions, Workspace } from '../../domain/types.js';
import type { IWorkspaceStore } from '../../infrastructure/workspace-store.js';
import { log } from '../../helpers.js';
import type { CreateSessionFn, PersistMappingFn } from '../session-factory.js';

/** /cc new のワークスペース選択メニュー customId。 */
const CUSTOM_ID = 'cc_workspace_select';

/**
 * /cc new 完了前のコマンドオプションを user 単位で一時保持する。
 *
 * ワークスペースが 2 件以上ある場合のみ使用する経路で、SelectMenu に
 * interaction.customId + 値のみしか渡せない discord.js の制約を回避するため
 * module-level に閉じたマップとして運用する。
 */
const pendingNewOptions = new Map<string, SessionOptions>();

export interface NewCommandDeps {
  workspaceStore: IWorkspaceStore;
  createSession: CreateSessionFn;
  persistMapping: PersistMappingFn;
  channel: Pick<TextChannel, 'threads'>;
}

export interface NewCommand {
  /** ワークスペース選択 StringSelectMenu の customId。外側のディスパッチから参照する。 */
  readonly customId: string;
  /** `/cc new` サブコマンドのエントリーポイント。 */
  handleCommand(interaction: ChatInputCommandInteraction): Promise<void>;
  /** `cc_workspace_select` StringSelectMenu のハンドラ。 */
  handleSelect(interaction: StringSelectMenuInteraction): Promise<void>;
}

/**
 * `/cc new` + `cc_workspace_select` + pendingNewOptions の 3 要素を
 * 1 つのコマンドモジュールに集約するファクトリ。
 *
 * ## 2 段階 sessionId 生成について
 *
 * スレッド名用にまず `new Session(...).ensure(opts)` で sessionId を先行生成し、
 * 続いて `createSession()` が内部で別の Session インスタンスを作り直したあと
 * `ctx.session.reset()` → `ctx.session.ensure(opts)` で Claude プロセスの
 * 実 sessionId を発行する。結果としてスレッド名と実 sessionId は別 UUID に
 * なるが、本 Step は「ロジックをそのまま切り出す」スコープなのでこの挙動は
 * 維持する (統合は後続 issue)。
 */
export function createNewCommand(deps: NewCommandDeps): NewCommand {
  const { workspaceStore, createSession, persistMapping, channel } = deps;

  function buildOptionsSuffix(opts: SessionOptions): string {
    const details: string[] = [];
    if (opts.model) details.push(opts.model);
    if (opts.effort) details.push(opts.effort);
    return details.length > 0 ? ` (${details.join(', ')})` : '';
  }

  function buildThreadName(workspace: Workspace, sessionId: string, opts: SessionOptions): string {
    return `[${workspace.name}] Session: ${sessionId.slice(0, 8)}${buildOptionsSuffix(opts)}`;
  }

  function buildStartMessage(
    workspace: Workspace,
    sessionId: string,
    opts: SessionOptions,
  ): string {
    return `セッションを開始しました [\`${sessionId.slice(0, 8)}\`] — 📁 ${workspace.name}${buildOptionsSuffix(opts)}`;
  }

  /**
   * 指定ワークスペースでスレッドを作成し、createSession で SessionContext を
   * 登録、マッピングを永続化、スレッドに開始メッセージを投稿する。
   *
   * index.ts 時代の `/cc new` (WS 1件経路) および `cc_workspace_select` 経路で
   * 共通していた後半処理をまとめたもの。内部で Session を 2 度生成する挙動は
   * 意図的に維持している (ファイル冒頭 JSDoc 参照)。
   */
  async function createThreadAndSession(
    workspace: Workspace,
    opts: SessionOptions,
  ): Promise<{ threadId: string; threadName: string }> {
    const session = new Session(workspace.path, workspace.name);
    session.ensure(opts);
    const sessionId = session.sessionId!;
    const threadName = buildThreadName(workspace, sessionId, opts);

    const thread = await channel.threads.create({ name: threadName, autoArchiveDuration: 60 });
    const ctx = createSession(thread.id, thread, workspace);
    // createSession 内で新しい Session を作るが、options を引き継ぐために上書き
    ctx.session.reset();
    ctx.session.ensure(opts);

    await persistMapping(thread.id, ctx.session.sessionId!, workspace);

    await thread.send(buildStartMessage(workspace, ctx.session.sessionId!, opts));

    return { threadId: thread.id, threadName: thread.name };
  }

  return {
    customId: CUSTOM_ID,

    async handleCommand(interaction) {
      const command = toCommand({
        authorBot: false,
        authorId: interaction.user.id,
        channelId: interaction.channelId,
        subcommand: 'new',
        model: interaction.options.getString('model') ?? undefined,
        effort: interaction.options.getString('effort') ?? undefined,
        threadId: null,
      });
      if (!command || command.type !== 'new') return;

      const workspaces = workspaceStore.list();

      // ワークスペースが 0 件
      if (workspaces.length === 0) {
        await interaction.reply({
          content:
            '⚠️ ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
          ephemeral: true,
        });
        return;
      }

      // ワークスペースが 2 件以上 → セレクトメニュー
      if (workspaces.length >= 2) {
        // options を一時保存
        pendingNewOptions.set(interaction.user.id, command.options);

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(CUSTOM_ID)
          .setPlaceholder('ワークスペースを選択してください')
          .addOptions(
            workspaces.map((w) => ({
              label: w.name,
              description: w.path,
              value: w.name,
            })),
          );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        await interaction.reply({
          content: '作業ディレクトリを選択してください:',
          components: [row],
          ephemeral: true,
        });
        return;
      }

      // ワークスペースが 1 件 → 自動選択
      const workspace = workspaces[0];
      try {
        const { threadId, threadName } = await createThreadAndSession(workspace, command.options);

        await interaction.reply({
          content: `セッションを作成しました → <#${threadId}>`,
          ephemeral: true,
        });

        log(`スレッド作成: ${threadName} (${threadId})`);
      } catch (err) {
        console.error('Thread creation error:', err);
        await interaction.reply({ content: 'スレッドの作成に失敗しました', ephemeral: true });
      }
    },

    async handleSelect(interaction) {
      const wsName = interaction.values[0];
      const workspace = workspaceStore.findByName(wsName);

      if (!workspace) {
        await interaction.update({
          content: `ワークスペース「${wsName}」が見つかりません`,
          components: [],
        });
        return;
      }

      const pending = pendingNewOptions.get(interaction.user.id);
      pendingNewOptions.delete(interaction.user.id);

      try {
        const opts = pending ?? {};
        const { threadId, threadName } = await createThreadAndSession(workspace, opts);

        await interaction.update({
          content: `セッションを作成しました → <#${threadId}>`,
          components: [],
        });

        log(`スレッド作成: ${threadName} (${threadId})`);
      } catch (err) {
        console.error('Thread creation error:', err);
        await interaction.update({
          content: 'スレッドの作成に失敗しました',
          components: [],
        });
      }
    },
  };
}

/**
 * テスト専用ユーティリティ: module-level の pendingNewOptions Map をクリアする。
 * プロダクションコードから呼ばない (名前の `__` と `ForTesting` で意図を示す)。
 */
export function __resetPendingOptionsForTesting(): void {
  pendingNewOptions.clear();
}
