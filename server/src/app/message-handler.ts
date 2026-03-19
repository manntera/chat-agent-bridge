import type { AccessControl, MessageContext } from '../domain/access-control.js';
import type { SessionManager } from '../domain/session-manager.js';

export interface DiscordMessage extends MessageContext {
  content: string;
  threadId: string | null;
}

export type MessageHandlerFn = (message: DiscordMessage) => void;

export function createMessageHandler(
  accessControl: AccessControl,
  sessionManager: SessionManager,
): MessageHandlerFn {
  return (message: DiscordMessage): void => {
    if (!accessControl.check(message)) return;
    if (message.threadId === null) return;

    const ctx = sessionManager.get(message.threadId);
    if (ctx === null) return;

    ctx.orchestrator.handleMessage(message.content);
  };
}
