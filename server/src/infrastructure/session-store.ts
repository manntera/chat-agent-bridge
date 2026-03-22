import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ISessionStore, SessionSummary } from '../domain/types.js';

const MAX_SESSIONS = 25;

/** JST (UTC+9) のオフセット（ミリ秒） */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

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

/**
 * 指定日の日報用の時間範囲を返す（朝6:00 JST 区切り）。
 * 例: date が 2026-03-22 → 2026-03-22 06:00 JST ~ 2026-03-23 06:00 JST
 */
export function getDayBoundary(date: Date): { from: Date; to: Date } {
  // date を JST で解釈し、その日の 06:00 JST を UTC に変換
  const jstTime = date.getTime() + JST_OFFSET_MS;
  const jstDate = new Date(jstTime);
  const year = jstDate.getUTCFullYear();
  const month = jstDate.getUTCMonth();
  const day = jstDate.getUTCDate();

  // JST 06:00 = UTC 前日 21:00
  const fromUtc = Date.UTC(year, month, day, 6, 0, 0) - JST_OFFSET_MS;
  const toUtc = fromUtc + 24 * 60 * 60 * 1000;

  return { from: new Date(fromUtc), to: new Date(toUtc) };
}

export class SessionStore implements ISessionStore {
  private async allSessions(workDir: string): Promise<SessionSummary[]> {
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

    return summaries.filter((s): s is SessionSummary => s !== null);
  }

  async listSessions(workDir: string): Promise<SessionSummary[]> {
    const all = await this.allSessions(workDir);
    all.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return all.slice(0, MAX_SESSIONS);
  }

  async listSessionsByDateRange(
    workDir: string,
    from: Date,
    to: Date,
  ): Promise<SessionSummary[]> {
    const all = await this.allSessions(workDir);
    const filtered = all.filter(
      (s) => s.lastModified.getTime() >= from.getTime() && s.lastModified.getTime() < to.getTime(),
    );
    filtered.sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime());
    return filtered;
  }
}
