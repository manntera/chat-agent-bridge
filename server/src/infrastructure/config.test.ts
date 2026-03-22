import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    process.env.WORK_DIR = '/home/user/projects';
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
        workDir: '/home/user/projects',
        claudePath: 'claude',
        geminiApiKey: null,
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

    it('WORK_DIR が未設定 → エラー', () => {
      setValidEnv();
      delete process.env.WORK_DIR;

      expect(() => loadConfig()).toThrow('WORK_DIR');
    });

    it('DISCORD_TOKEN が空文字列 → エラー', () => {
      setValidEnv();
      process.env.DISCORD_TOKEN = '';

      expect(() => loadConfig()).toThrow('DISCORD_TOKEN');
    });
  });
});
