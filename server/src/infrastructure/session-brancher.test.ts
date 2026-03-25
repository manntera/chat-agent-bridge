import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionBrancher } from './session-brancher.js';
import { TurnStore } from './turn-store.js';
import * as sessionStore from './session-store.js';

let tempDir: string;
let projDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-brancher-test-'));
  projDir = join(tempDir, 'project');
  await mkdir(projDir, { recursive: true });
  vi.spyOn(sessionStore, 'projectDir').mockReturnValue(projDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function userLine(content: string, slug?: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    ...(slug ? { slug } : {}),
  });
}

function assistantLine(content: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: content }] },
  });
}

function metadataLine(): string {
  return JSON.stringify({ type: 'file-history-snapshot', messageId: 'test', snapshot: {} });
}

describe('SessionBrancher', () => {
  it('JSONL が指定ターンまで正しく切り詰められる', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    const lines = [
      userLine('質問1'),
      assistantLine('回答1'),
      userLine('質問2'),
      assistantLine('回答2'),
      userLine('質問3'),
      assistantLine('回答3'),
    ];
    await writeFile(join(projDir, 'original.jsonl'), lines.join('\n'));

    const newId = await brancher.branch('original', '/work', 2);

    const newContent = await readFile(join(projDir, `${newId}.jsonl`), 'utf-8');
    const newLines = newContent.trim().split('\n');
    expect(newLines).toHaveLength(4); // Turn 1 + Turn 2 = 4行
    expect(JSON.parse(newLines[0]).type).toBe('user');
    expect(JSON.parse(newLines[1]).type).toBe('assistant');
    expect(JSON.parse(newLines[2]).type).toBe('user');
    expect(JSON.parse(newLines[3]).type).toBe('assistant');
  });

  it('新しい JSONL ファイルが新セッション ID で作成される', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    const lines = [userLine('質問1'), assistantLine('回答1')];
    await writeFile(join(projDir, 'original.jsonl'), lines.join('\n'));

    const newId = await brancher.branch('original', '/work', 1);

    expect(newId).not.toBe('original');
    const exists = await readFile(join(projDir, `${newId}.jsonl`), 'utf-8');
    expect(exists).toBeTruthy();
  });

  it('元の JSONL は変更されない', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    const lines = [
      userLine('質問1'),
      assistantLine('回答1'),
      userLine('質問2'),
      assistantLine('回答2'),
    ];
    const original = lines.join('\n');
    await writeFile(join(projDir, 'original.jsonl'), original);

    await brancher.branch('original', '/work', 1);

    const afterBranch = await readFile(join(projDir, 'original.jsonl'), 'utf-8');
    expect(afterBranch).toBe(original);
  });

  it('metadata 行（snapshot 等）が保持される', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    const lines = [
      metadataLine(),
      userLine('質問1', 'my-slug'),
      assistantLine('回答1'),
      userLine('質問2'),
      assistantLine('回答2'),
    ];
    await writeFile(join(projDir, 'original.jsonl'), lines.join('\n'));

    const newId = await brancher.branch('original', '/work', 1);

    const newContent = await readFile(join(projDir, `${newId}.jsonl`), 'utf-8');
    const newLines = newContent.trim().split('\n');
    // metadata + user + assistant = 3行
    expect(newLines).toHaveLength(3);
    expect(JSON.parse(newLines[0]).type).toBe('file-history-snapshot');
    expect(JSON.parse(newLines[1]).slug).toBe('my-slug');
  });

  it('turns.json が新セッションにコピーされる', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    await turnStore.record('original', '/work', 1, 'msg-111');
    await turnStore.record('original', '/work', 2, 'msg-222');
    await turnStore.record('original', '/work', 3, 'msg-333');

    const lines = [
      userLine('質問1'),
      assistantLine('回答1'),
      userLine('質問2'),
      assistantLine('回答2'),
      userLine('質問3'),
      assistantLine('回答3'),
    ];
    await writeFile(join(projDir, 'original.jsonl'), lines.join('\n'));

    const newId = await brancher.branch('original', '/work', 2);

    // 新セッションの turns.json に Turn 1, 2 のみがコピーされている
    const turn1 = await turnStore.findTurn(newId, '/work', 'msg-111');
    const turn2 = await turnStore.findTurn(newId, '/work', 'msg-222');
    const turn3 = await turnStore.findTurn(newId, '/work', 'msg-333');
    expect(turn1).toBe(1);
    expect(turn2).toBe(2);
    expect(turn3).toBeNull();
  });

  it('targetTurn が 0 の場合はメタデータ行のみの空セッションが作成される', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    const lines = [metadataLine(), userLine('質問1'), assistantLine('回答1')];
    await writeFile(join(projDir, 'original.jsonl'), lines.join('\n'));

    const newId = await brancher.branch('original', '/work', 0);

    const newContent = await readFile(join(projDir, `${newId}.jsonl`), 'utf-8');
    const newLines = newContent
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '');
    // メタデータ行のみ
    expect(newLines).toHaveLength(1);
    expect(JSON.parse(newLines[0]).type).toBe('file-history-snapshot');
  });

  it('targetTurn が 0 でメタデータなしの場合は空ファイルが作成される', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    const lines = [userLine('質問1'), assistantLine('回答1')];
    await writeFile(join(projDir, 'original.jsonl'), lines.join('\n'));

    const newId = await brancher.branch('original', '/work', 0);

    const newContent = await readFile(join(projDir, `${newId}.jsonl`), 'utf-8');
    expect(newContent).toBe('');
  });

  it('targetTurn が実際のターン数を超える場合にエラーを投げる', async () => {
    const turnStore = new TurnStore();
    const brancher = new SessionBrancher(turnStore);

    const lines = [userLine('質問1'), assistantLine('回答1')];
    await writeFile(join(projDir, 'original.jsonl'), lines.join('\n'));

    await expect(brancher.branch('original', '/work', 5)).rejects.toThrow(
      'Turn 5 が見つかりません（全 1 ターン）',
    );
  });
});
