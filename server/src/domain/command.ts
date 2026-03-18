import type { Effort, SessionOptions } from './types.js';

export type Command =
  | { type: 'new'; options: SessionOptions }
  | { type: 'interrupt' }
  | { type: 'prompt'; text: string };

const VALID_EFFORTS = new Set<Effort>(['medium', 'high', 'max']);

function parseNewArgs(args: string[]): SessionOptions {
  const options: SessionOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' && i + 1 < args.length) {
      options.model = args[++i];
    } else if (arg === '--effort' && i + 1 < args.length) {
      const value = args[++i] as Effort;
      if (VALID_EFFORTS.has(value)) {
        options.effort = value;
      }
    } else if (VALID_EFFORTS.has(arg as Effort)) {
      // !new max のようにショートハンドで effort を指定
      options.effort = arg as Effort;
    }
  }
  return options;
}

export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  if (trimmed === '!interrupt') return { type: 'interrupt' };
  if (trimmed === '!new' || trimmed.startsWith('!new ')) {
    const args = trimmed.slice(4).trim().split(/\s+/).filter(Boolean);
    return { type: 'new', options: parseNewArgs(args) };
  }
  return { type: 'prompt', text: trimmed };
}
