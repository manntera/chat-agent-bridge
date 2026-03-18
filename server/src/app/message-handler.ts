import type { AccessControl, MessageContext } from '../domain/access-control.js';
import type { Orchestrator } from '../domain/orchestrator.js';

export interface DiscordMessage extends MessageContext {
  content: string;
}

export type MessageHandlerFn = (message: DiscordMessage) => void;

export function createMessageHandler(
  accessControl: AccessControl,
  orchestrator: Orchestrator,
): MessageHandlerFn {
  return (message: DiscordMessage): void => {
    if (!accessControl.check(message)) {
      return;
    }
    orchestrator.handleMessage(message.content);
  };
}
