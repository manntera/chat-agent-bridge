import 'dotenv/config';
import { Client, Events, GatewayIntentBits, TextChannel } from 'discord.js';
import { createMessageHandler } from './app/message-handler.js';
import { AccessControl } from './domain/access-control.js';
import { Orchestrator } from './domain/orchestrator.js';
import { Session } from './domain/session.js';
import type { Notification, ProgressEvent } from './domain/types.js';
import { ClaudeProcess } from './infrastructure/claude-process.js';
import { loadConfig } from './infrastructure/config.js';
import { createNotifier } from './infrastructure/discord-notifier.js';

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
      if (notification.event.kind === 'tool_use') {
        log(`途中経過: 🔧 ${notification.event.toolName}: ${notification.event.target}`);
      } else {
        log(
          `途中経過: 💭 ${notification.event.text.slice(0, 100)}${notification.event.text.length > 100 ? '...' : ''}`,
        );
      }
      break;
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

  const orchestrator = new Orchestrator(session, claudeProcess, notifier);

  onProgress = (event) => orchestrator.onProgress(event);
  onProcessEnd = (exitCode, output) => {
    log(`ClaudeProcess 終了 (exitCode: ${exitCode})`);
    orchestrator.onProcessEnd(exitCode, output);
  };

  // App 層
  const handleMessage = createMessageHandler(accessControl, orchestrator);

  // イベントハンドラ
  client.on(Events.MessageCreate, (msg) => {
    if (!msg.author.bot) {
      log(`メッセージ受信: ${msg.author.username} "${msg.content}"`);
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

  log('claude-discord-bridge を起動しました');
}

main().catch(console.error);
