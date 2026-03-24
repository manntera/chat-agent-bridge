import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

// session-store.js の projectDir をモック
vi.mock('./session-store.js', () => ({
  projectDir: (...args: unknown[]) => mockProjectDir(...args),
}));

let mockProjectDir: (...args: unknown[]) => string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-reader-test-'));
  mockProjectDir = () => tempDir;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function userLine(content: string | object[]): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  });
}

function assistantLine(content: string | object[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content },
  });
}

function snapshotLine(): string {
  return JSON.stringify({ type: 'file-history-snapshot', snapshot: {} });
}

describe('readSession', () => {
  // 動的インポートして vi.mock のホイスティングを確実にする
  async function importReadSession() {
    const mod = await import('./session-reader.js');
    return mod.readSession;
  }

  it('ユーザーとアシスタントのメッセージを抽出する', async () => {
    const readSession = await importReadSession();
    const lines = [userLine('こんにちは'), assistantLine([{ type: 'text', text: '応答です' }])];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toEqual([
      { role: 'user', text: 'こんにちは' },
      { role: 'assistant', text: '応答です' },
    ]);
  });

  it('tool_use はツール名のみ含まれる', async () => {
    const readSession = await importReadSession();
    const lines = [
      assistantLine([
        { type: 'text', text: 'ファイルを編集します' },
        { type: 'tool_use', name: 'Edit', id: '123', input: { path: '/foo' } },
      ]),
    ];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('ファイルを編集します [tool_use: Edit]');
  });

  it('snapshot 行などは無視される', async () => {
    const readSession = await importReadSession();
    const lines = [snapshotLine(), userLine('メッセージ')];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
  });

  it('壊れた JSON 行はスキップされる', async () => {
    const readSession = await importReadSession();
    const lines = ['not valid json', userLine('有効')];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('有効');
  });

  it('空ファイルは空配列を返す', async () => {
    const readSession = await importReadSession();
    await writeFile(join(tempDir, 'test-session.jsonl'), '');

    const entries = await readSession('test-session', '/work');

    expect(entries).toEqual([]);
  });

  it('配列 content のテキストを結合する', async () => {
    const readSession = await importReadSession();
    const lines = [
      userLine([
        { type: 'text', text: 'パート1' },
        { type: 'text', text: 'パート2' },
      ]),
    ];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('パート1 パート2');
  });

  it('content が非文字列・非配列の場合はスキップされる', async () => {
    const readSession = await importReadSession();
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 12345 },
      }),
    ];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toEqual([]);
  });

  it('assistant の content が全てスキップ対象の場合はエントリに含まれない', async () => {
    const readSession = await importReadSession();
    const lines = [assistantLine([{ type: 'image', url: 'http://example.com' }])];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toEqual([]);
  });

  it('text でも tool_use でもない配列要素はスキップされる', async () => {
    const readSession = await importReadSession();
    const lines = [
      assistantLine([
        { type: 'image', url: 'http://example.com' },
        { type: 'text', text: 'テキスト' },
      ]),
    ];
    await writeFile(join(tempDir, 'test-session.jsonl'), lines.join('\n'));

    const entries = await readSession('test-session', '/work');

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('テキスト');
  });
});

describe('formatForTitleGeneration', () => {
  // formatForTitleGeneration は session-store に依存しないので直接インポート可能
  async function importFormat() {
    const mod = await import('./session-reader.js');
    return mod.formatForTitleGeneration;
  }

  it('会話をフォーマットする', async () => {
    const formatForTitleGeneration = await importFormat();
    const entries = [
      { role: 'user' as const, text: 'バグを直して' },
      { role: 'assistant' as const, text: '修正しました' },
    ];

    const result = formatForTitleGeneration(entries, 10000);

    expect(result).toBe('user: バグを直して\nassistant: 修正しました');
  });

  it('maxLength 以内ならそのまま返す', async () => {
    const formatForTitleGeneration = await importFormat();
    const entries = [{ role: 'user' as const, text: 'hello' }];

    const result = formatForTitleGeneration(entries, 100);

    expect(result).toBe('user: hello');
  });

  it('maxLength 超過時は末尾（最新）を優先する', async () => {
    const formatForTitleGeneration = await importFormat();
    const entries = [
      { role: 'user' as const, text: 'A'.repeat(50) },
      { role: 'assistant' as const, text: 'B'.repeat(50) },
      { role: 'user' as const, text: 'C'.repeat(20) },
    ];

    const result = formatForTitleGeneration(entries, 90);

    expect(result).toContain('B'.repeat(50));
    expect(result).toContain('C'.repeat(20));
    expect(result).not.toContain('A'.repeat(50));
  });

  it('空配列は空文字を返す', async () => {
    const formatForTitleGeneration = await importFormat();
    const result = formatForTitleGeneration([], 100);

    expect(result).toBe('');
  });

  it('全ての行が maxLength を超える場合は空文字を返す', async () => {
    const formatForTitleGeneration = await importFormat();
    const entries = [{ role: 'user' as const, text: 'A'.repeat(100) }];

    const result = formatForTitleGeneration(entries, 5);

    expect(result).toBe('');
  });
});
