import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import type { Workspace } from '../../domain/types.js';
import type { ISessionStore } from '../../domain/types.js';
import type { IWorkspaceStore } from '../../infrastructure/workspace-store.js';
import type { TurnStore } from '../../infrastructure/turn-store.js';
import { formatRelativeDate, log } from '../../helpers.js';
import type { CreateSessionFn, PersistMappingFn } from '../session-factory.js';

/** StringSelectMenu の customId。`handleCommand` の setCustomId と InteractionCreate のディスパッチで共通に使う。 */
const CUSTOM_ID = 'cc_resume_select';

/** Discord の label 上限は 100 文字 */
const LABEL_MAX_LENGTH = 100;

/** Discord の description 上限も 100 文字 */
const DESCRIPTION_MAX_LENGTH = 100;

/** SelectMenu の選択肢上限 */
const SELECT_MENU_MAX_OPTIONS = 25;

export interface ResumeCommandDeps {
  workspaceStore: IWorkspaceStore;
  sessionStore: ISessionStore;
  turnStore: TurnStore;
  createSession: CreateSessionFn;
  persistMapping: PersistMappingFn;
  channel: TextChannel;
}

export interface ResumeCommand {
  /** SelectMenu の customId (`cc_resume_select`) */
  customId: string;
  /** `/cc resume` のサブコマンド応答: 全 WS 横断で上位 25 件を SelectMenu として提示する */
  handleCommand: (interaction: ChatInputCommandInteraction) => Promise<void>;
  /** SelectMenu 選択時: スレッドを作成しセッションを復元する */
  handleSelect: (interaction: StringSelectMenuInteraction) => Promise<void>;
}

/**
 * `/cc resume` と `cc_resume_select` を 1 ファイルに集約するファクトリ。
 *
 * 「コマンド → SelectMenu 選択」の 2 段階フロー:
 * 1. `handleCommand`: `deferReply` → 全ワークスペースからセッションを収集 →
 *    最終更新日降順で上位 25 件を SelectMenu として `editReply` で返す
 * 2. `handleSelect`: 選択された `workspaceName:sessionId` をパース → スレッド作成 →
 *    createSession → session.restore → turnStore.maxTurn → orchestrator.restoreTurnCount →
 *    persistMapping の順で復元し、`interaction.update` でユーザーにスレッドリンクを返す
 *
 * 詳細は docs/08_Resume_Session.md を参照。
 */
export function createResumeCommand(deps: ResumeCommandDeps): ResumeCommand {
  const { workspaceStore, sessionStore, turnStore, createSession, persistMapping, channel } = deps;

  const handleCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
    await interaction.deferReply({ ephemeral: true });

    try {
      const workspaces = workspaceStore.list();

      if (workspaces.length === 0) {
        await interaction.editReply(
          '⚠️ ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
        );
        return;
      }

      // 全ワークスペースからセッションを収集
      type SessionWithWorkspace = {
        workspace: Workspace;
        sessionId: string;
        firstUserMessage: string;
        slug: string | null;
        lastModified: Date;
      };
      const allSessions: SessionWithWorkspace[] = [];
      for (const ws of workspaces) {
        const sessions = await sessionStore.listSessions(ws.path);
        for (const s of sessions) {
          allSessions.push({ workspace: ws, ...s });
        }
      }

      // lastModified 降順でソートし、上位 25 件
      allSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
      const top = allSessions.slice(0, SELECT_MENU_MAX_OPTIONS);

      if (top.length === 0) {
        await interaction.editReply('再開できるセッションがありません');
        return;
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(CUSTOM_ID)
        .setPlaceholder('セッションを選択してください')
        .addOptions(
          top.map((s) => {
            const prefix = `[${s.workspace.name}] `;
            const cleanMsg = s.firstUserMessage.replace(/\s+/g, ' ').trim();
            const maxLabelLen = LABEL_MAX_LENGTH - prefix.length;
            const baseLabel = s.slug
              ? s.slug.length > maxLabelLen
                ? s.slug.slice(0, maxLabelLen - 3) + '...'
                : s.slug
              : cleanMsg.length > maxLabelLen
                ? cleanMsg.slice(0, maxLabelLen - 3) + '...'
                : cleanMsg || '(空のメッセージ)';
            const label = prefix + baseLabel;
            const desc = s.slug
              ? cleanMsg.length > DESCRIPTION_MAX_LENGTH
                ? cleanMsg.slice(0, DESCRIPTION_MAX_LENGTH - 3) + '...'
                : cleanMsg
              : formatRelativeDate(s.lastModified);
            return {
              label,
              description: desc || formatRelativeDate(s.lastModified),
              value: `${s.workspace.name}:${s.sessionId}`,
            };
          }),
        );

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      await interaction.editReply({
        content: '再開するセッションを選択してください:',
        components: [row],
      });
    } catch (err) {
      console.error('Resume session list error:', err);
      await interaction.editReply('セッション一覧の取得に失敗しました');
    }
  };

  const handleSelect = async (interaction: StringSelectMenuInteraction): Promise<void> => {
    // value 形式: "workspaceName:sessionId"
    // WorkspaceStore の NAME_PATTERN = /^[a-zA-Z0-9_-]+$/ によりワークスペース名にコロンは含まれず、
    // sessionId (UUID) にもコロンは含まれないため indexOf(':') で安全に分割できる
    const rawValue = interaction.values[0];
    const sepIdx = rawValue.indexOf(':');
    const wsName = rawValue.slice(0, sepIdx);
    const selectedSessionId = rawValue.slice(sepIdx + 1);
    const workspace = workspaceStore.findByName(wsName);

    log(
      `セッション選択: ${interaction.user.username} [${wsName}] ${selectedSessionId.slice(0, 8)}...`,
    );

    if (!workspace) {
      await interaction.update({
        content: `ワークスペース「${wsName}」が見つかりません`,
        components: [],
      });
      return;
    }

    try {
      const thread = await channel.threads.create({
        name: `[${workspace.name}] Session: ${selectedSessionId.slice(0, 8)}... (再開)`,
        autoArchiveDuration: 60,
      });

      const ctx = createSession(thread.id, thread, workspace);
      ctx.session.restore(selectedSessionId);

      // ターンカウンタを復元
      const maxTurn = await turnStore.maxTurn(selectedSessionId, workspace.path);
      ctx.orchestrator.restoreTurnCount(maxTurn);

      await persistMapping(thread.id, selectedSessionId, workspace);

      await thread.send(
        `セッションを再開しました [\`${selectedSessionId.slice(0, 8)}\`] — 📁 ${workspace.name}`,
      );

      await interaction.update({
        content: `セッション \`${selectedSessionId.slice(0, 8)}...\` を再開しました → <#${thread.id}>`,
        components: [],
      });
    } catch (err) {
      console.error('Resume session error:', err);
      await interaction.update({
        content: 'セッションの再開に失敗しました',
        components: [],
      });
    }
  };

  return {
    customId: CUSTOM_ID,
    handleCommand,
    handleSelect,
  };
}
