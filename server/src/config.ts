import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 設定。プラットフォーム固有の設定はネストしたオブジェクトで持ち、
 * 対応する環境変数が設定されているプラットフォームだけを起動する。
 */

export interface DiscordSettings {
  token: string;
  channelId: string;
}

export interface Config {
  claudePath: string;
  geminiApiKey: string | null;
  workspacesFile: string;
  workspaceBaseDir: string;
  /** 会話・ターン・分岐を保存する SQLite ファイル */
  databaseFile: string;
  allowedUserIds: string[];
  discord: DiscordSettings | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

export function loadConfig(): Config {
  const discord = process.env.DISCORD_TOKEN
    ? {
        token: requireEnv('DISCORD_TOKEN'),
        channelId: requireEnv('CHANNEL_ID'),
      }
    : null;

  return {
    claudePath: process.env.CLAUDE_PATH || 'claude',
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    workspacesFile: process.env.WORKSPACES_FILE || 'workspaces.json',
    workspaceBaseDir: process.env.WORKSPACE_BASE_DIR || homedir(),
    databaseFile: process.env.DATABASE_FILE || join(process.cwd(), 'bridge.db'),
    allowedUserIds: requireEnv('ALLOWED_USER_IDS')
      .split(',')
      .map((id) => id.trim()),
    discord,
  };
}
