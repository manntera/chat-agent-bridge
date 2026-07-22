import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionOptions } from '../core/types.js';

/**
 * 会話・ターン・分岐を単一の SQLite ファイルで管理するストア。
 *
 * 旧実装で 3 箇所に分散していた状態を統合する:
 * - thread-sessions.json (thread → session マッピング)     → conversations
 * - ~/.claude/projects 内の <session>.turns.json サイドカー → turns
 * - session-brancher が暗黙に持っていた分岐履歴             → branches
 *
 * キーはプラットフォーム非依存の refKey(`discord:<threadId>` 等)。
 * ~/.claude 配下にはもう一切書き込まない。
 */

export interface ConversationRecord {
  ref: string;
  platform: string;
  sessionId: string;
  workDir: string;
  workspaceName: string;
  options: SessionOptions;
  turn: number;
}

export interface TurnRecord {
  seq: number;
  sessionId: string;
  platformMessageId: string | null;
  prompt: string;
}

interface ConversationRow {
  ref: string;
  platform: string;
  session_id: string;
  work_dir: string;
  workspace_name: string;
  model: string | null;
  effort: string | null;
  turn: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  ref            TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  work_dir       TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  model          TEXT,
  effort         TEXT,
  turn           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS turns (
  ref                 TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  session_id          TEXT NOT NULL,
  platform_message_id TEXT,
  prompt              TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ref, seq)
);
CREATE INDEX IF NOT EXISTS idx_turns_message ON turns (platform_message_id);
CREATE TABLE IF NOT EXISTS branches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL,
  from_session_id TEXT NOT NULL,
  to_session_id   TEXT NOT NULL,
  at_turn         INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class ConversationStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  upsert(record: ConversationRecord): void {
    this.db
      .prepare(
        `INSERT INTO conversations (ref, platform, session_id, work_dir, workspace_name, model, effort, turn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET
           session_id = excluded.session_id,
           work_dir = excluded.work_dir,
           workspace_name = excluded.workspace_name,
           model = excluded.model,
           effort = excluded.effort,
           turn = excluded.turn,
           updated_at = datetime('now')`,
      )
      .run(
        record.ref,
        record.platform,
        record.sessionId,
        record.workDir,
        record.workspaceName,
        record.options.model ?? null,
        record.options.effort ?? null,
        record.turn,
      );
  }

  get(ref: string): ConversationRecord | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE ref = ?').get(ref) as unknown as
      | ConversationRow
      | undefined;
    if (!row) return null;
    return {
      ref: row.ref,
      platform: row.platform,
      sessionId: row.session_id,
      workDir: row.work_dir,
      workspaceName: row.workspace_name,
      options: {
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort as ConversationRecord['options']['effort'] } : {}),
      },
      turn: row.turn,
    };
  }

  remove(ref: string): void {
    this.db.prepare('DELETE FROM conversations WHERE ref = ?').run(ref);
    this.db.prepare('DELETE FROM turns WHERE ref = ?').run(ref);
  }

  /** ターンを記録する。巻き戻し後の同一 seq は上書きする。 */
  recordTurn(ref: string, turn: TurnRecord): void {
    this.db
      .prepare(
        `INSERT INTO turns (ref, seq, session_id, platform_message_id, prompt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ref, seq) DO UPDATE SET
           session_id = excluded.session_id,
           platform_message_id = excluded.platform_message_id,
           prompt = excluded.prompt,
           created_at = datetime('now')`,
      )
      .run(ref, turn.seq, turn.sessionId, turn.platformMessageId, turn.prompt);
  }

  /** プラットフォームのメッセージ ID からターンを逆引きする(巻き戻し用) */
  findTurnByMessage(ref: string, platformMessageId: string): TurnRecord | null {
    const row = this.db
      .prepare(
        'SELECT seq, session_id, platform_message_id, prompt FROM turns WHERE ref = ? AND platform_message_id = ?',
      )
      .get(ref, platformMessageId) as unknown as
      | { seq: number; session_id: string; platform_message_id: string | null; prompt: string }
      | undefined;
    if (!row) return null;
    return {
      seq: row.seq,
      sessionId: row.session_id,
      platformMessageId: row.platform_message_id,
      prompt: row.prompt,
    };
  }

  truncateTurnsAfter(ref: string, turn: number): void {
    this.db.prepare('DELETE FROM turns WHERE ref = ? AND seq > ?').run(ref, turn);
  }

  recordBranch(ref: string, fromSessionId: string, toSessionId: string, atTurn: number): void {
    this.db
      .prepare(
        'INSERT INTO branches (ref, from_session_id, to_session_id, at_turn) VALUES (?, ?, ?, ?)',
      )
      .run(ref, fromSessionId, toSessionId, atTurn);
  }

  close(): void {
    this.db.close();
  }
}
