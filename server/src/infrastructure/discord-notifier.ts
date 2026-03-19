import type { Notification, NotifyFn, UsageInfo } from '../domain/types.js';

export interface EmbedData {
  color: number;
  description?: string;
  title?: string;
  footer?: { text: string };
}

export interface SendOptions {
  embeds: EmbedData[];
}

export interface ThreadSender {
  send(content: string | SendOptions): Promise<unknown>;
}

function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}

function formatProgress(notification: Notification & { type: 'progress' }): string {
  if (notification.event.kind === 'started') {
    return '📨 受信しました。処理を開始します...';
  }
  if (notification.event.kind === 'tool_use') {
    return `🔧 ${notification.event.toolName}: ${notification.event.target}`;
  }
  return `💭 ${notification.event.text}`;
}

function formatUsageFooter(usage: UsageInfo): string | null {
  const parts: string[] = [];
  if (usage.fiveHour) parts.push(`5h ${usage.fiveHour.utilization}%`);
  if (usage.sevenDay) parts.push(`7d ${usage.sevenDay.utilization}%`);
  if (usage.sevenDaySonnet) parts.push(`Sonnet ${usage.sevenDaySonnet.utilization}%`);
  return parts.length > 0 ? `📊 ${parts.join(' | ')}` : null;
}

const COLOR_SUCCESS = 0x00c853;
const COLOR_ERROR = 0xff1744;
const EMBED_MAX_LENGTH = 4096;

type PendingResult =
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; exitCode: number };

/**
 * セッションスレッド用の Notifier を作成する。
 *
 * 通知の流れ:
 * - progress / info → プレーンテキストとして即座に送信
 * - result / error → バッファ（usage を待つ）
 * - usage → バッファされた result/error と結合して Embed で送信
 */
export function createNotifier(thread: ThreadSender): NotifyFn {
  let pendingResult: PendingResult | null = null;

  function sendText(text: string): void {
    thread.send(text).catch((err) => console.error('Discord send error:', err));
  }

  function sendEmbed(embed: EmbedData): void {
    thread.send({ embeds: [embed] }).catch((err) => console.error('Discord send error:', err));
  }

  function flush(usage: UsageInfo): void {
    const footer = formatUsageFooter(usage);
    const result = pendingResult;
    pendingResult = null;

    if (result === null) {
      if (footer) {
        sendEmbed({ color: COLOR_SUCCESS, footer: { text: footer } });
      }
      return;
    }

    if (result.type === 'result') {
      if (result.text.length <= EMBED_MAX_LENGTH) {
        const embed: EmbedData = {
          color: COLOR_SUCCESS,
          description: result.text,
        };
        if (footer) embed.footer = { text: footer };
        sendEmbed(embed);
      } else {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          sendText(chunk);
        }
        const embed: EmbedData = { color: COLOR_SUCCESS };
        if (footer) embed.footer = { text: footer };
        sendEmbed(embed);
      }
    } else {
      const embed: EmbedData = {
        color: COLOR_ERROR,
        title: `エラー (exit ${result.exitCode})`,
        description: result.message,
      };
      if (footer) embed.footer = { text: footer };
      sendEmbed(embed);
    }
  }

  return (notification: Notification) => {
    switch (notification.type) {
      case 'progress':
        sendText(formatProgress(notification));
        break;
      case 'info':
        sendText(notification.message);
        break;
      case 'result':
        pendingResult = { type: 'result', text: notification.text };
        break;
      case 'error':
        pendingResult = {
          type: 'error',
          message: notification.message,
          exitCode: notification.exitCode,
        };
        break;
      case 'usage':
        flush(notification.usage);
        break;
    }
  };
}
