import type { ProgressEvent } from '../domain/types.js';

export type ParsedEvent =
  | { kind: 'progress'; event: ProgressEvent }
  | { kind: 'result'; text: string }
  | { kind: 'ignored' };

const IGNORED: ParsedEvent = { kind: 'ignored' };

function extractTarget(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Edit':
    case 'Read':
    case 'Write':
      return typeof input.file_path === 'string' ? input.file_path : toolName;
    case 'Bash':
      if (typeof input.command === 'string') {
        return input.command.slice(0, 100);
      }
      return toolName;
    case 'Glob':
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : toolName;
    default:
      return toolName;
  }
}

export function parseStreamJsonLine(line: string): ParsedEvent {
  if (line.trim() === '') return IGNORED;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return IGNORED;
  }

  if (parsed.type === 'result') {
    return { kind: 'result', text: typeof parsed.result === 'string' ? parsed.result : '' };
  }

  if (parsed.type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = (message?.content as Array<Record<string, unknown>>) ?? [];
    if (content.length === 0) return IGNORED;

    const first = content[0];

    if (first.type === 'tool_use' && typeof first.name === 'string') {
      const input = (first.input as Record<string, unknown>) ?? {};
      return {
        kind: 'progress',
        event: { kind: 'tool_use', toolName: first.name, target: extractTarget(first.name, input) },
      };
    }

    if (first.type === 'thinking' && typeof first.thinking === 'string') {
      return {
        kind: 'progress',
        event: { kind: 'thinking', text: first.thinking },
      };
    }
  }

  return IGNORED;
}
