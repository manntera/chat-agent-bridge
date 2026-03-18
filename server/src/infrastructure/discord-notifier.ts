import type { Notification, NotifyFn } from '../domain/types.js';

export interface MessageSender {
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

function formatNotification(notification: Notification): string[] {
  switch (notification.type) {
    case 'info':
      return [notification.message];
    case 'result':
      return splitMessage(notification.text);
    case 'error':
      return [`エラー (exit ${notification.exitCode}): ${notification.message}`];
    case 'progress':
      if (notification.event.kind === 'tool_use') {
        return [`🔧 ${notification.event.toolName}: ${notification.event.target}`];
      }
      return [`💭 ${notification.event.text}`];
  }
}

export function createNotifier(sender: MessageSender): NotifyFn {
  return (notification: Notification) => {
    const messages = formatNotification(notification);
    for (const msg of messages) {
      sender.send(msg).catch((err) => console.error('Discord send error:', err));
    }
  };
}
