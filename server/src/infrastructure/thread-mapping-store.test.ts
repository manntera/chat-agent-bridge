import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThreadMappingStore } from './thread-mapping-store.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'thread-mapping-store-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ThreadMappingStore', () => {
  it('set() でマッピングを追加し、get() で取得できる', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store = new ThreadMappingStore(filePath);

    store.set('thread-1', {
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });

    const result = store.get('thread-1');
    expect(result).toEqual({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
  });

  it('set() がJSONファイルに永続化される', async () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store = new ThreadMappingStore(filePath);

    store.set('thread-1', {
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });

    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.mappings['thread-1']).toEqual({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
  });

  it('永続化されたファイルから新しいインスタンスで読み込める', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store1 = new ThreadMappingStore(filePath);

    store1.set('thread-1', {
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });

    // 新しいインスタンスで読み込む
    const store2 = new ThreadMappingStore(filePath);
    const result = store2.get('thread-1');
    expect(result).toEqual({
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
  });

  it('remove() でマッピングを削除できる', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store = new ThreadMappingStore(filePath);

    store.set('thread-1', {
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });

    store.remove('thread-1');

    expect(store.get('thread-1')).toBeNull();
  });

  it('remove() がファイルにも反映される', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store1 = new ThreadMappingStore(filePath);

    store1.set('thread-1', {
      sessionId: 'session-abc',
      workDir: '/home/user/project',
      workspaceName: 'my-project',
    });
    store1.remove('thread-1');

    // 新しいインスタンスで確認
    const store2 = new ThreadMappingStore(filePath);
    expect(store2.get('thread-1')).toBeNull();
  });

  it('同じ threadId を上書きできる', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store = new ThreadMappingStore(filePath);

    store.set('thread-1', {
      sessionId: 'session-old',
      workDir: '/home/user/old',
      workspaceName: 'old-project',
    });

    store.set('thread-1', {
      sessionId: 'session-new',
      workDir: '/home/user/new',
      workspaceName: 'new-project',
    });

    const result = store.get('thread-1');
    expect(result).toEqual({
      sessionId: 'session-new',
      workDir: '/home/user/new',
      workspaceName: 'new-project',
    });
  });

  it('存在しない threadId に対して get() は null を返す', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store = new ThreadMappingStore(filePath);

    expect(store.get('nonexistent')).toBeNull();
  });

  it('ファイルが存在しない場合は空マップで開始する', () => {
    const filePath = join(tempDir, 'nonexistent', 'thread-sessions.json');
    const store = new ThreadMappingStore(filePath);

    expect(store.get('thread-1')).toBeNull();
  });

  it('壊れたファイルの場合は空マップで開始し、警告ログを出す', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    writeFileSync(filePath, 'this is not valid json!!!', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = new ThreadMappingStore(filePath);

    expect(store.get('thread-1')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('thread-sessions.json の読み込みに失敗しました'),
    );

    warnSpy.mockRestore();
  });

  it('不正な形式のファイル（mappingsフィールドなし）の場合は空マップで開始する', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    writeFileSync(filePath, JSON.stringify({ foo: 'bar' }), 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = new ThreadMappingStore(filePath);

    expect(store.get('thread-1')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('thread-sessions.json の形式が不正です'),
    );

    warnSpy.mockRestore();
  });

  it('不正な形式のファイル（mappingsが配列）の場合は空マップで開始する', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    writeFileSync(filePath, JSON.stringify({ mappings: ['not', 'an', 'object'] }), 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = new ThreadMappingStore(filePath);

    expect(store.get('thread-1')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('thread-sessions.json の形式が不正です'),
    );

    warnSpy.mockRestore();
  });

  it('複数のマッピングを管理できる', () => {
    const filePath = join(tempDir, 'thread-sessions.json');
    const store = new ThreadMappingStore(filePath);

    store.set('thread-1', {
      sessionId: 'session-1',
      workDir: '/home/user/project1',
      workspaceName: 'project1',
    });
    store.set('thread-2', {
      sessionId: 'session-2',
      workDir: '/home/user/project2',
      workspaceName: 'project2',
    });

    expect(store.get('thread-1')?.sessionId).toBe('session-1');
    expect(store.get('thread-2')?.sessionId).toBe('session-2');
  });
});
