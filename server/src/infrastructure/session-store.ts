import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ISessionStore, SessionSummary } from '../domain/types.js';

const MAX_SESSIONS = 25;

export function projectDir(workDir: string): string {
  return join(homedir(), '.claude', 'projects', workDir.replaceAll('/', '-'));
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join(' ');
  }
  return '';
}

export async function extractFirstUserMessage(
  filePath: string,
): Promise<{ text: string; slug: string | null }> {
  const rl = createInterface({ input: createReadStream(filePath) });
  let slug: string | null = null;
  try {
    for await (const line of rl) {
      try {
        const parsed = JSON.parse(line);
        if (!slug && parsed.slug) {
          slug = parsed.slug;
        }
        if (parsed.type === 'user' && parsed.message?.content) {
          const text = extractTextFromContent(parsed.message.content);
          if (text) {
            return { text, slug };
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    rl.close();
  }
  return { text: '(メッセージなし)', slug };
}

export class SessionStore implements ISessionStore {
  async listSessions(workDir: string): Promise<SessionSummary[]> {
    const dir = projectDir(workDir);
    const entries = await readdir(dir).catch(() => []);
    const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));

    const summaries = await Promise.all(
      jsonlFiles.map(async (file) => {
        try {
          const filePath = join(dir, file);
          const fileStat = await stat(filePath);
          const sessionId = file.replace('.jsonl', '');
          const { text, slug } = await extractFirstUserMessage(filePath);
          return {
            sessionId,
            firstUserMessage: text,
            slug,
            lastModified: fileStat.mtime,
          };
        } catch {
          return null;
        }
      }),
    );

    const valid = summaries.filter((s): s is SessionSummary => s !== null);
    valid.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return valid.slice(0, MAX_SESSIONS);
  }
}
