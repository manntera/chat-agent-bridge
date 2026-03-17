export type Command = { type: 'new' } | { type: 'interrupt' } | { type: 'prompt'; text: string };

export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  if (trimmed === '!new') return { type: 'new' };
  if (trimmed === '!interrupt') return { type: 'interrupt' };
  return { type: 'prompt', text: trimmed };
}
