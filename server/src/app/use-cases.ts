import { randomUUID } from 'node:crypto';
import type { AccessControl } from '../core/access-control.js';
import {
  refKey,
  type ConversationRef,
  type SessionOptions,
  type SessionSummary,
  type Workspace,
} from '../core/types.js';
import { branchTranscript, countTranscriptTurns } from '../claude/transcript-brancher.js';
import { readSession } from '../claude/session-reader.js';
import { getDayBoundary } from '../claude/session-store.js';
import type { DailySession, IReportGenerator } from '../services/report-generator.js';
import { resolvePrompt, type Attachment } from '../services/attachment-resolver.js';
import type { IWorkspaceStore } from '../services/workspace-store.js';
import type { ConversationStore } from '../store/conversation-store.js';
import { parseDateInput, todayJST } from '../helpers.js';
import type { ConversationHandle } from './ports.js';
import { ConversationHub, type ConversationRuntime } from './runtime.js';

/**
 * プラットフォーム非依存のユースケース集。
 *
 * アダプタは「プラットフォームのイベント → このクラスの呼び出し → 戻り値の描画」
 * だけを行う薄い層になる。ここに discord.js / Slack SDK の型を持ち込まないこと。
 */

export interface InboundMessage {
  ref: ConversationRef;
  authorId: string;
  authorIsBot: boolean;
  /** アクセス制御の対象チャンネル(スレッドの場合は親チャンネル) */
  channelId: string;
  text: string;
  attachments: Attachment[];
  platformMessageId: string;
  /** 返信(リプライ)元メッセージ ID。巻き戻しトリガーの判定に使う */
  replyToMessageId: string | null;
}

export type InterruptResult = 'no-session' | 'not-busy' | 'already-interrupting' | 'ok';

export interface ResumableSession extends SessionSummary {
  workspace: Workspace;
}

export interface ReportSessionStore {
  listSessions(workDir: string): Promise<SessionSummary[]>;
  listSessionsByDateRange(workDir: string, from: Date, to: Date): Promise<SessionSummary[]>;
}

export interface BridgeAppDeps {
  hub: ConversationHub;
  store: ConversationStore;
  accessControl: AccessControl;
  workspaceStore: IWorkspaceStore;
  sessionCatalog: ReportSessionStore;
  reportGenerator: IReportGenerator | null;
  log: (message: string) => void;
}

const MAX_RESUME_SESSIONS = 25;

export class BridgeApp {
  constructor(private readonly deps: BridgeAppDeps) {}

  get hub(): ConversationHub {
    return this.deps.hub;
  }

  createSessionId(): string {
    return randomUUID();
  }

  /** 会話スレッド内のメッセージを処理する(遅延復元・巻き戻し・プロンプト実行) */
  async handleInbound(message: InboundMessage, handle: ConversationHandle): Promise<void> {
    const { hub, accessControl, log } = this.deps;

    if (message.authorIsBot) return;
    if (
      !accessControl.check({
        authorBot: message.authorIsBot,
        authorId: message.authorId,
        channelId: message.channelId,
      })
    ) {
      return;
    }

    const { prompt, error } = await resolvePrompt(message.text, message.attachments);
    if (prompt === null) return;

    log(
      `メッセージ受信: ${message.authorId} "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}" (conversation: ${refKey(message.ref)})`,
    );

    let runtime = hub.get(message.ref);
    if (!runtime) {
      runtime = await hub.tryRestore(message.ref, handle);
    }
    if (!runtime) return;

    if (error) {
      handle.send({ kind: 'plain', text: error });
    }

    runtime.presenter.setAuthorId(message.authorId);

    if (message.replyToMessageId) {
      const handled = await this.tryRewind(runtime, message, prompt);
      if (handled) return;
    }

    runtime.dispatch({
      type: 'prompt',
      text: prompt,
      platformMessageId: message.platformMessageId,
    });
  }

  /**
   * Bot 応答へのリプライを巻き戻しとして処理する。
   * @returns true の場合、通常のプロンプト処理をスキップする
   */
  private async tryRewind(
    runtime: ConversationRuntime,
    message: InboundMessage,
    prompt: string,
  ): Promise<boolean> {
    const { store, log } = this.deps;
    const key = refKey(message.ref);
    const turnRecord = store.findTurnByMessage(key, message.replyToMessageId!);
    if (!turnRecord) return false;

    const branchTurn = turnRecord.seq - 1;

    if (runtime.state.phase !== 'idle') {
      // リデューサーが「処理中のため巻き戻せない」通知を出す
      runtime.dispatch({ type: 'rewound', newSessionId: '', targetTurn: branchTurn, prompt: null });
      return true;
    }

    try {
      const newSessionId = await branchTranscript(
        turnRecord.sessionId,
        runtime.state.workspace.path,
        branchTurn,
      );
      store.recordBranch(key, turnRecord.sessionId, newSessionId, branchTurn);
      log(
        `巻き戻し: Turn ${turnRecord.seq} を上書き (元セッション: ${turnRecord.sessionId.slice(0, 8)}) → 新セッション ${newSessionId.slice(0, 8)} (conversation: ${key})`,
      );
      runtime.dispatch({
        type: 'rewound',
        newSessionId,
        targetTurn: branchTurn,
        prompt: { text: prompt, platformMessageId: message.platformMessageId },
      });
    } catch (err) {
      console.error('Rewind error:', err);
      runtime.handle.send({ kind: 'plain', text: '巻き戻しに失敗しました' });
    }
    return true;
  }

  /** 新規セッションで会話を開始する(スレッドはアダプタ側で作成済み) */
  openConversation(
    ref: ConversationRef,
    handle: ConversationHandle,
    workspace: Workspace,
    options: SessionOptions,
    sessionId: string = this.createSessionId(),
  ): ConversationRuntime {
    const runtime = this.deps.hub.openNew(ref, handle, workspace, options, sessionId);
    const details: string[] = [];
    if (options.model) details.push(options.model);
    if (options.effort) details.push(options.effort);
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    handle.send({
      kind: 'plain',
      text: `セッションを開始しました [\`${sessionId.slice(0, 8)}\`] — 📁 ${workspace.name}${suffix}`,
    });
    return runtime;
  }

  /** 過去の Claude セッションを新しい会話として再開する */
  async resumeConversation(
    ref: ConversationRef,
    handle: ConversationHandle,
    workspace: Workspace,
    sessionId: string,
  ): Promise<ConversationRuntime> {
    const turn = await countTranscriptTurns(sessionId, workspace.path);
    const runtime = this.deps.hub.openResumed(ref, handle, workspace, sessionId, turn);
    handle.send({
      kind: 'plain',
      text: `セッションを再開しました [\`${sessionId.slice(0, 8)}\`] — 📁 ${workspace.name}`,
    });
    return runtime;
  }

  interrupt(ref: ConversationRef): InterruptResult {
    const runtime = this.deps.hub.get(ref);
    if (!runtime) return 'no-session';
    if (runtime.state.phase === 'interrupting') return 'already-interrupting';
    if (runtime.state.phase !== 'busy') return 'not-busy';
    runtime.dispatch({ type: 'interrupt' });
    return 'ok';
  }

  /** 全ワークスペース横断で再開可能なセッション一覧(最終更新降順・上位25件) */
  async listResumableSessions(): Promise<ResumableSession[]> {
    const { workspaceStore, sessionCatalog } = this.deps;
    const all: ResumableSession[] = [];
    for (const ws of workspaceStore.list()) {
      const sessions = await sessionCatalog.listSessions(ws.path);
      for (const s of sessions) {
        all.push({ workspace: ws, ...s });
      }
    }
    all.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return all.slice(0, MAX_RESUME_SESSIONS);
  }

  /** 日報を生成する。失敗理由はユーザー向け文言で返す */
  async generateReport(
    dateInput: string | null,
  ): Promise<{ ok: true; report: string } | { ok: false; message: string }> {
    const { workspaceStore, sessionCatalog, reportGenerator, log } = this.deps;

    if (!reportGenerator) {
      return { ok: false, message: '⚠️ 日報生成には GEMINI_API_KEY の設定が必要です' };
    }

    let targetDate: Date;
    if (dateInput) {
      const parsed = parseDateInput(dateInput);
      if (!parsed) {
        return {
          ok: false,
          message:
            '⚠️ 日付の形式が不正です（YYYY-MM-DD または -1, -2 等の相対指定で入力してください）',
        };
      }
      targetDate = parsed;
    } else {
      targetDate = todayJST();
    }

    const { from, to } = getDayBoundary(targetDate);

    const collected: Array<{ workspace: Workspace; sessions: SessionSummary[] }> = [];
    for (const ws of workspaceStore.list()) {
      const sessions = await sessionCatalog.listSessionsByDateRange(ws.path, from, to);
      if (sessions.length > 0) {
        collected.push({ workspace: ws, sessions });
      }
    }

    const totalCount = collected.reduce((sum, e) => sum + e.sessions.length, 0);
    if (totalCount === 0) {
      const dateLabel =
        dateInput ?? targetDate.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
      return { ok: false, message: `⚠️ ${dateLabel} のセッションが見つかりません` };
    }

    log(`日報生成開始: ${totalCount} セッション (${collected.length} ワークスペース)`);

    const dailySessions: DailySession[] = [];
    for (const { workspace: ws, sessions } of collected) {
      for (const s of sessions) {
        try {
          const entries = await readSession(s.sessionId, ws.path);
          dailySessions.push({
            sessionId: s.sessionId,
            title: `[${ws.name}] ${s.slug ?? s.firstUserMessage.slice(0, 50)}`,
            messageCount: entries.length,
            entries,
          });
        } catch {
          // 破損 JSONL などで個別セッションの読み込みが失敗しても、他セッションの日報生成は続ける
          log(`セッション読み込みスキップ: ${s.sessionId}`);
        }
      }
    }

    if (dailySessions.length === 0) {
      return { ok: false, message: '⚠️ セッションの読み込みに失敗しました' };
    }

    const report = await reportGenerator.generate(dailySessions, targetDate);
    if (!report) {
      return { ok: false, message: '⚠️ 日報の生成に失敗しました' };
    }

    log('日報生成完了');
    return { ok: true, report };
  }
}
