import 'dotenv/config';
import { Client, ChannelType, Events, GatewayIntentBits, TextChannel } from 'discord.js';
import { createMessageHandler } from './app/message-handler.js';
import { AccessControl } from './domain/access-control.js';
import { SessionManager } from './domain/session-manager.js';
import type { Workspace } from './domain/types.js';
import { loadConfig } from './infrastructure/config.js';
import { SessionStore } from './infrastructure/session-store.js';
import { ccCommand } from './infrastructure/slash-commands.js';
import { TitleGenerator } from './infrastructure/title-generator.js';
import { ReportGenerator } from './infrastructure/report-generator.js';
import type { DailySession } from './infrastructure/report-generator.js';
import { readSession } from './infrastructure/session-reader.js';
import { getDayBoundary } from './infrastructure/session-store.js';
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
import { createResumeCommand } from './discord/commands/resume.js';
import { createWorkspaceCommands } from './discord/commands/workspace.js';
import { todayJST, parseDateInput, generateDateChoices, log } from './helpers.js';

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
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'date') {
        const choices = generateDateChoices();
        const input = focused.value.toLowerCase();
        const filtered = input
          ? choices.filter((c) => c.name.includes(input) || c.value.includes(input))
          : choices;
        await interaction.respond(filtered.slice(0, 25));
      }
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
      if (!reportGenerator) {
        await interaction.reply({
          content: '⚠️ 日報生成には GEMINI_API_KEY の設定が必要です',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      try {
        const dateStr = interaction.options.getString('date');
        let targetDate: Date;

        if (dateStr) {
          const parsed = parseDateInput(dateStr);
          if (!parsed) {
            await interaction.editReply(
              '⚠️ 日付の形式が不正です（YYYY-MM-DD または -1, -2 等の相対指定で入力してください）',
            );
            return;
          }
          targetDate = parsed;
        } else {
          targetDate = todayJST();
        }

        const { from, to } = getDayBoundary(targetDate);

        // 全ワークスペースからセッションを収集
        const workspaces = workspaceStore.list();
        const allSessions: Array<{
          workspace: Workspace;
          sessions: Awaited<ReturnType<typeof sessionStore.listSessionsByDateRange>>;
        }> = [];
        for (const ws of workspaces) {
          const sessions = await sessionStore.listSessionsByDateRange(ws.path, from, to);
          if (sessions.length > 0) {
            allSessions.push({ workspace: ws, sessions });
          }
        }

        const totalCount = allSessions.reduce((sum, e) => sum + e.sessions.length, 0);
        if (totalCount === 0) {
          const dateLabel =
            dateStr ?? targetDate.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
          await interaction.editReply(`⚠️ ${dateLabel} のセッションが見つかりません`);
          return;
        }

        log(`日報生成開始: ${totalCount} セッション (${allSessions.length} ワークスペース)`);

        // 各セッションの会話を読み込み
        const dailySessions: DailySession[] = [];
        for (const { workspace: ws, sessions } of allSessions) {
          for (const s of sessions) {
            try {
              const entries = await readSession(s.sessionId, ws.path);
              dailySessions.push({
                sessionId: s.sessionId,
                title: `[${ws.name}] ${s.slug ?? s.firstUserMessage.slice(0, 50)}`,
                messageCount: entries.length,
                entries,
              });
            } catch {
              log(`セッション読み込みスキップ: ${s.sessionId}`);
            }
          }
        }

        if (dailySessions.length === 0) {
          await interaction.editReply('⚠️ セッションの読み込みに失敗しました');
          return;
        }

        const report = await reportGenerator.generate(dailySessions, targetDate);

        if (!report) {
          await interaction.editReply('⚠️ 日報の生成に失敗しました');
          return;
        }

        // Discord の文字数上限（2000文字）で分割送信
        if (report.length <= 2000) {
          await interaction.editReply(report);
        } else {
          const chunks: string[] = [];
          let remaining = report;
          while (remaining.length > 0) {
            chunks.push(remaining.slice(0, 2000));
            remaining = remaining.slice(2000);
          }
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }

        log('日報生成完了');
      } catch (err) {
        console.error('Report generation error:', err);
        await interaction.editReply('⚠️ 日報の生成中にエラーが発生しました');
      }
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
