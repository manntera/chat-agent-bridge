import { basename, dirname, join } from 'node:path';
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { WorkspaceStore } from '../../infrastructure/workspace-store.js';
import { listDirectories } from '../../infrastructure/workspace-store.js';

const BROWSE_CUSTOM_ID = 'cc_workspace_browse';

export interface WorkspaceCommandsDeps {
  workspaceStore: WorkspaceStore;
  workspaceBaseDir: string;
}

export interface WorkspaceCommands {
  browseCustomId: string;
  handleCommand: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleBrowseSelect: (interaction: StringSelectMenuInteraction) => Promise<void>;
}

/**
 * `/cc workspace add/remove/list` サブコマンドと `cc_workspace_browse` セレクトメニューの
 * ハンドラを生成する。ディレクトリブラウズ中のユーザー状態 (`browsingState`) はこの
 * ファクトリの module-level クロージャに閉じ、外部に漏らさない。
 *
 * - `handleCommand(interaction)` — `/cc workspace add/remove/list` を処理
 * - `handleBrowseSelect(interaction)` — `cc_workspace_browse` セレクトの選択を処理
 * - `browseCustomId` — ディスパッチ側で customId 判定に使うための公開定数
 */
export function createWorkspaceCommands(deps: WorkspaceCommandsDeps): WorkspaceCommands {
  const { workspaceStore, workspaceBaseDir } = deps;

  // /cc workspace add のディレクトリブラウズ状態を一時保持
  const browsingState = new Map<string, { currentPath: string; customName?: string }>();

  /** ディレクトリブラウズ用のセレクトメニューを構築する */
  function buildBrowseMenu(currentPath: string): ActionRowBuilder<StringSelectMenuBuilder> | null {
    const dirs = listDirectories(currentPath);
    const options: Array<{ label: string; description: string; value: string }> = [];

    // 現在のディレクトリを登録する選択肢
    options.push({
      label: `${basename(currentPath)} をワークスペースに登録`,
      description: currentPath,
      value: '__confirm__',
    });

    // 上のディレクトリへ（ルートでない場合）
    if (dirname(currentPath) !== currentPath) {
      options.push({
        label: '.. (上のディレクトリへ)',
        description: dirname(currentPath),
        value: '__up__',
      });
    }

    // サブディレクトリ（最大23件 — confirm + up で2枠使用、合計25が上限）
    for (const dir of dirs.slice(0, 23)) {
      const fullPath = join(currentPath, dir);
      options.push({
        label: dir,
        description: fullPath.length > 100 ? '...' + fullPath.slice(-97) : fullPath,
        value: dir,
      });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(BROWSE_CUSTOM_ID)
      .setPlaceholder('ディレクトリを選択してください')
      .addOptions(options);

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  }

  async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const name = interaction.options.getString('name') ?? undefined;
      const path = interaction.options.getString('path') ?? undefined;

      // path が指定されている場合は直接登録
      if (path) {
        const wsName = name || basename(path);
        try {
          workspaceStore.add({ name: wsName, path });
          await interaction.reply({
            content: `✅ ワークスペース「${wsName}」を登録しました (${path})`,
            ephemeral: true,
          });
        } catch (err) {
          await interaction.reply({
            content: `⚠️ ${err instanceof Error ? err.message : '登録に失敗しました'}`,
            ephemeral: true,
          });
        }
        return;
      }

      // path 省略 → ディレクトリブラウズモード
      const startPath = workspaceBaseDir;
      browsingState.set(interaction.user.id, { currentPath: startPath, customName: name });

      const row = buildBrowseMenu(startPath);
      if (row) {
        await interaction.reply({
          content: `📂 ${startPath}`,
          components: [row],
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: '⚠️ ベースディレクトリの読み取りに失敗しました',
          ephemeral: true,
        });
      }
      return;
    }

    if (subcommand === 'remove') {
      const name = interaction.options.getString('name', true);
      const removed = workspaceStore.remove(name);
      if (removed) {
        await interaction.reply({
          content: `✅ ワークスペース「${name}」を削除しました`,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: `⚠️ ワークスペース「${name}」が見つかりません`,
          ephemeral: true,
        });
      }
      return;
    }

    if (subcommand === 'list') {
      const workspaces = workspaceStore.list();
      if (workspaces.length === 0) {
        await interaction.reply({
          content: 'ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
          ephemeral: true,
        });
      } else {
        const lines = workspaces.map((w, i) => `${i + 1}. **${w.name}** — ${w.path}`);
        await interaction.reply({
          content: `📁 登録済みワークスペース:\n${lines.join('\n')}`,
          ephemeral: true,
        });
      }
      return;
    }
  }

  async function handleBrowseSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const selected = interaction.values[0];
    const state = browsingState.get(interaction.user.id);

    if (!state) {
      await interaction.update({
        content: 'ブラウズセッションが期限切れです。再度 `/cc workspace add` を実行してください。',
        components: [],
      });
      return;
    }

    if (selected === '__confirm__') {
      // 現在のディレクトリをワークスペースとして登録
      const wsName = state.customName || basename(state.currentPath);
      browsingState.delete(interaction.user.id);
      try {
        workspaceStore.add({ name: wsName, path: state.currentPath });
        await interaction.update({
          content: `✅ ワークスペース「${wsName}」を登録しました (${state.currentPath})`,
          components: [],
        });
      } catch (err) {
        await interaction.update({
          content: `⚠️ ${err instanceof Error ? err.message : '登録に失敗しました'}`,
          components: [],
        });
      }
      return;
    }

    if (selected === '__up__') {
      state.currentPath = dirname(state.currentPath);
    } else {
      state.currentPath = join(state.currentPath, selected);
    }

    const row = buildBrowseMenu(state.currentPath);
    if (row) {
      await interaction.update({
        content: `📂 ${state.currentPath}`,
        components: [row],
      });
    } else {
      await interaction.update({
        content: `⚠️ ディレクトリの読み取りに失敗しました`,
        components: [],
      });
    }
  }

  return {
    browseCustomId: BROWSE_CUSTOM_ID,
    handleCommand,
    handleBrowseSelect,
  };
}
