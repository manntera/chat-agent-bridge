import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { projectDir } from './session-store.js';

export interface ConversationEntry {
  role: 'user' | 'assistant';
  text: string;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item?.type === 'tool_use' && typeof item.name === 'string') {
        parts.push(`[tool_use: ${item.name}]`);
      }
    }
    return parts.join(' ');
  }
  return '';
}

export async function readSession(
  sessionId: string,
  workDir: string,
): Promise<ConversationEntry[]> {
  const filePath = join(projectDir(workDir), `${sessionId}.jsonl`);
  const entries: ConversationEntry[] = [];

  const rl = createInterface({ input: createReadStream(filePath) });
  try {
    for await (const line of rl) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' && parsed.message?.content) {
          const text = extractText(parsed.message.content);
          if (text) entries.push({ role: 'user', text });
        } else if (parsed.type === 'assistant' && parsed.message?.content) {
          const text = extractText(parsed.message.content);
          if (text) entries.push({ role: 'assistant', text });
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    rl.close();
  }

  return entries;
}

export function formatForTitleGeneration(entries: ConversationEntry[], maxLength: number): string {
  const lines = entries.map((e) => `${e.role}: ${e.text}`);
  let result = lines.join('\n');

  if (result.length <= maxLength) return result;

  // 末尾（最新の会話）を優先して切り詰め
  result = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = i === lines.length - 1 ? lines[i] : lines[i] + '\n' + result;
    if (candidate.length > maxLength) break;
    result = candidate;
  }

  return result;
}
