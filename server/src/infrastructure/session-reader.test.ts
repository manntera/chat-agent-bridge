import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatForTitleGeneration, type ConversationEntry } from './session-reader.js';

// readSession は projectDir(workDir) からパスを算出するため、
// テスト用に直接ファイルを作って読み込むラッパーを用意する
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-reader-test-'));
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

// readSession は projectDir を使うため、直接ファイルから読むヘルパーを作成
async function readSessionFromFile(filePath: string): Promise<ConversationEntry[]> {
  const entries: ConversationEntry[] = [];
  const rl = createInterface({ input: createReadStream(filePath) });
  try {
    for await (const line of rl) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' && parsed.message?.content) {
          const text = extractTextForTest(parsed.message.content);
          if (text) entries.push({ role: 'user', text });
        } else if (parsed.type === 'assistant' && parsed.message?.content) {
          const text = extractTextForTest(parsed.message.content);
          if (text) entries.push({ role: 'assistant', text });
        }
      } catch {
        // skip
      }
    }
  } finally {
    rl.close();
  }
  return entries;
}

function extractTextForTest(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content as Record<string, unknown>[]) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text as string);
      } else if (item?.type === 'tool_use' && typeof item.name === 'string') {
        parts.push(`[tool_use: ${item.name}]`);
      }
    }
    return parts.join(' ');
  }
  return '';
}

describe('readSession (via file helper)', () => {
  it('ユーザーとアシスタントのメッセージを抽出する', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [userLine('こんにちは'), assistantLine([{ type: 'text', text: '応答です' }])];
    await writeFile(filePath, lines.join('\n'));

    const entries = await readSessionFromFile(filePath);

    expect(entries).toEqual([
      { role: 'user', text: 'こんにちは' },
      { role: 'assistant', text: '応答です' },
    ]);
  });

  it('tool_use はツール名のみ含まれる', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [
      assistantLine([
        { type: 'text', text: 'ファイルを編集します' },
        { type: 'tool_use', name: 'Edit', id: '123', input: { path: '/foo' } },
      ]),
    ];
    await writeFile(filePath, lines.join('\n'));

    const entries = await readSessionFromFile(filePath);

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('ファイルを編集します [tool_use: Edit]');
  });

  it('snapshot 行などは無視される', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [snapshotLine(), userLine('メッセージ')];
    await writeFile(filePath, lines.join('\n'));

    const entries = await readSessionFromFile(filePath);

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
  });

  it('壊れた JSON 行はスキップされる', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = ['not valid json', userLine('有効')];
    await writeFile(filePath, lines.join('\n'));

    const entries = await readSessionFromFile(filePath);

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('有効');
  });

  it('空ファイルは空配列を返す', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    await writeFile(filePath, '');

    const entries = await readSessionFromFile(filePath);

    expect(entries).toEqual([]);
  });
});

describe('formatForTitleGeneration', () => {
  it('会話をフォーマットする', () => {
    const entries: ConversationEntry[] = [
      { role: 'user', text: 'バグを直して' },
      { role: 'assistant', text: '修正しました' },
    ];

    const result = formatForTitleGeneration(entries, 10000);

    expect(result).toBe('user: バグを直して\nassistant: 修正しました');
  });

  it('maxLength 以内ならそのまま返す', () => {
    const entries: ConversationEntry[] = [{ role: 'user', text: 'hello' }];

    const result = formatForTitleGeneration(entries, 100);

    expect(result).toBe('user: hello');
  });

  it('maxLength 超過時は末尾（最新）を優先する', () => {
    const entries: ConversationEntry[] = [
      { role: 'user', text: 'A'.repeat(50) },
      { role: 'assistant', text: 'B'.repeat(50) },
      { role: 'user', text: 'C'.repeat(20) },
    ];

    // "user: " + A*50 = 56, "assistant: " + B*50 = 61, "user: " + C*20 = 26
    // 全体 = 56 + 1 + 61 + 1 + 26 = 145
    // maxLength を 90 にすると最新の2行(61 + 1 + 26 = 88)が入る
    const result = formatForTitleGeneration(entries, 90);

    expect(result).toContain('B'.repeat(50));
    expect(result).toContain('C'.repeat(20));
    expect(result).not.toContain('A'.repeat(50));
  });

  it('空配列は空文字を返す', () => {
    const result = formatForTitleGeneration([], 100);

    expect(result).toBe('');
  });
});
