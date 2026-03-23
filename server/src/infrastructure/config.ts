import { homedir } from 'node:os';

export interface Config {
  discordToken: string;
  channelId: string;
  allowedUserIds: string[];
  claudePath: string;
  geminiApiKey: string | null;
  workspacesFile: string;
  workspaceBaseDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    discordToken: requireEnv('DISCORD_TOKEN'),
    channelId: requireEnv('CHANNEL_ID'),
    allowedUserIds: requireEnv('ALLOWED_USER_IDS')
      .split(',')
      .map((id) => id.trim()),
    claudePath: process.env.CLAUDE_PATH || 'claude',
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    workspacesFile: process.env.WORKSPACES_FILE || 'workspaces.json',
    workspaceBaseDir: process.env.WORKSPACE_BASE_DIR || homedir(),
  };
}
