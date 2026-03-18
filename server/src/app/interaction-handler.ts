import type { AccessControl, MessageContext } from '../domain/access-control.js';
import type { Orchestrator } from '../domain/orchestrator.js';
import type { Command, Effort, SessionOptions } from '../domain/types.js';

export interface InteractionContext extends MessageContext {
  subcommand: string;
  model?: string;
  effort?: string;
}

export type InteractionHandlerFn = (context: InteractionContext) => void;

const VALID_EFFORTS = new Set<string>(['medium', 'high', 'max']);

function toCommand(context: InteractionContext): Command | null {
  switch (context.subcommand) {
    case 'new': {
      const options: SessionOptions = {};
      if (context.model) options.model = context.model;
      if (context.effort && VALID_EFFORTS.has(context.effort))
        options.effort = context.effort as Effort;
      return { type: 'new', options };
    }
    case 'interrupt':
      return { type: 'interrupt' };
    default:
      return null;
  }
}

export function createInteractionHandler(
  accessControl: AccessControl,
  orchestrator: Orchestrator,
): InteractionHandlerFn {
  return (context: InteractionContext): void => {
    if (!accessControl.check(context)) return;
    const command = toCommand(context);
    if (command === null) return;
    orchestrator.handleCommand(command);
  };
}
