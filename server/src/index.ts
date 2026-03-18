import 'dotenv/config';
import { Client, Events, GatewayIntentBits, TextChannel } from 'discord.js';
import { createMessageHandler } from './app/message-handler.js';
import { AccessControl } from './domain/access-control.js';
import { Orchestrator } from './domain/orchestrator.js';
import { Session } from './domain/session.js';
import type { ProgressEvent } from './domain/types.js';
import { ClaudeProcess } from './infrastructure/claude-process.js';
import { loadConfig } from './infrastructure/config.js';
import { createNotifier } from './infrastructure/discord-notifier.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(config.discordToken);
  console.log('Discord に接続しました');

  const channel = await client.channels.fetch(config.channelId);
  if (!channel || !(channel instanceof TextChannel)) {
    throw new Error(`チャンネル ${config.channelId} が見つからないか、TextChannel ではありません`);
  }

  // ドメインオブジェクト
  const session = new Session(config.workDir);
  const accessControl = new AccessControl({
    allowedUserIds: config.allowedUserIds,
    channelId: config.channelId,
  });

  // インフラオブジェクト + 循環依存の解決
  const notifier = createNotifier(channel);

  let onProgress: (event: ProgressEvent) => void = () => {};
  let onProcessEnd: (exitCode: number, output: string) => void = () => {};

  const claudeProcess = new ClaudeProcess(
    config.claudePath,
    (event) => onProgress(event),
    (exitCode, output) => onProcessEnd(exitCode, output),
  );

  const orchestrator = new Orchestrator(session, claudeProcess, notifier);

  onProgress = (event) => orchestrator.onProgress(event);
  onProcessEnd = (exitCode, output) => orchestrator.onProcessEnd(exitCode, output);

  // App 層
  const handleMessage = createMessageHandler(accessControl, orchestrator);

  // イベントハンドラ
  client.on(Events.MessageCreate, (msg) => {
    handleMessage({
      authorBot: msg.author.bot,
      authorId: msg.author.id,
      channelId: msg.channelId,
      content: msg.content,
    });
  });

  console.log('claude-discord-bridge を起動しました');
}

main().catch(console.error);
