import type { Notification, NotifyFn, UsageInfo } from '../domain/types.js';

export interface EmbedData {
  color: number;
  description?: string;
  title?: string;
  footer?: { text: string };
}

export interface SendOptions {
  content?: string;
  embeds: EmbedData[];
}

export interface ThreadSender {
  send(content: string | SendOptions): Promise<unknown>;
  sendTyping(): Promise<unknown>;
  setName(name: string): Promise<unknown>;
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
const COLOR_PROGRESS = 0x78909c;
const TYPING_INTERVAL_MS = 8_000;

type PendingResult =
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; exitCode: number };

export interface Notifier {
  notify: NotifyFn;
  setAuthorId(authorId: string): void;
  dispose(): void;
}

/**
 * セッションスレッド用の Notifier を作成する。
 *
 * 通知の流れ:
 * - progress → Embed として即座に送信
 * - info → プレーンテキストとして即座に送信
 * - result → バッファ → usage 到着時にプレーンテキストで送信
 * - error → バッファ → usage 到着時に Embed で送信
 * - usage → バッファされた result/error と結合して送信
 *
 * setAuthorId で質問者を設定すると、started / result / error 送信時にメンションを付与する。
 */
export function createNotifier(thread: ThreadSender): Notifier {
  let pendingResult: PendingResult | null = null;
  let currentAuthorId: string | null = null;
  let typingInterval: NodeJS.Timeout | null = null;
  let isTyping = false;

  function mention(): string | null {
    return currentAuthorId ? `<@${currentAuthorId}>` : null;
  }

  function fireTyping(): void {
    thread.sendTyping().catch((err) => console.error('Discord sendTyping error:', err));
  }

  function startTyping(): void {
    if (isTyping) return;
    isTyping = true;
    fireTyping();
    typingInterval = setInterval(fireTyping, TYPING_INTERVAL_MS);
  }

  function stopTyping(): void {
    isTyping = false;
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  function sendText(text: string): void {
    thread.send(text).catch((err) => console.error('Discord send error:', err));
    if (isTyping) fireTyping();
  }

  function sendEmbed(embed: EmbedData, withMention = false): void {
    const m = withMention ? mention() : null;
    const opts: SendOptions = { embeds: [embed] };
    if (m) opts.content = m;
    thread.send(opts).catch((err) => console.error('Discord send error:', err));
    if (isTyping) fireTyping();
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
      const m = mention();
      const mentionPrefix = m ? `${m} ` : null;
      const firstChunkMax = mentionPrefix ? 2000 - mentionPrefix.length : 2000;
      const firstChunk = result.text.slice(0, firstChunkMax);
      const rest = result.text.slice(firstChunkMax);
      const chunks = rest.length > 0 ? [firstChunk, ...splitMessage(rest, 2000)] : [firstChunk];
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && mentionPrefix) {
          sendText(`${mentionPrefix}${chunks[i]}`);
        } else {
          sendText(chunks[i]);
        }
      }
      if (footer) {
        sendText(footer);
      }
    } else {
      const embed: EmbedData = {
        color: COLOR_ERROR,
        title: `エラー (exit ${result.exitCode})`,
        description: result.message,
      };
      if (footer) embed.footer = { text: footer };
      sendEmbed(embed, true);
    }
  }

  const notify: NotifyFn = (notification: Notification) => {
    switch (notification.type) {
      case 'progress':
        if (notification.event.kind === 'started') startTyping();
        sendEmbed({ color: COLOR_PROGRESS, description: formatProgress(notification) });
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
        stopTyping();
        flush(notification.usage);
        break;
    }
  };

  return {
    notify,
    setAuthorId(authorId: string) {
      currentAuthorId = authorId;
    },
    dispose() {
      stopTyping();
    },
  };
}
