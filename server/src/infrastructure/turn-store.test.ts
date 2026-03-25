import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnStore } from './turn-store.js';
import * as sessionStore from './session-store.js';
import { vi } from 'vitest';

let tempDir: string;
let turnsDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'turn-store-test-'));
  turnsDir = join(tempDir, 'project');
  await mkdir(turnsDir, { recursive: true });
  vi.spyOn(sessionStore, 'projectDir').mockReturnValue(turnsDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('TurnStore', () => {
  describe('record', () => {
    it('turns.json にエントリが書き込まれる', async () => {
      const store = new TurnStore();

      await store.record('session-1', '/work', 1, 'msg-111');

      const raw = await readFile(join(turnsDir, 'session-1.turns.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data).toEqual({ '1': 'msg-111' });
    });

    it('複数ターンを順に記録できる', async () => {
      const store = new TurnStore();

      await store.record('session-1', '/work', 1, 'msg-111');
      await store.record('session-1', '/work', 2, 'msg-222');
      await store.record('session-1', '/work', 3, 'msg-333');

      const raw = await readFile(join(turnsDir, 'session-1.turns.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data).toEqual({ '1': 'msg-111', '2': 'msg-222', '3': 'msg-333' });
    });
  });

  describe('findTurn', () => {
    it('Discord メッセージ ID からターン番号を逆引きできる', async () => {
      const store = new TurnStore();
      await store.record('session-1', '/work', 1, 'msg-111');
      await store.record('session-1', '/work', 2, 'msg-222');

      const turn = await store.findTurn('session-1', '/work', 'msg-222');

      expect(turn).toBe(2);
    });

    it('存在しない ID は null を返す', async () => {
      const store = new TurnStore();
      await store.record('session-1', '/work', 1, 'msg-111');

      const turn = await store.findTurn('session-1', '/work', 'msg-999');

      expect(turn).toBeNull();
    });

    it('turns.json が存在しない場合に null を返す', async () => {
      const store = new TurnStore();

      const turn = await store.findTurn('nonexistent', '/work', 'msg-111');

      expect(turn).toBeNull();
    });
  });

  describe('copyTo', () => {
    it('指定ターンまでのエントリがコピーされる', async () => {
      const store = new TurnStore();
      await store.record('source', '/work', 1, 'msg-111');
      await store.record('source', '/work', 2, 'msg-222');
      await store.record('source', '/work', 3, 'msg-333');

      await store.copyTo('source', 'target', '/work', 2);

      const raw = await readFile(join(turnsDir, 'target.turns.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data).toEqual({ '1': 'msg-111', '2': 'msg-222' });
    });

    it('ソースが存在しない場合は空のマッピングがコピーされる', async () => {
      const store = new TurnStore();

      await store.copyTo('nonexistent', 'target', '/work', 2);

      const raw = await readFile(join(turnsDir, 'target.turns.json'), 'utf-8');
      const data = JSON.parse(raw);
      expect(data).toEqual({});
    });
  });
});
