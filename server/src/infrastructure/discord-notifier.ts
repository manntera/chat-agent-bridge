import type { Notification, NotifyFn, UsageInfo } from '../domain/types.js';

export interface ThreadSender {
  send(content: string): Promise<unknown>;
  setArchived(archived: boolean): Promise<unknown>;
}

export interface Threadable {
  startThread(options: { name: string }): Promise<ThreadSender>;
}

export interface ChannelSender {
  send(content: string): Promise<unknown>;
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

function formatUsage(usage: UsageInfo): string {
  const parts: string[] = [];
  if (usage.fiveHour) parts.push(`5h ${usage.fiveHour.utilization}%`);
  if (usage.sevenDay) parts.push(`7d ${usage.sevenDay.utilization}%`);
  if (usage.sevenDaySonnet) parts.push(`Sonnet ${usage.sevenDaySonnet.utilization}%`);
  return `📊 利用状況: ${parts.join(' | ') || '取得できませんでした'}`;
}

function formatNotification(notification: Notification): string[] {
  switch (notification.type) {
    case 'info':
      return [notification.message];
    case 'result':
      return splitMessage(notification.text);
    case 'error':
      return [`エラー (exit ${notification.exitCode}): ${notification.message}`];
    case 'progress':
      return [formatProgress(notification)];
    case 'usage':
      return [formatUsage(notification.usage)];
  }
}

export function createNotifier(
  channel: ChannelSender,
): NotifyFn & { setThreadOrigin(message: Threadable): void } {
  let threadPromise: Promise<ThreadSender> | null = null;
  let pendingOrigin: Threadable | null = null;

  function ensureThread(): Promise<ThreadSender> {
    if (threadPromise === null) {
      const origin = pendingOrigin;
      pendingOrigin = null;
      if (origin === null) {
        throw new Error('No thread origin set');
      }
      threadPromise = origin.startThread({ name: '途中経過' });
    }
    return threadPromise;
  }

  function sendToChannel(messages: string[]): void {
    for (const msg of messages) {
      channel.send(msg).catch((err) => console.error('Discord send error:', err));
    }
  }

  async function sendToThread(messages: string[]): Promise<void> {
    const thread = await ensureThread();
    for (const msg of messages) {
      await thread.send(msg).catch((err) => console.error('Discord thread send error:', err));
    }
  }

  function archiveThread(): void {
    if (threadPromise) {
      threadPromise
        .then((thread) => thread.setArchived(true))
        .catch((err) => console.error('Discord thread archive error:', err));
    }
    threadPromise = null;
    pendingOrigin = null;
  }

  const notify: NotifyFn & { setThreadOrigin(message: Threadable): void } = Object.assign(
    (notification: Notification) => {
      const messages = formatNotification(notification);

      if (notification.type === 'progress') {
        sendToThread(messages).catch((err) => console.error('Discord thread error:', err));
      } else if (notification.type === 'usage') {
        const hasData =
          notification.usage.fiveHour !== null ||
          notification.usage.sevenDay !== null ||
          notification.usage.sevenDaySonnet !== null;
        const send = hasData ? sendToThread(messages) : Promise.resolve();
        send
          .then(() => archiveThread())
          .catch((err) => console.error('Discord thread error:', err));
      } else {
        sendToChannel(messages);
      }
    },
    {
      setThreadOrigin(message: Threadable): void {
        pendingOrigin = message;
      },
    },
  );

  return notify;
}
