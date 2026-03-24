import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore, listDirectories } from './workspace-store.js';

describe('WorkspaceStore', () => {
  let tempDir: string;
  let filePath: string;
  let existingDir1: string;
  let existingDir2: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ws-test-'));
    filePath = join(tempDir, 'workspaces.json');
    existingDir1 = join(tempDir, 'project-a');
    existingDir2 = join(tempDir, 'project-b');
    mkdirSync(existingDir1);
    mkdirSync(existingDir2);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('JSON ファイルが存在しない場合は空リスト', () => {
    const store = new WorkspaceStore(filePath);
    expect(store.list()).toEqual([]);
  });

  it('add() でワークスペースが追加され list() で取得できる', () => {
    const store = new WorkspaceStore(filePath);
    store.add({ name: 'project-a', path: existingDir1 });
    expect(store.list()).toEqual([{ name: 'project-a', path: existingDir1 }]);
  });

  it('add() で JSON ファイルに永続化される', () => {
    const store = new WorkspaceStore(filePath);
    store.add({ name: 'project-a', path: existingDir1 });

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw.workspaces).toEqual([{ name: 'project-a', path: existingDir1 }]);
  });

  it('remove() でワークスペースが削除される', () => {
    const store = new WorkspaceStore(filePath);
    store.add({ name: 'project-a', path: existingDir1 });
    const removed = store.remove('project-a');
    expect(removed).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('remove() で存在しない名前は false を返す', () => {
    const store = new WorkspaceStore(filePath);
    expect(store.remove('nonexistent')).toBe(false);
  });

  it('同名のワークスペースを追加するとエラー', () => {
    const store = new WorkspaceStore(filePath);
    store.add({ name: 'project-a', path: existingDir1 });
    expect(() => store.add({ name: 'project-a', path: existingDir2 })).toThrow(
      '既に登録されています',
    );
  });

  it('findByName() で名前からワークスペースを検索できる', () => {
    const store = new WorkspaceStore(filePath);
    store.add({ name: 'project-a', path: existingDir1 });
    expect(store.findByName('project-a')).toEqual({ name: 'project-a', path: existingDir1 });
    expect(store.findByName('nonexistent')).toBeUndefined();
  });

  it('load() で JSON ファイルから復元される', () => {
    const store1 = new WorkspaceStore(filePath);
    store1.add({ name: 'project-a', path: existingDir1 });
    store1.add({ name: 'project-b', path: existingDir2 });

    // 新しいインスタンスで読み込み
    const store2 = new WorkspaceStore(filePath);
    expect(store2.list()).toEqual([
      { name: 'project-a', path: existingDir1 },
      { name: 'project-b', path: existingDir2 },
    ]);
  });

  it('JSON ファイルが壊れている場合は空リスト', () => {
    writeFileSync(filePath, 'not json!!!', 'utf-8');
    const store = new WorkspaceStore(filePath);
    expect(store.list()).toEqual([]);
  });

  it('JSON に workspaces プロパティがない場合は空リスト', () => {
    writeFileSync(filePath, '{"other": 1}', 'utf-8');
    const store = new WorkspaceStore(filePath);
    expect(store.list()).toEqual([]);
  });

  it('ワークスペース名に不正な文字を含むとエラー', () => {
    const store = new WorkspaceStore(filePath);
    expect(() => store.add({ name: 'has space', path: existingDir1 })).toThrow(
      '英数字・ハイフン・アンダースコアのみ',
    );
    expect(() => store.add({ name: 'has/slash', path: existingDir1 })).toThrow(
      '英数字・ハイフン・アンダースコアのみ',
    );
  });

  it('相対パスを指定するとエラー', () => {
    const store = new WorkspaceStore(filePath);
    expect(() => store.add({ name: 'test', path: 'relative/path' })).toThrow('絶対パス');
  });

  it('存在しないパスを指定するとエラー', () => {
    const store = new WorkspaceStore(filePath);
    expect(() => store.add({ name: 'test', path: '/nonexistent/path/12345' })).toThrow(
      'ディレクトリが見つかりません',
    );
  });

  it('list() は内部配列のコピーを返す', () => {
    const store = new WorkspaceStore(filePath);
    store.add({ name: 'project-a', path: existingDir1 });
    const list = store.list();
    list.push({ name: 'injected', path: '/tmp' });
    expect(store.list()).toHaveLength(1);
  });
});

describe('listDirectories', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ls-dir-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('サブディレクトリの名前をソートして返す', () => {
    mkdirSync(join(tempDir, 'beta'));
    mkdirSync(join(tempDir, 'alpha'));
    mkdirSync(join(tempDir, 'gamma'));
    writeFileSync(join(tempDir, 'file.txt'), 'content');

    expect(listDirectories(tempDir)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('隠しディレクトリを除外する', () => {
    mkdirSync(join(tempDir, '.hidden'));
    mkdirSync(join(tempDir, 'visible'));

    expect(listDirectories(tempDir)).toEqual(['visible']);
  });

  it('node_modules を除外する', () => {
    mkdirSync(join(tempDir, 'node_modules'));
    mkdirSync(join(tempDir, 'src'));

    expect(listDirectories(tempDir)).toEqual(['src']);
  });

  it('存在しないパスでは空配列を返す', () => {
    expect(listDirectories('/nonexistent/path/12345')).toEqual([]);
  });

  it('空ディレクトリでは空配列を返す', () => {
    expect(listDirectories(tempDir)).toEqual([]);
  });
});
