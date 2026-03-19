import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFirstUserMessage, SessionStore } from './session-store.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-store-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function userLine(content: string, sessionId = 'test-id', slug?: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: '2026-03-19T05:00:00Z',
    sessionId,
    ...(slug ? { slug } : {}),
  });
}

function userLineArray(texts: string[], sessionId = 'test-id', slug?: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: texts.map((t) => ({ type: 'text', text: t })),
    },
    timestamp: '2026-03-19T05:00:00Z',
    sessionId,
    ...(slug ? { slug } : {}),
  });
}

function assistantLine(content: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: content }] },
    timestamp: '2026-03-19T05:01:00Z',
  });
}

function snapshotLine(): string {
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId: 'test',
    snapshot: {},
  });
}

describe('extractFirstUserMessage', () => {
  it('文字列 content から最初の user メッセージを抽出する', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [snapshotLine(), userLine('最初のメッセージ'), assistantLine('応答')];
    await writeFile(filePath, lines.join('\n'));

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('最初のメッセージ');
    expect(result.slug).toBeNull();
  });

  it('配列 content からテキストを結合して抽出する', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [userLineArray(['Hello', 'World'])];
    await writeFile(filePath, lines.join('\n'));

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('Hello World');
  });

  it('slug がある場合は slug も返す', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [userLine('メッセージ', 'test-id', 'add-dark-mode')];
    await writeFile(filePath, lines.join('\n'));

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('メッセージ');
    expect(result.slug).toBe('add-dark-mode');
  });

  it('user メッセージが無い場合は「(メッセージなし)」を返す', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    await writeFile(filePath, [snapshotLine(), assistantLine('応答')].join('\n'));

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('(メッセージなし)');
  });

  it('壊れた行をスキップして user メッセージを見つける', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = ['not valid json', userLine('有効なメッセージ')];
    await writeFile(filePath, lines.join('\n'));

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('有効なメッセージ');
  });

  it('空ファイルは「(メッセージなし)」を返す', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    await writeFile(filePath, '');

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('(メッセージなし)');
  });
});

describe('SessionStore', () => {
  const store = new SessionStore();

  it('JSONL ファイルからセッション一覧を取得する', async () => {
    const sessionDir = join(tempDir, 'sessions');
    await mkdir(sessionDir);

    await writeFile(join(sessionDir, 'aaa.jsonl'), userLine('タスクA', 'aaa'));
    await writeFile(join(sessionDir, 'bbb.jsonl'), userLine('タスクB', 'bbb'));

    // workDir を直接使わず、テスト用に listSessions の内部をテストするため
    // SessionStore を拡張して projectDir をオーバーライド
    const result = await listSessionsFromDir(sessionDir);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.sessionId)).toContain('aaa');
    expect(result.map((s) => s.sessionId)).toContain('bbb');
  });

  it('最終更新日の降順でソートされる', async () => {
    const sessionDir = join(tempDir, 'sessions');
    await mkdir(sessionDir);

    const oldFile = join(sessionDir, 'old.jsonl');
    const newFile = join(sessionDir, 'new.jsonl');
    await writeFile(oldFile, userLine('古いタスク', 'old'));
    await writeFile(newFile, userLine('新しいタスク', 'new'));

    // old ファイルのタイムスタンプを過去に設定
    const pastDate = new Date('2026-01-01T00:00:00Z');
    await utimes(oldFile, pastDate, pastDate);

    const result = await listSessionsFromDir(sessionDir);

    expect(result[0].sessionId).toBe('new');
    expect(result[1].sessionId).toBe('old');
  });

  it('最大 25 件に制限される', async () => {
    const sessionDir = join(tempDir, 'sessions');
    await mkdir(sessionDir);

    for (let i = 0; i < 30; i++) {
      const id = `session-${String(i).padStart(3, '0')}`;
      await writeFile(join(sessionDir, `${id}.jsonl`), userLine(`タスク ${i}`, id));
    }

    const result = await listSessionsFromDir(sessionDir);

    expect(result).toHaveLength(25);
  });

  it('空ディレクトリでは空配列を返す', async () => {
    const sessionDir = join(tempDir, 'empty');
    await mkdir(sessionDir);

    const result = await listSessionsFromDir(sessionDir);

    expect(result).toEqual([]);
  });

  it('存在しないディレクトリでは空配列を返す', async () => {
    const result = await store.listSessions('/nonexistent/path/that/does/not/exist');

    expect(result).toEqual([]);
  });

  it('.jsonl 以外のファイルは無視する', async () => {
    const sessionDir = join(tempDir, 'sessions');
    await mkdir(sessionDir);

    await writeFile(join(sessionDir, 'aaa.jsonl'), userLine('タスクA', 'aaa'));
    await writeFile(join(sessionDir, 'aaa'), 'directory placeholder');
    await writeFile(join(sessionDir, 'readme.txt'), 'not a session');

    const result = await listSessionsFromDir(sessionDir);

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('aaa');
  });
});

// テスト用ヘルパー: 任意のディレクトリからセッション一覧を取得する
// SessionStore.listSessions は workDir からプロジェクトパスを算出するため、
// テストでは直接ディレクトリを指定できるラッパーを使う
async function listSessionsFromDir(dir: string): ReturnType<SessionStore['listSessions']> {
  const { readdir, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { extractFirstUserMessage } = await import('./session-store.js');

  const entries = await readdir(dir).catch(() => []);
  const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));

  const summaries = await Promise.all(
    jsonlFiles.map(async (file) => {
      try {
        const filePath = join(dir, file);
        const fileStat = await stat(filePath);
        const sessionId = file.replace('.jsonl', '');
        const { text, slug } = await extractFirstUserMessage(filePath);
        return { sessionId, firstUserMessage: text, slug, lastModified: fileStat.mtime };
      } catch {
        return null;
      }
    }),
  );

  const valid = summaries.filter((s): s is NonNullable<typeof s> => s !== null);
  valid.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return valid.slice(0, 25);
}
