import 'dotenv/config';
import { Client, ChannelType, Events, GatewayIntentBits, TextChannel } from 'discord.js';
import { createMessageHandler } from './app/message-handler.js';
import { AccessControl } from './domain/access-control.js';
import { SessionManager } from './domain/session-manager.js';
import { loadConfig } from './infrastructure/config.js';
import { SessionStore } from './infrastructure/session-store.js';
import { ccCommand } from './infrastructure/slash-commands.js';
import { TitleGenerator } from './infrastructure/title-generator.js';
import { ReportGenerator } from './infrastructure/report-generator.js';
import { UsageFetcher } from './infrastructure/usage-fetcher.js';
import { SessionRestorer } from './infrastructure/session-restorer.js';
import { ThreadMappingStore } from './infrastructure/thread-mapping-store.js';
import { TurnStore } from './infrastructure/turn-store.js';
import { SessionBrancher } from './infrastructure/session-brancher.js';
import { WorkspaceStore } from './infrastructure/workspace-store.js';
import { createSessionFactory, createPersistMapping } from './discord/session-factory.js';
import { createRewindHandler } from './discord/rewind-handler.js';
import { createMessageController } from './discord/message-controller.js';
import { createInterruptCommand } from './discord/commands/interrupt.js';
import { createNewCommand } from './discord/commands/new.js';
import { createReportCommand } from './discord/commands/report.js';
import { createResumeCommand } from './discord/commands/resume.js';
import { createWorkspaceCommands } from './discord/commands/workspace.js';
import { log } from './helpers.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // ワークスペース初期化
  const workspaceStore = new WorkspaceStore(config.workspacesFile);
  log(`ワークスペース: ${workspaceStore.list().length} 件登録済み`);

  // スレッド→セッションマッピングの永続化
  const threadMappingStore = new ThreadMappingStore(config.threadSessionsFile);
  log('スレッドセッションマッピングを読み込みました');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(config.discordToken);
  log('Discord に接続しました');

  // スラッシュコマンド登録
  await client.application!.commands.set([ccCommand]);
  log('スラッシュコマンド /cc を登録しました');

  const channel = await client.channels.fetch(config.channelId);
  if (!channel || !(channel instanceof TextChannel)) {
    throw new Error(`チャンネル ${config.channelId} が見つからないか、TextChannel ではありません`);
  }
  log(`チャンネル #${channel.name} を取得しました`);

  // ドメインオブジェクト
  const accessControl = new AccessControl({
    allowedUserIds: config.allowedUserIds,
    channelId: config.channelId,
  });
  const sessionManager = new SessionManager();
  const sessionStore = new SessionStore();
  const usageFetcher = new UsageFetcher();
  const titleGenerator = config.geminiApiKey ? new TitleGenerator(config.geminiApiKey) : null;
  const reportGenerator = config.geminiApiKey ? new ReportGenerator(config.geminiApiKey) : null;
  const turnStore = new TurnStore();
  const sessionBrancher = new SessionBrancher(turnStore);

  const createSession = createSessionFactory({
    config,
    sessionManager,
    usageFetcher,
    titleGenerator,
  });

  const sessionRestorer = new SessionRestorer({
    threadMappingStore,
    sessionManager,
    createSession,
    log,
  });

  const persistMapping = createPersistMapping(threadMappingStore);

  const rewindHandler = createRewindHandler({ turnStore, sessionBrancher, persistMapping });

  // App 層
  const handleMessage = createMessageHandler(accessControl, sessionManager);

  const messageController = createMessageController({
    sessionManager,
    sessionRestorer,
    rewindHandler,
    turnStore,
    handleMessage,
  });
  client.on(Events.MessageCreate, messageController);

  const interruptCommand = createInterruptCommand({ sessionManager });
  const newCommand = createNewCommand({
    workspaceStore,
    createSession,
    persistMapping,
    channel,
  });
  const reportCommand = createReportCommand({
    reportGenerator,
    workspaceStore,
    sessionStore,
    channel,
  });
  const resumeCommand = createResumeCommand({
    workspaceStore,
    sessionStore,
    turnStore,
    createSession,
    persistMapping,
    channel,
  });

  const workspaceCommands = createWorkspaceCommands({
    workspaceStore,
    workspaceBaseDir: config.workspaceBaseDir,
  });

  // スラッシュコマンドイベント
  client.on(Events.InteractionCreate, async (interaction) => {
    // オートコンプリートイベント（/cc report の date）
    if (interaction.isAutocomplete() && interaction.commandName === 'cc') {
      await reportCommand.handleAutocomplete(interaction);
      return;
    }

    // StringSelectMenu の選択イベント（/cc resume のセッション選択）
    if (interaction.isStringSelectMenu() && interaction.customId === resumeCommand.customId) {
      await resumeCommand.handleSelect(interaction);
      return;
    }

    // StringSelectMenu の選択イベント（/cc new のワークスペース選択）
    if (interaction.isStringSelectMenu() && interaction.customId === newCommand.customId) {
      await newCommand.handleSelect(interaction);
      return;
    }

    // StringSelectMenu の選択イベント（/cc workspace add のディレクトリブラウズ）
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === workspaceCommands.browseCustomId
    ) {
      await workspaceCommands.handleBrowseSelect(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'cc') return;

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    log(
      `コマンド受信: ${interaction.user.username} /cc ${subcommandGroup ? subcommandGroup + ' ' : ''}${subcommand}`,
    );

    // アクセス制御
    // スレッド内のコマンドは親チャンネルIDでチェックする
    const isThreadChannel =
      interaction.channel?.type === ChannelType.PublicThread ||
      interaction.channel?.type === ChannelType.PrivateThread;
    const checkChannelId =
      isThreadChannel && interaction.channel?.parentId
        ? interaction.channel.parentId
        : interaction.channelId;
    if (
      !accessControl.check({
        authorBot: false,
        authorId: interaction.user.id,
        channelId: checkChannelId,
      })
    ) {
      await interaction.reply({ content: '権限がありません', ephemeral: true });
      return;
    }

    // /cc workspace add|remove|list
    if (subcommandGroup === 'workspace') {
      await workspaceCommands.handleCommand(interaction);
      return;
    }

    // /cc new — スレッドを作成してセッションを登録
    if (subcommand === 'new') {
      await newCommand.handleCommand(interaction);
      return;
    }

    // /cc interrupt — スレッド内で実行した場合のみ処理
    if (subcommand === 'interrupt') {
      await interruptCommand(interaction);
      return;
    }

    // /cc report — 日報を生成（全ワークスペース横断）
    if (subcommand === 'report') {
      await reportCommand.handleCommand(interaction);
      return;
    }

    // /cc resume — 全ワークスペース横断でセッション一覧を表示
    if (subcommand === 'resume') {
      await resumeCommand.handleCommand(interaction);
      return;
    }
  });

  await channel.send('chat-agent-bridge を起動しました 🟢');
  log('chat-agent-bridge を起動しました');
}

main().catch(console.error);
