import type { Notification, NotifyFn } from '../domain/types.js';

export interface ThreadSender {
  send(content: string): Promise<unknown>;
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
  if (notification.event.kind === 'tool_use') {
    return `🔧 ${notification.event.toolName}: ${notification.event.target}`;
  }
  const text = notification.event.text;
  const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
  return `💭 ${truncated}`;
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

  const notify: NotifyFn & { setThreadOrigin(message: Threadable): void } = Object.assign(
    (notification: Notification) => {
      const messages = formatNotification(notification);

      if (notification.type === 'progress') {
        sendToThread(messages).catch((err) => console.error('Discord thread error:', err));
      } else {
        sendToChannel(messages);
        if (notification.type === 'result' || notification.type === 'error') {
          threadPromise = null;
          pendingOrigin = null;
        }
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
