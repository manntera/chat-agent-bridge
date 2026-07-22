/**
 * プラットフォーム非依存のコア型定義。
 *
 * このファイルは discord.js / Slack SDK 等のチャットプラットフォーム SDK に
 * 一切依存しない。プラットフォーム固有の概念は ConversationRef の文字列
 * エンコードと OutboundMessage のセマンティクスに閉じ込める。
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SessionOptions {
  model?: string;
  effort?: Effort;
}

/**
 * 会話(= プラットフォーム上のスレッド等)の正規化された識別子。
 * 例: { platform: 'discord', id: '123456789' }
 *     { platform: 'slack', id: 'C012345:1720000000.123456' }
 * key() で永続化キー文字列 (`discord:123456789`) に変換する。
 */
export interface ConversationRef {
  platform: string;
  id: string;
}

export function refKey(ref: ConversationRef): string {
  return `${ref.platform}:${ref.id}`;
}

export function parseRefKey(key: string): ConversationRef {
  const sep = key.indexOf(':');
  return { platform: key.slice(0, sep), id: key.slice(sep + 1) };
}

export interface Workspace {
  name: string;
  path: string;
}

export interface UsageInfo {
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  sevenDaySonnet: { utilization: number; resetsAt: string } | null;
}

export const EMPTY_USAGE: UsageInfo = { fiveHour: null, sevenDay: null, sevenDaySonnet: null };

export type ProgressEvent =
  | { kind: 'started' }
  | { kind: 'tool_use'; toolName: string; target: string }
  | { kind: 'thinking'; text: string };

/** リデューサーが発行する通知(プレゼンテーション層への入力) */
export type Notification =
  | { type: 'info'; message: string }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; exitCode: number }
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'usage'; usage: UsageInfo };

export type NotifyFn = (notification: Notification) => void;

/**
 * プレゼンターが生成する送信メッセージ。各プラットフォームのレンダラーが
 * これを自プラットフォームの語彙(Discord Embed / Slack Blocks 等)へ変換する。
 * 文字数分割・メンション記法・装飾はレンダラーの責務。
 */
export type OutboundMessage =
  | { kind: 'activity'; active: boolean }
  | { kind: 'progress'; text: string }
  | { kind: 'plain'; text: string }
  | { kind: 'result'; text: string; mentionUserId: string | null; footer: string | null }
  | {
      kind: 'error';
      title: string;
      body: string;
      mentionUserId: string | null;
      footer: string | null;
    };

export interface IUsageFetcher {
  fetch(): Promise<UsageInfo>;
}

export interface SessionSummary {
  sessionId: string;
  firstUserMessage: string;
  slug: string | null;
  lastModified: Date;
}

export interface ISessionStore {
  listSessions(workDir: string): Promise<SessionSummary[]>;
}

export interface IClaudeProcess {
  readonly isRunning: boolean;
  spawn(
    prompt: string,
    sessionId: string,
    workDir: string,
    resume: boolean,
    options?: SessionOptions,
  ): void;
  interrupt(): void;
}
