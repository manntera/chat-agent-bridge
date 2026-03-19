import 'dotenv/config';
import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  TextChannel,
} from 'discord.js';
import { createMessageHandler } from './app/message-handler.js';
import { createInteractionHandler } from './app/interaction-handler.js';
import { AccessControl } from './domain/access-control.js';
import { Orchestrator } from './domain/orchestrator.js';
import { Session } from './domain/session.js';
import type { Notification, ProgressEvent } from './domain/types.js';
import { ClaudeProcess } from './infrastructure/claude-process.js';
import { loadConfig } from './infrastructure/config.js';
import { createNotifier } from './infrastructure/discord-notifier.js';
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
  const session = new Session(config.workDir);
  const accessControl = new AccessControl({
    allowedUserIds: config.allowedUserIds,
    channelId: config.channelId,
  });

  // インフラオブジェクト + 循環依存の解決
  const discordNotifier = createNotifier(channel);
  const notifier = (notification: Notification): void => {
    logNotification(notification);
    discordNotifier(notification);
  };

  let onProgress: (event: ProgressEvent) => void = () => {};
  let onProcessEnd: (exitCode: number, output: string) => void = () => {};

  const claudeProcess = new ClaudeProcess(
    config.claudePath,
    (event) => onProgress(event),
    (exitCode, output) => onProcessEnd(exitCode, output),
  );

  const usageFetcher = new UsageFetcher();
  const sessionStore = new SessionStore();
  const orchestrator = new Orchestrator(session, claudeProcess, notifier, usageFetcher);

  onProgress = (event) => orchestrator.onProgress(event);
  onProcessEnd = (exitCode, output) => {
    log(`ClaudeProcess 終了 (exitCode: ${exitCode})`);
    orchestrator.onProcessEnd(exitCode, output);
  };

  // App 層
  const handleMessage = createMessageHandler(accessControl, orchestrator);
  const handleInteraction = createInteractionHandler(accessControl, orchestrator);

  // メッセージイベント（プロンプト）
  client.on(Events.MessageCreate, (msg) => {
    if (!msg.author.bot) {
      log(`メッセージ受信: ${msg.author.username} "${msg.content}"`);
    }

    // プロンプト処理時にユーザーのメッセージをスレッドの起点にする
    if (!msg.author.bot && orchestrator.state === 'idle') {
      discordNotifier.setThreadOrigin(msg);
    }

    const prevState = orchestrator.state;
    handleMessage({
      authorBot: msg.author.bot,
      authorId: msg.author.id,
      channelId: msg.channelId,
      content: msg.content,
    });
    const newState = orchestrator.state;

    if (!msg.author.bot && prevState !== newState) {
      log(`状態遷移: ${prevState} → ${newState}`);
    }
  });

  // スラッシュコマンドイベント
  client.on(Events.InteractionCreate, async (interaction) => {
    // StringSelectMenu の選択イベント
    if (interaction.isStringSelectMenu() && interaction.customId === 'cc_resume_select') {
      const selectedSessionId = interaction.values[0];
      log(`セッション選択: ${interaction.user.username} ${selectedSessionId.slice(0, 8)}...`);

      const currentState = orchestrator.state;
      if (currentState === 'busy' || currentState === 'interrupting') {
        await interaction.update({
          content: '処理中のため再開できませんでした',
          components: [],
        });
        return;
      }

      orchestrator.handleCommand({ type: 'resume', sessionId: selectedSessionId });
      log(`状態遷移: ${currentState} → ${orchestrator.state}`);

      await interaction.update({
        content: `セッション \`${selectedSessionId.slice(0, 8)}...\` を再開しました。メッセージを送信してください。`,
        components: [],
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'cc') return;

    const subcommand = interaction.options.getSubcommand();
    log(`コマンド受信: ${interaction.user.username} /cc ${subcommand}`);

    // /cc resume は非同期フローのため別処理
    if (subcommand === 'resume') {
      if (
        !accessControl.check({
          authorBot: false,
          authorId: interaction.user.id,
          channelId: interaction.channelId,
        })
      ) {
        await interaction.reply({ content: '権限がありません', ephemeral: true });
        return;
      }

      const currentState = orchestrator.state;
      if (currentState === 'busy' || currentState === 'interrupting') {
        await interaction.reply({ content: '処理中です', ephemeral: true });
        return;
      }

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

    const prevState = orchestrator.state;
    handleInteraction({
      authorBot: false,
      authorId: interaction.user.id,
      channelId: interaction.channelId,
      subcommand,
      model: interaction.options.getString('model') ?? undefined,
      effort: interaction.options.getString('effort') ?? undefined,
    });
    const newState = orchestrator.state;

    if (prevState !== newState) {
      log(`状態遷移: ${prevState} → ${newState}`);
    }

    // スラッシュコマンドには必ず応答が必要
    if (subcommand === 'new') {
      if (newState === 'idle') {
        const opts = session.options;
        const details: string[] = [];
        if (opts.model) details.push(`model: ${opts.model}`);
        if (opts.effort) details.push(`effort: ${opts.effort}`);
        const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
        await interaction.reply(`新しいセッションを開始しました${suffix}`);
      } else if (newState === 'interrupting') {
        await interaction.reply('処理を中断して新しいセッションを開始します...');
      } else {
        await interaction.reply({ content: '処理中です', ephemeral: true });
      }
    } else if (subcommand === 'interrupt') {
      if (newState === 'interrupting') {
        await interaction.reply('中断しています...');
      } else {
        await interaction.reply({ content: '処理中ではありません', ephemeral: true });
      }
    }
  });

  await channel.send('claude-discord-bridge を起動しました 🟢');
  log('claude-discord-bridge を起動しました');
}

main().catch(console.error);
