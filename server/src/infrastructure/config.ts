export interface Config {
  discordToken: string;
  channelId: string;
  allowedUserIds: string[];
  workDir: string;
  claudePath: string;
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
    workDir: requireEnv('WORK_DIR'),
    claudePath: process.env.CLAUDE_PATH || 'claude',
  };
}
