import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setValidEnv() {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.CHANNEL_ID = '123456789';
    process.env.ALLOWED_USER_IDS = '111,222,333';
    // オプショナル環境変数をクリア（テスト環境の漏れ防止）
    delete process.env.GEMINI_API_KEY;
    delete process.env.WORKSPACES_FILE;
    delete process.env.WORKSPACE_BASE_DIR;
    delete process.env.THREAD_SESSIONS_FILE;
  }

  // ----- 正常系 -----

  describe('正常系', () => {
    it('全必須項目が揃っている場合、Config を返す', () => {
      setValidEnv();

      const config = loadConfig();

      expect(config).toEqual({
        discordToken: 'test-token',
        channelId: '123456789',
        allowedUserIds: ['111', '222', '333'],
        claudePath: 'claude',
        geminiApiKey: null,
        workspacesFile: 'workspaces.json',
        workspaceBaseDir: homedir(),
        threadSessionsFile: join(process.cwd(), 'thread-sessions.json'),
      });
    });

    it('ALLOWED_USER_IDS の各値が trim される', () => {
      setValidEnv();
      process.env.ALLOWED_USER_IDS = ' 111 , 222 , 333 ';

      const config = loadConfig();

      expect(config.allowedUserIds).toEqual(['111', '222', '333']);
    });

    it('ALLOWED_USER_IDS が単一値の場合も配列で返す', () => {
      setValidEnv();
      process.env.ALLOWED_USER_IDS = '111';

      const config = loadConfig();

      expect(config.allowedUserIds).toEqual(['111']);
    });

    it('CLAUDE_PATH が設定されている場合はその値を使用', () => {
      setValidEnv();
      process.env.CLAUDE_PATH = '/usr/local/bin/claude';

      const config = loadConfig();

      expect(config.claudePath).toBe('/usr/local/bin/claude');
    });

    it('CLAUDE_PATH が未設定の場合はデフォルト値 "claude"', () => {
      setValidEnv();
      delete process.env.CLAUDE_PATH;

      const config = loadConfig();

      expect(config.claudePath).toBe('claude');
    });

    it('WORKSPACES_FILE が設定されている場合はその値を使用', () => {
      setValidEnv();
      process.env.WORKSPACES_FILE = 'custom-workspaces.json';

      const config = loadConfig();

      expect(config.workspacesFile).toBe('custom-workspaces.json');
    });

    it('オプショナル環境変数が全て設定されている場合はその値を使用', () => {
      setValidEnv();
      process.env.GEMINI_API_KEY = 'test-gemini-key';
      process.env.WORKSPACE_BASE_DIR = '/custom/base';
      process.env.THREAD_SESSIONS_FILE = '/custom/thread-sessions.json';

      const config = loadConfig();

      expect(config.geminiApiKey).toBe('test-gemini-key');
      expect(config.workspaceBaseDir).toBe('/custom/base');
      expect(config.threadSessionsFile).toBe('/custom/thread-sessions.json');
    });
  });

  // ----- 異常系（必須項目の欠落） -----

  describe('異常系', () => {
    it('DISCORD_TOKEN が未設定 → エラー', () => {
      setValidEnv();
      delete process.env.DISCORD_TOKEN;

      expect(() => loadConfig()).toThrow('DISCORD_TOKEN');
    });

    it('CHANNEL_ID が未設定 → エラー', () => {
      setValidEnv();
      delete process.env.CHANNEL_ID;

      expect(() => loadConfig()).toThrow('CHANNEL_ID');
    });

    it('ALLOWED_USER_IDS が未設定 → エラー', () => {
      setValidEnv();
      delete process.env.ALLOWED_USER_IDS;

      expect(() => loadConfig()).toThrow('ALLOWED_USER_IDS');
    });

    it('DISCORD_TOKEN が空文字列 → エラー', () => {
      setValidEnv();
      process.env.DISCORD_TOKEN = '';

      expect(() => loadConfig()).toThrow('DISCORD_TOKEN');
    });
  });
});
