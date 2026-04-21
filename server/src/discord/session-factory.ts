import { Orchestrator } from '../domain/orchestrator.js';
import { Session } from '../domain/session.js';
import { SessionManager, type SessionContext } from '../domain/session-manager.js';
import type { IUsageFetcher, Notification, ProgressEvent, Workspace } from '../domain/types.js';
import { ClaudeProcess } from '../infrastructure/claude-process.js';
import type { Config } from '../infrastructure/config.js';
import { createNotifier, type ThreadSender } from '../infrastructure/discord-notifier.js';
import type { ITitleGenerator } from '../infrastructure/title-generator.js';
import type { ThreadMappingStore } from '../infrastructure/thread-mapping-store.js';
import { log, logNotification } from '../helpers.js';

export interface SessionFactoryDeps {
  config: Pick<Config, 'claudePath'>;
  sessionManager: SessionManager;
  usageFetcher: IUsageFetcher;
  titleGenerator: ITitleGenerator | null;
}

export type CreateSessionFn = (
  threadId: string,
  thread: ThreadSender,
  workspace: Workspace,
) => SessionContext;

/**
 * SessionContext を組み立てて SessionManager に登録する関数を生成する。
 *
 * 以下の依存オブジェクトをクロージャに取り込み、呼び出し側は
 * (threadId, thread, workspace) を渡すだけで良い形にする。
 */
export function createSessionFactory(deps: SessionFactoryDeps): CreateSessionFn {
  const { config, sessionManager, usageFetcher, titleGenerator } = deps;

  return (threadId, thread, workspace) => {
    const session = new Session(workspace.path, workspace.name);

    // Orchestrator は ClaudeProcess を必要とし、ClaudeProcess のコールバックは
    // Orchestrator を必要とする循環依存のため、ここで no-op プレースホルダを作り、
    // Orchestrator 生成後に再代入する (ClaudeProcess.spawn() が呼ばれるのは
    // Orchestrator 経由なので、実行時に no-op が呼ばれることはない)。
    let onProgress: (event: ProgressEvent) => void = () => {};
    let onProcessEnd: (exitCode: number, output: string) => void = () => {};

    const claudeProcess = new ClaudeProcess(
      config.claudePath,
      (event) => onProgress(event),
      (exitCode, output) => onProcessEnd(exitCode, output),
    );

    const notifier = createNotifier(thread);
    const notify = (notification: Notification): void => {
      logNotification(notification);
      notifier.notify(notification);
    };

    const orchestrator = new Orchestrator(session, claudeProcess, notify, usageFetcher);

    onProgress = (event) => orchestrator.onProgress(event);
    onProcessEnd = (exitCode, output) => {
      log(`ClaudeProcess 終了 (exitCode: ${exitCode}, thread: ${threadId})`);
      orchestrator.onProcessEnd(exitCode, output);
      notifier.dispose();

      // タイトル生成（非同期・失敗しても無視）
      if (titleGenerator && session.sessionId) {
        titleGenerator
          .generate(session.sessionId, session.workDir)
          .then((title) => {
            if (title) {
              log(`タイトル生成: "${title}" (thread: ${threadId})`);
              thread
                .setName(title)
                .catch((err: unknown) => console.error('Thread setName error:', err));
            }
          })
          .catch((err) => console.error('Title generation error:', err));
      }
    };

    const ctx: SessionContext = {
      orchestrator,
      session,
      claudeProcess,
      threadId,
      setAuthorId: (authorId) => notifier.setAuthorId(authorId),
    };
    sessionManager.register(threadId, ctx);
    return ctx;
  };
}

export type PersistMappingFn = (
  threadId: string,
  sessionId: string,
  workspace: Workspace,
) => Promise<void>;

/**
 * threadId ↔ sessionId/workDir/workspaceName のマッピングをディスクに
 * 書き込むコールバックを生成する。サーバー再起動後のセッション復元
 * (docs/19_Session_Persistence) の根幹となる処理。
 */
export function createPersistMapping(threadMappingStore: ThreadMappingStore): PersistMappingFn {
  return (threadId, sessionId, workspace) =>
    threadMappingStore.set(threadId, {
      sessionId,
      workDir: workspace.path,
      workspaceName: workspace.name,
    });
}
