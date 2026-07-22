import 'dotenv/config';
import { AccessControl } from './core/access-control.js';
import { ClaudeProcess } from './claude/claude-process.js';
import { SessionStore } from './claude/session-store.js';
import { UsageFetcher } from './claude/usage-fetcher.js';
import { ConversationStore } from './store/conversation-store.js';
import { ConversationHub } from './app/runtime.js';
import { BridgeApp } from './app/use-cases.js';
import { ReportGenerator } from './services/report-generator.js';
import { TitleGenerator } from './services/title-generator.js';
import { WorkspaceStore } from './services/workspace-store.js';
import { startDiscordAdapter } from './platforms/discord/adapter.js';
import { DISCORD_CAPABILITIES } from './platforms/discord/renderer.js';
import type { PlatformCapabilities } from './app/ports.js';
import { loadConfig } from './config.js';
import { log } from './helpers.js';

/**
 * 合成ルート。
 * プラットフォーム非依存のコアを組み立て、設定が存在するプラットフォームの
 * アダプタだけを起動する。新しいチャットツール対応は
 * platforms/<name>/ の追加とここへの数行で完結する。
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // ---- プラットフォーム非依存のコア ----
  const workspaceStore = new WorkspaceStore(config.workspacesFile);
  log(`ワークスペース: ${workspaceStore.list().length} 件登録済み`);

  const store = new ConversationStore(config.databaseFile);
  log(`会話ストア: ${config.databaseFile}`);

  const usageFetcher = new UsageFetcher();
  const titleGenerator = config.geminiApiKey ? new TitleGenerator(config.geminiApiKey) : null;
  const reportGenerator = config.geminiApiKey ? new ReportGenerator(config.geminiApiKey) : null;
  const sessionCatalog = new SessionStore();

  // プラットフォームごとの能力宣言。Claude への追加システムプロンプトはここから引く
  const capabilities: Record<string, PlatformCapabilities> = {
    discord: DISCORD_CAPABILITIES,
  };

  const hub = new ConversationHub({
    store,
    usageFetcher,
    titleGenerator,
    createProcess: (ref, onProgress, onProcessEnd) =>
      new ClaudeProcess(
        {
          claudePath: config.claudePath,
          systemPromptAppend: capabilities[ref.platform]?.markdownGuidance ?? '',
        },
        onProgress,
        onProcessEnd,
      ),
    log,
  });

  // ---- アダプタ起動 ----
  if (config.discord) {
    const accessControl = new AccessControl({
      allowedUserIds: config.allowedUserIds,
      channelId: config.discord.channelId,
    });
    const app = new BridgeApp({
      hub,
      store,
      accessControl,
      workspaceStore,
      sessionCatalog,
      reportGenerator,
      log,
    });
    await startDiscordAdapter(config.discord, {
      app,
      accessControl,
      workspaceStore,
      workspaceBaseDir: config.workspaceBaseDir,
    });
  } else {
    throw new Error(
      '起動可能なプラットフォーム設定がありません(DISCORD_TOKEN 等を設定してください)',
    );
  }
}

main().catch(console.error);
