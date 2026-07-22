import { basename, dirname, join } from 'node:path';
import {
  ActionRowBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
  TextChannel,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { ccCommandSpec, SELECT_IDS, VALID_EFFORTS } from '../../app/commands.js';
import type { BridgeApp } from '../../app/use-cases.js';
import type { AccessControl } from '../../core/access-control.js';
import type { ConversationRef, Effort, SessionOptions, Workspace } from '../../core/types.js';
import type { WorkspaceStore } from '../../services/workspace-store.js';
import { listDirectories } from '../../services/workspace-store.js';
import { formatRelativeDate, generateDateChoices, log } from '../../helpers.js';
import { buildSlashCommand } from './command-ui.js';
import {
  DiscordHandle,
  DISCORD_MESSAGE_LIMIT,
  splitMessage,
  type DiscordThreadLike,
} from './renderer.js';

/**
 * Discord アダプタ。
 *
 * 責務は「Discord のイベント → BridgeApp の呼び出し → 結果の描画」の翻訳のみ。
 * 会話の状態管理・巻き戻し・永続化はすべて app / core 層にある。
 * SelectMenu の customId・ブラウズ中のカーソル位置など、UI にしか存在しない
 * 一時状態だけをこのファイルで保持する。
 */

export interface DiscordConfig {
  token: string;
  channelId: string;
}

export interface DiscordAdapterDeps {
  app: BridgeApp;
  accessControl: AccessControl;
  workspaceStore: WorkspaceStore;
  workspaceBaseDir: string;
}

const LABEL_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 100;

function discordRef(threadId: string): ConversationRef {
  return { platform: 'discord', id: threadId };
}

function isThreadChannel(type: ChannelType | undefined): boolean {
  return type === ChannelType.PublicThread || type === ChannelType.PrivateThread;
}

function parseSessionOptions(interaction: ChatInputCommandInteraction): SessionOptions {
  const options: SessionOptions = {};
  const model = interaction.options.getString('model');
  const effort = interaction.options.getString('effort');
  if (model) options.model = model;
  if (effort && VALID_EFFORTS.has(effort)) options.effort = effort as Effort;
  return options;
}

function optionsSuffix(options: SessionOptions): string {
  const details: string[] = [];
  if (options.model) details.push(options.model);
  if (options.effort) details.push(options.effort);
  return details.length > 0 ? ` (${details.join(', ')})` : '';
}

export async function startDiscordAdapter(
  config: DiscordConfig,
  deps: DiscordAdapterDeps,
): Promise<void> {
  const { app, accessControl, workspaceStore, workspaceBaseDir } = deps;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(config.token);
  log('Discord に接続しました');

  await client.application!.commands.set([buildSlashCommand(ccCommandSpec).toJSON()]);
  log(`スラッシュコマンド /${ccCommandSpec.name} を登録しました`);

  const fetched = await client.channels.fetch(config.channelId);
  if (!fetched || !(fetched instanceof TextChannel)) {
    throw new Error(`チャンネル ${config.channelId} が見つからないか、TextChannel ではありません`);
  }
  // 関数宣言(巻き上げ)内から参照するため、narrowing 済みの型で別 const に束縛する
  const channel: TextChannel = fetched;
  log(`チャンネル #${channel.name} を取得しました`);

  // ---- UI 一時状態(アダプタローカル) ----
  const pendingNewOptions = new Map<string, SessionOptions>();
  const browsingState = new Map<string, { currentPath: string; customName?: string }>();

  // ---- 共通処理 ----

  async function createThreadAndConversation(
    workspace: Workspace,
    options: SessionOptions,
  ): Promise<{ threadId: string; threadName: string }> {
    const sessionId = app.createSessionId();
    const threadName = `[${workspace.name}] Session: ${sessionId.slice(0, 8)}${optionsSuffix(options)}`;
    const thread = await channel.threads.create({ name: threadName, autoArchiveDuration: 60 });
    const handle = new DiscordHandle(discordRef(thread.id), thread as DiscordThreadLike);
    app.openConversation(handle.ref, handle, workspace, options, sessionId);
    log(`スレッド作成: ${threadName} (${thread.id})`);
    return { threadId: thread.id, threadName };
  }

  // ---- メッセージ受信 ----

  client.on(Events.MessageCreate, async (msg: Message) => {
    if (!isThreadChannel(msg.channel.type)) return;
    const parentChannelId = 'parentId' in msg.channel ? msg.channel.parentId : null;
    if (!parentChannelId) return;

    const handle = new DiscordHandle(
      discordRef(msg.channelId),
      msg.channel as unknown as DiscordThreadLike,
    );

    await app.handleInbound(
      {
        ref: handle.ref,
        authorId: msg.author.id,
        authorIsBot: msg.author.bot,
        channelId: parentChannelId,
        text: msg.content,
        attachments: [...msg.attachments.values()].map((a) => ({
          contentType: a.contentType,
          name: a.name,
          size: a.size,
          url: a.url,
        })),
        platformMessageId: msg.id,
        replyToMessageId: msg.reference?.messageId ?? null,
      },
      handle,
    );
  });

  // ---- /cc new ----

  async function handleNewCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const options = parseSessionOptions(interaction);
    const workspaces = workspaceStore.list();

    if (workspaces.length === 0) {
      await interaction.reply({
        content: '⚠️ ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (workspaces.length >= 2) {
      pendingNewOptions.set(interaction.user.id, options);
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(SELECT_IDS.workspaceForNew)
        .setPlaceholder('ワークスペースを選択してください')
        .addOptions(workspaces.map((w) => ({ label: w.name, description: w.path, value: w.name })));
      await interaction.reply({
        content: '作業ディレクトリを選択してください:',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const { threadId } = await createThreadAndConversation(workspaces[0], options);
      await interaction.reply({
        content: `セッションを作成しました → <#${threadId}>`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      console.error('Thread creation error:', err);
      await interaction.reply({
        content: 'スレッドの作成に失敗しました',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  async function handleNewWorkspaceSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const wsName = interaction.values[0];
    const workspace = workspaceStore.findByName(wsName);
    if (!workspace) {
      await interaction.update({
        content: `ワークスペース「${wsName}」が見つかりません`,
        components: [],
      });
      return;
    }

    const options = pendingNewOptions.get(interaction.user.id) ?? {};
    pendingNewOptions.delete(interaction.user.id);

    try {
      const { threadId } = await createThreadAndConversation(workspace, options);
      await interaction.update({
        content: `セッションを作成しました → <#${threadId}>`,
        components: [],
      });
    } catch (err) {
      console.error('Thread creation error:', err);
      await interaction.update({ content: 'スレッドの作成に失敗しました', components: [] });
    }
  }

  // ---- /cc resume ----

  async function handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (workspaceStore.list().length === 0) {
        await interaction.editReply(
          '⚠️ ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
        );
        return;
      }

      const sessions = await app.listResumableSessions();
      if (sessions.length === 0) {
        await interaction.editReply('再開できるセッションがありません');
        return;
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(SELECT_IDS.resumeSession)
        .setPlaceholder('セッションを選択してください')
        .addOptions(
          sessions.map((s) => {
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
            const desc = s.slug
              ? cleanMsg.length > DESCRIPTION_MAX_LENGTH
                ? cleanMsg.slice(0, DESCRIPTION_MAX_LENGTH - 3) + '...'
                : cleanMsg
              : formatRelativeDate(s.lastModified);
            return {
              label: prefix + baseLabel,
              description: desc || formatRelativeDate(s.lastModified),
              value: `${s.workspace.name}:${s.sessionId}`,
            };
          }),
        );

      await interaction.editReply({
        content: '再開するセッションを選択してください:',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)],
      });
    } catch (err) {
      console.error('Resume session list error:', err);
      await interaction.editReply('セッション一覧の取得に失敗しました');
    }
  }

  async function handleResumeSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    // value 形式: "workspaceName:sessionId"(ワークスペース名にコロンは含まれない)
    const rawValue = interaction.values[0];
    const sepIdx = rawValue.indexOf(':');
    const wsName = rawValue.slice(0, sepIdx);
    const sessionId = rawValue.slice(sepIdx + 1);
    const workspace = workspaceStore.findByName(wsName);

    log(`セッション選択: ${interaction.user.username} [${wsName}] ${sessionId.slice(0, 8)}...`);

    if (!workspace) {
      await interaction.update({
        content: `ワークスペース「${wsName}」が見つかりません`,
        components: [],
      });
      return;
    }

    try {
      const thread = await channel.threads.create({
        name: `[${workspace.name}] Session: ${sessionId.slice(0, 8)}... (再開)`,
        autoArchiveDuration: 60,
      });
      const handle = new DiscordHandle(discordRef(thread.id), thread as DiscordThreadLike);
      await app.resumeConversation(handle.ref, handle, workspace, sessionId);

      await interaction.update({
        content: `セッション \`${sessionId.slice(0, 8)}...\` を再開しました → <#${thread.id}>`,
        components: [],
      });
    } catch (err) {
      console.error('Resume session error:', err);
      await interaction.update({ content: 'セッションの再開に失敗しました', components: [] });
    }
  }

  // ---- /cc interrupt ----

  async function handleInterruptCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isThreadChannel(interaction.channel?.type)) {
      await interaction.reply({
        content: 'セッションスレッド内で実行してください',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = app.interrupt(discordRef(interaction.channelId));
    const replies = {
      ok: '✅',
      'already-interrupting': '既に中断処理中です',
      'not-busy': '処理中ではありません',
      'no-session': 'このスレッドにはセッションが紐づいていません',
    } as const;
    await interaction.reply({ content: replies[result], flags: MessageFlags.Ephemeral });
  }

  // ---- /cc report ----

  async function handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    try {
      const result = await app.generateReport(interaction.options.getString('date'));
      if (!result.ok) {
        await interaction.editReply(result.message);
        return;
      }
      const chunks = splitMessage(result.report, DISCORD_MESSAGE_LIMIT);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await channel.send(chunks[i]);
      }
    } catch (err) {
      console.error('Report generation error:', err);
      await interaction.editReply('⚠️ 日報の生成中にエラーが発生しました');
    }
  }

  async function handleReportAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'date') return;
    const choices = generateDateChoices();
    const input = focused.value.toLowerCase();
    const filtered = input
      ? choices.filter((c) => c.name.includes(input) || c.value.includes(input))
      : choices;
    await interaction.respond(filtered.slice(0, 25));
  }

  // ---- /cc workspace ----

  function buildBrowseMenu(currentPath: string): ActionRowBuilder<StringSelectMenuBuilder> {
    const dirs = listDirectories(currentPath);
    const options: Array<{ label: string; description: string; value: string }> = [];

    options.push({
      label: `${basename(currentPath)} をワークスペースに登録`,
      description: currentPath,
      value: '__confirm__',
    });

    if (dirname(currentPath) !== currentPath) {
      options.push({
        label: '.. (上のディレクトリへ)',
        description: dirname(currentPath),
        value: '__up__',
      });
    }

    // サブディレクトリ(最大23件 — confirm + up で2枠使用、合計25が上限)
    for (const dir of dirs.slice(0, 23)) {
      const fullPath = join(currentPath, dir);
      options.push({
        label: dir,
        description: fullPath.length > 100 ? '...' + fullPath.slice(-97) : fullPath,
        value: dir,
      });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(SELECT_IDS.workspaceBrowse)
      .setPlaceholder('ディレクトリを選択してください')
      .addOptions(options);

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  }

  async function handleWorkspaceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const name = interaction.options.getString('name') ?? undefined;
      const path = interaction.options.getString('path') ?? undefined;

      if (path) {
        const wsName = name || basename(path);
        try {
          workspaceStore.add({ name: wsName, path });
          await interaction.reply({
            content: `✅ ワークスペース「${wsName}」を登録しました (${path})`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) {
          await interaction.reply({
            content: `⚠️ ${err instanceof Error ? err.message : '登録に失敗しました'}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      browsingState.set(interaction.user.id, { currentPath: workspaceBaseDir, customName: name });
      await interaction.reply({
        content: `📂 ${workspaceBaseDir}`,
        components: [buildBrowseMenu(workspaceBaseDir)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'remove') {
      const name = interaction.options.getString('name', true);
      const removed = workspaceStore.remove(name);
      await interaction.reply({
        content: removed
          ? `✅ ワークスペース「${name}」を削除しました`
          : `⚠️ ワークスペース「${name}」が見つかりません`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'list') {
      const workspaces = workspaceStore.list();
      if (workspaces.length === 0) {
        await interaction.reply({
          content: 'ワークスペースが登録されていません。`/cc workspace add` で登録してください。',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const lines = workspaces.map((w, i) => `${i + 1}. **${w.name}** — ${w.path}`);
        await interaction.reply({
          content: `📁 登録済みワークスペース:\n${lines.join('\n')}`,
          flags: MessageFlags.Ephemeral,
        });
      }
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

    state.currentPath =
      selected === '__up__' ? dirname(state.currentPath) : join(state.currentPath, selected);

    await interaction.update({
      content: `📂 ${state.currentPath}`,
      components: [buildBrowseMenu(state.currentPath)],
    });
  }

  // ---- インタラクションのディスパッチ ----

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete() && interaction.commandName === ccCommandSpec.name) {
      await handleReportAutocomplete(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      switch (interaction.customId) {
        case SELECT_IDS.resumeSession:
          await handleResumeSelect(interaction);
          return;
        case SELECT_IDS.workspaceForNew:
          await handleNewWorkspaceSelect(interaction);
          return;
        case SELECT_IDS.workspaceBrowse:
          await handleBrowseSelect(interaction);
          return;
        default:
          return;
      }
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== ccCommandSpec.name) return;

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    log(
      `コマンド受信: ${interaction.user.username} /${ccCommandSpec.name} ${subcommandGroup ? subcommandGroup + ' ' : ''}${subcommand}`,
    );

    // スレッド内のコマンドは親チャンネル ID でアクセス制御する
    const checkChannelId =
      isThreadChannel(interaction.channel?.type) &&
      interaction.channel &&
      'parentId' in interaction.channel &&
      interaction.channel.parentId
        ? interaction.channel.parentId
        : interaction.channelId;
    if (
      !accessControl.check({
        authorBot: false,
        authorId: interaction.user.id,
        channelId: checkChannelId,
      })
    ) {
      await interaction.reply({ content: '権限がありません', flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommandGroup === 'workspace') {
      await handleWorkspaceCommand(interaction);
      return;
    }

    switch (subcommand) {
      case 'new':
        await handleNewCommand(interaction);
        break;
      case 'interrupt':
        await handleInterruptCommand(interaction);
        break;
      case 'report':
        await handleReportCommand(interaction);
        break;
      case 'resume':
        await handleResumeCommand(interaction);
        break;
    }
  });

  await channel.send('chat-agent-bridge を起動しました 🟢');
  log('chat-agent-bridge を起動しました');
}
