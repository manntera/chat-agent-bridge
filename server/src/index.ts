import 'dotenv/config';
import {
  ActionRowBuilder,
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  TextChannel,
} from 'discord.js';
import { createMessageHandler } from './app/message-handler.js';
import { toCommand } from './app/interaction-handler.js';
import { AccessControl } from './domain/access-control.js';
import { Orchestrator } from './domain/orchestrator.js';
import { Session } from './domain/session.js';
import { SessionManager, type SessionContext } from './domain/session-manager.js';
import type { Notification, ProgressEvent } from './domain/types.js';
import { ClaudeProcess } from './infrastructure/claude-process.js';
import { loadConfig } from './infrastructure/config.js';
import { createNotifier, type ThreadSender } from './infrastructure/discord-notifier.js';
import { resolvePrompt } from './infrastructure/attachment-resolver.js';
import { SessionStore } from './infrastructure/session-store.js';
import { ccCommand } from './infrastructure/slash-commands.js';
import { UsageFetcher } from './infrastructure/usage-fetcher.js';

function formatRelativeDate(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}時間前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}日前`;
  return date.toLocaleDateString('ja-JP');
}

function log(message: string): void {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  console.log(`[${time}] ${message}`);
}

function logNotification(notification: Notification): void {
  switch (notification.type) {
    case 'info':
      log(`通知: ${notification.message}`);
      break;
    case 'result':
      log(`結果: ${notification.text.slice(0, 100)}${notification.text.length > 100 ? '...' : ''}`);
      break;
    case 'error':
      log(`エラー (exit ${notification.exitCode}): ${notification.message}`);
      break;
    case 'progress':
      if (notification.event.kind === 'started') {
        log('途中経過: 📨 受信しました。処理を開始します...');
      } else if (notification.event.kind === 'tool_use') {
        log(`途中経過: 🔧 ${notification.event.toolName}: ${notification.event.target}`);
      } else {
        log(`途中経過: 💭 ${notification.event.text}`);
      }
      break;
    case 'usage': {
      const u = notification.usage;
      const parts: string[] = [];
      if (u.fiveHour) parts.push(`5h ${u.fiveHour.utilization}%`);
      if (u.sevenDay) parts.push(`7d ${u.sevenDay.utilization}%`);
      if (u.sevenDaySonnet) parts.push(`Sonnet ${u.sevenDaySonnet.utilization}%`);
      log(`利用状況: ${parts.join(' | ') || 'N/A'}`);
      break;
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  log(`設定読み込み完了 (workDir: ${config.workDir})`);

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

  /** セッションコンテキストを作成し SessionManager に登録する */
  function createSession(threadId: string, thread: ThreadSender): SessionContext {
    const session = new Session(config.workDir);

    let onProgress: (event: ProgressEvent) => void = () => {};
    let onProcessEnd: (exitCode: number, output: string) => void = () => {};

    const claudeProcess = new ClaudeProcess(
      config.claudePath,
      (event) => onProgress(event),
      (exitCode, output) => onProcessEnd(exitCode, output),
    );

    const notifier = createNotifier(thread);
    const notify = (notification: Notification): void => {
      logNotification(notification);
      notifier(notification);
    };

    const orchestrator = new Orchestrator(session, claudeProcess, notify, usageFetcher);

    onProgress = (event) => orchestrator.onProgress(event);
    onProcessEnd = (exitCode, output) => {
      log(`ClaudeProcess 終了 (exitCode: ${exitCode}, thread: ${threadId})`);
      orchestrator.onProcessEnd(exitCode, output);
    };

    const ctx: SessionContext = { orchestrator, session, claudeProcess, threadId };
    sessionManager.register(threadId, ctx);
    return ctx;
  }

  // App 層
  const handleMessage = createMessageHandler(accessControl, sessionManager);

  // メッセージイベント（スレッド内のプロンプト）
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;

    if (
      msg.channel.type !== ChannelType.PublicThread &&
      msg.channel.type !== ChannelType.PrivateThread
    ) {
      return; // チャンネル直接のメッセージは無視
    }

    const parentChannelId = msg.channel.parentId;
    if (!parentChannelId) return;

    // 添付テキストファイルの解決
    const attachments = [...msg.attachments.values()].map((a) => ({
      contentType: a.contentType,
      name: a.name,
      size: a.size,
      url: a.url,
    }));
    const { prompt, error } = await resolvePrompt(msg.content, attachments);

    if (error) {
      const ctx = sessionManager.get(msg.channelId);
      if (ctx) {
        msg.channel.send(error).catch((err) => console.error('Discord send error:', err));
      }
    }

    if (prompt === null) return;

    log(
      `メッセージ受信: ${msg.author.username} "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}" (thread: ${msg.channelId})`,
    );

    const ctx = sessionManager.get(msg.channelId);
    const prevState = ctx?.orchestrator.state;

    handleMessage({
      authorBot: false,
      authorId: msg.author.id,
      channelId: parentChannelId,
      threadId: msg.channelId,
      content: prompt,
    });

    const newState = ctx?.orchestrator.state;
    if (prevState !== newState) {
      log(`状態遷移: ${prevState} → ${newState} (thread: ${msg.channelId})`);
    }
  });

  // スラッシュコマンドイベント
  client.on(Events.InteractionCreate, async (interaction) => {
    // StringSelectMenu の選択イベント（/cc resume のセッション選択）
    if (interaction.isStringSelectMenu() && interaction.customId === 'cc_resume_select') {
      const selectedSessionId = interaction.values[0];
      log(`セッション選択: ${interaction.user.username} ${selectedSessionId.slice(0, 8)}...`);

      try {
        // スレッドを作成してセッションを登録
        const thread = await channel.threads.create({
          name: `Session: ${selectedSessionId.slice(0, 8)}... (再開)`,
          autoArchiveDuration: 60,
        });

        const ctx = createSession(thread.id, thread);
        ctx.session.restore(selectedSessionId);

        await thread.send(`セッションを再開しました [\`${selectedSessionId.slice(0, 8)}\`]`);

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
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'cc') return;

    const subcommand = interaction.options.getSubcommand();
    log(`コマンド受信: ${interaction.user.username} /cc ${subcommand}`);

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

    // /cc new — スレッドを作成してセッションを登録
    if (subcommand === 'new') {
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

      try {
        const session = new Session(config.workDir);
        session.ensure(command.options);
        const sessionId = session.sessionId!;

        const opts = command.options;
        const details: string[] = [];
        if (opts.model) details.push(opts.model);
        if (opts.effort) details.push(opts.effort);
        const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
        const threadName = `Session: ${sessionId.slice(0, 8)}${suffix}`;

        const thread = await channel.threads.create({ name: threadName, autoArchiveDuration: 60 });
        const ctx = createSession(thread.id, thread);
        // createSession 内で新しい Session を作るが、options を引き継ぐために上書き
        ctx.session.reset();
        ctx.session.ensure(command.options);

        await thread.send(
          `セッションを開始しました [\`${ctx.session.sessionId!.slice(0, 8)}\`]${suffix}`,
        );

        await interaction.reply({
          content: `セッションを作成しました → <#${thread.id}>`,
          ephemeral: true,
        });

        log(`スレッド作成: ${thread.name} (${thread.id})`);
      } catch (err) {
        console.error('Thread creation error:', err);
        await interaction.reply({ content: 'スレッドの作成に失敗しました', ephemeral: true });
      }
      return;
    }

    // /cc interrupt — スレッド内で実行した場合のみ処理
    if (subcommand === 'interrupt') {
      const isThread =
        interaction.channel?.type === ChannelType.PublicThread ||
        interaction.channel?.type === ChannelType.PrivateThread;

      if (!isThread) {
        await interaction.reply({
          content: 'セッションスレッド内で実行してください',
          ephemeral: true,
        });
        return;
      }

      const ctx = sessionManager.get(interaction.channelId);
      if (!ctx) {
        await interaction.reply({
          content: 'このスレッドにはセッションが紐づいていません',
          ephemeral: true,
        });
        return;
      }

      if (ctx.orchestrator.state === 'busy') {
        ctx.orchestrator.handleCommand({ type: 'interrupt' });
        await interaction.reply({ content: '✅', ephemeral: true });
      } else if (ctx.orchestrator.state === 'interrupting') {
        await interaction.reply({ content: '既に中断処理中です', ephemeral: true });
      } else {
        await interaction.reply({ content: '処理中ではありません', ephemeral: true });
      }
      return;
    }

    // /cc resume — セッション一覧を表示
    if (subcommand === 'resume') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const sessions = await sessionStore.listSessions(config.workDir);
        if (sessions.length === 0) {
          await interaction.editReply('再開できるセッションがありません');
          return;
        }

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('cc_resume_select')
          .setPlaceholder('セッションを選択してください')
          .addOptions(
            sessions.map((s) => {
              const cleanMsg = s.firstUserMessage.replace(/\s+/g, ' ').trim();
              const label = s.slug
                ? s.slug.length > 100
                  ? s.slug.slice(0, 97) + '...'
                  : s.slug
                : cleanMsg.length > 100
                  ? cleanMsg.slice(0, 97) + '...'
                  : cleanMsg || '(空のメッセージ)';
              const desc = s.slug
                ? cleanMsg.length > 100
                  ? cleanMsg.slice(0, 97) + '...'
                  : cleanMsg
                : formatRelativeDate(s.lastModified);
              return {
                label,
                description: desc || formatRelativeDate(s.lastModified),
                value: s.sessionId,
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
      return;
    }
  });

  await channel.send('chat-agent-bridge を起動しました 🟢');
  log('chat-agent-bridge を起動しました');
}

main().catch(console.error);
