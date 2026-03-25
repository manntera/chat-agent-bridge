import { stat } from 'node:fs/promises';
import type { SessionContext } from '../domain/session-manager.js';
import type { ThreadSender } from './discord-notifier.js';
import type { ThreadMapping } from './thread-mapping-store.js';

export interface SessionRestorerDeps {
  threadMappingStore: {
    get(threadId: string): ThreadMapping | null;
    remove(threadId: string): Promise<void>;
  };
  sessionManager: { remove(threadId: string): void };
  createSession: (
    threadId: string,
    thread: ThreadSender,
    workspace: { name: string; path: string },
  ) => SessionContext;
  log: (msg: string) => void;
}

export class SessionRestorer {
  private readonly pendingRestorations = new Map<string, Promise<SessionContext | null>>();
  private readonly deps: SessionRestorerDeps;

  constructor(deps: SessionRestorerDeps) {
    this.deps = deps;
  }

  /**
   * ディスクのマッピングからセッションを遅延復元する。
   * 並行メッセージによる二重復元を排他制御する。
   *
   * 2番目の呼び出し元は同じ SessionContext を受け取るが、
   * オーケストレータが既に busy 状態のため「処理中」として弾かれる（想定動作）。
   */
  async tryRestore(threadId: string, thread: ThreadSender): Promise<SessionContext | null> {
    const pending = this.pendingRestorations.get(threadId);
    if (pending) {
      return pending;
    }

    const mapping = this.deps.threadMappingStore.get(threadId);
    if (!mapping) return null;

    const restorationPromise = this.doRestore(threadId, thread, mapping);

    this.pendingRestorations.set(threadId, restorationPromise);
    try {
      return await restorationPromise;
    } finally {
      this.pendingRestorations.delete(threadId);
    }
  }

  private async doRestore(
    threadId: string,
    thread: ThreadSender,
    mapping: ThreadMapping,
  ): Promise<SessionContext | null> {
    // workDir の存在チェック（ディレクトリであることも確認）
    try {
      const s = await stat(mapping.workDir);
      if (!s.isDirectory()) throw new Error('Not a directory');
    } catch {
      thread
        .send(
          'セッションの復元に失敗しました。ワークディレクトリが見つかりません。`/cc resume` で再開するか、`/cc new` で新しいセッションを開始してください。',
        )
        .catch((err) => console.error('Discord send error:', err));
      await this.deps.threadMappingStore.remove(threadId).catch(() => {});
      return null;
    }

    // セッション作成・復元（createSession / restore 両方をカバー）
    try {
      const restoredCtx = this.deps.createSession(threadId, thread, {
        name: mapping.workspaceName,
        path: mapping.workDir,
      });

      restoredCtx.session.restore(mapping.sessionId);

      this.deps.log(
        `セッション復元: ${mapping.workspaceName} [${mapping.sessionId.slice(0, 8)}...] (thread: ${threadId})`,
      );
      return restoredCtx;
    } catch (err) {
      console.error('Session restore error:', err);
      this.deps.sessionManager.remove(threadId);
      await this.deps.threadMappingStore.remove(threadId).catch(() => {});
      thread
        .send(
          'セッションの復元に失敗しました。`/cc resume` で再開するか、`/cc new` で新しいセッションを開始してください。',
        )
        .catch((e) => console.error('Discord send error:', e));
      return null;
    }
  }
}
