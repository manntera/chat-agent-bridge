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

  if (parsed.type === 'assistant' && parsed.subtype === 'tool_use') {
    const tool = parsed.tool as Record<string, unknown> | undefined;
    if (tool && typeof tool.name === 'string') {
      const input = (tool.input as Record<string, unknown>) ?? {};
      return {
        kind: 'progress',
        event: { kind: 'tool_use', toolName: tool.name, target: extractTarget(tool.name, input) },
      };
    }
  }

  if (parsed.type === 'assistant' && parsed.subtype === 'thinking') {
    const content = parsed.content as Array<Record<string, unknown>> | undefined;
    if (content && content.length > 0 && typeof content[0].thinking === 'string') {
      return {
        kind: 'progress',
        event: { kind: 'thinking', text: content[0].thinking },
      };
    }
  }

  return IGNORED;
}
