import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  extractFirstUserMessage,
  getDayBoundary,
  projectDir,
  SessionStore,
} from './session-store.js';

let tempDir: string;
let sessionDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-store-test-'));
  sessionDir = join(tempDir, 'sessions');
  await mkdir(sessionDir);
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

// ================================
// extractFirstUserMessage
// ================================

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

  it('slug が user メッセージより前の行にある場合も取得する', async () => {
    const filePath = join(tempDir, 'slug-before.jsonl');
    const lines = [
      JSON.stringify({ slug: 'my-slug', type: 'system', data: {} }),
      userLine('メッセージ'),
    ];
    await writeFile(filePath, lines.join('\n'));

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('メッセージ');
    expect(result.slug).toBe('my-slug');
  });

  it('content が非文字列・非配列の場合はスキップされる', async () => {
    const filePath = join(tempDir, 'test.jsonl');
    const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: 12345 } })];
    await writeFile(filePath, lines.join('\n'));

    const result = await extractFirstUserMessage(filePath);

    expect(result.text).toBe('(メッセージなし)');
  });
});

// ================================
// projectDir
// ================================

describe('projectDir', () => {
  it('ホームディレクトリの .claude/projects パスを返す', () => {
    const result = projectDir('/home/user/project');

    expect(result).toBe(join(homedir(), '.claude', 'projects', '-home-user-project'));
  });
});

// ================================
// getDayBoundary
// ================================

describe('getDayBoundary', () => {
  it('朝6時 JST を境界とする', () => {
    const date = new Date('2026-03-22T00:00:00+09:00');
    const { from, to } = getDayBoundary(date);

    expect(from.toISOString()).toBe('2026-03-21T21:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-22T21:00:00.000Z');
  });

  it('時間範囲は24時間', () => {
    const date = new Date('2026-03-22T12:00:00+09:00');
    const { from, to } = getDayBoundary(date);

    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('日付の時刻部分に関わらず同じ日なら同じ境界', () => {
    const morning = new Date('2026-03-22T08:00:00+09:00');
    const evening = new Date('2026-03-22T23:00:00+09:00');

    const { from: from1 } = getDayBoundary(morning);
    const { from: from2 } = getDayBoundary(evening);

    expect(from1.toISOString()).toBe(from2.toISOString());
  });
});

// ================================
// SessionStore (projectDirFn を注入してテスト)
// ================================

describe('SessionStore', () => {
  function createStore() {
    return new SessionStore(() => sessionDir);
  }

  describe('listSessions', () => {
    it('JSONL ファイルからセッション一覧を取得する', async () => {
      const store = createStore();
      await writeFile(join(sessionDir, 'aaa.jsonl'), userLine('タスクA', 'aaa'));
      await writeFile(join(sessionDir, 'bbb.jsonl'), userLine('タスクB', 'bbb'));

      const result = await store.listSessions('/any-work-dir');

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.sessionId)).toContain('aaa');
      expect(result.map((s) => s.sessionId)).toContain('bbb');
    });

    it('最終更新日の降順でソートされる', async () => {
      const store = createStore();
      const oldFile = join(sessionDir, 'old.jsonl');
      const newFile = join(sessionDir, 'new.jsonl');
      await writeFile(oldFile, userLine('古いタスク', 'old'));
      await writeFile(newFile, userLine('新しいタスク', 'new'));

      const pastDate = new Date('2026-01-01T00:00:00Z');
      await utimes(oldFile, pastDate, pastDate);

      const result = await store.listSessions('/any-work-dir');

      expect(result[0].sessionId).toBe('new');
      expect(result[1].sessionId).toBe('old');
    });

    it('最大 25 件に制限される', async () => {
      const store = createStore();
      for (let i = 0; i < 30; i++) {
        const id = `session-${String(i).padStart(3, '0')}`;
        await writeFile(join(sessionDir, `${id}.jsonl`), userLine(`タスク ${i}`, id));
      }

      const result = await store.listSessions('/any-work-dir');

      expect(result).toHaveLength(25);
    });

    it('空ディレクトリでは空配列を返す', async () => {
      const emptyDir = join(tempDir, 'empty');
      await mkdir(emptyDir);
      const store = new SessionStore(() => emptyDir);

      const result = await store.listSessions('/any-work-dir');

      expect(result).toEqual([]);
    });

    it('存在しないディレクトリでは空配列を返す', async () => {
      const store = new SessionStore(() => '/nonexistent/path/that/does/not/exist');

      const result = await store.listSessions('/any-work-dir');

      expect(result).toEqual([]);
    });

    it('.jsonl 以外のファイルは無視する', async () => {
      const store = createStore();
      await writeFile(join(sessionDir, 'aaa.jsonl'), userLine('タスクA', 'aaa'));
      await writeFile(join(sessionDir, 'readme.txt'), 'not a session');

      const result = await store.listSessions('/any-work-dir');

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('aaa');
    });

    it('読み込みに失敗するファイルはスキップされる', async () => {
      const store = createStore();
      await writeFile(join(sessionDir, 'good.jsonl'), userLine('タスクA', 'good'));
      // .jsonl という名前のディレクトリを作成 → createReadStream が失敗する
      await mkdir(join(sessionDir, 'bad.jsonl'));

      const result = await store.listSessions('/any-work-dir');

      // bad.jsonl はディレクトリなので stat.mtime は取れるが extractFirstUserMessage で失敗 → スキップ
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('good');
    });

    it('slug 付きのセッションが正しく読み込まれる', async () => {
      const store = createStore();
      await writeFile(join(sessionDir, 'aaa.jsonl'), userLine('タスクA', 'aaa', 'my-slug'));

      const result = await store.listSessions('/any-work-dir');

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('my-slug');
    });
  });

  describe('listSessionsByDateRange', () => {
    it('指定範囲内のセッションのみ返す', async () => {
      const store = createStore();
      const oldFile = join(sessionDir, 'old.jsonl');
      const inRangeFile = join(sessionDir, 'in-range.jsonl');
      const newFile = join(sessionDir, 'new.jsonl');

      await writeFile(oldFile, userLine('古いタスク', 'old'));
      await writeFile(inRangeFile, userLine('範囲内タスク', 'in-range'));
      await writeFile(newFile, userLine('新しいタスク', 'new'));

      await utimes(oldFile, new Date('2026-03-18T00:00:00Z'), new Date('2026-03-18T00:00:00Z'));
      await utimes(inRangeFile, new Date('2026-03-20T00:00:00Z'), new Date('2026-03-20T00:00:00Z'));
      await utimes(newFile, new Date('2026-03-22T12:00:00Z'), new Date('2026-03-22T12:00:00Z'));

      const from = new Date('2026-03-19T00:00:00Z');
      const to = new Date('2026-03-21T00:00:00Z');
      const result = await store.listSessionsByDateRange('/any-work-dir', from, to);

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('in-range');
    });

    it('範囲内にセッションがない場合は空配列を返す', async () => {
      const store = createStore();
      const file = join(sessionDir, 'outside.jsonl');
      await writeFile(file, userLine('範囲外', 'outside'));
      const outsideDate = new Date('2026-01-01T00:00:00Z');
      await utimes(file, outsideDate, outsideDate);

      const from = new Date('2026-03-20T00:00:00Z');
      const to = new Date('2026-03-21T00:00:00Z');
      const result = await store.listSessionsByDateRange('/any-work-dir', from, to);

      expect(result).toEqual([]);
    });

    it('昇順でソートされる', async () => {
      const store = createStore();
      const laterFile = join(sessionDir, 'later.jsonl');
      const earlierFile = join(sessionDir, 'earlier.jsonl');
      await writeFile(laterFile, userLine('後', 'later'));
      await writeFile(earlierFile, userLine('先', 'earlier'));

      await utimes(laterFile, new Date('2026-03-20T12:00:00Z'), new Date('2026-03-20T12:00:00Z'));
      await utimes(earlierFile, new Date('2026-03-20T06:00:00Z'), new Date('2026-03-20T06:00:00Z'));

      const from = new Date('2026-03-20T00:00:00Z');
      const to = new Date('2026-03-21T00:00:00Z');
      const result = await store.listSessionsByDateRange('/any-work-dir', from, to);

      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe('earlier');
      expect(result[1].sessionId).toBe('later');
    });
  });

  describe('デフォルトコンストラクタ', () => {
    it('デフォルトの projectDir 関数を使用する', () => {
      const store = new SessionStore();
      // デフォルトコンストラクタが動作することを確認（存在しないパスで空配列）
      expect(store.listSessions('/nonexistent/path')).resolves.toEqual([]);
    });
  });
});
