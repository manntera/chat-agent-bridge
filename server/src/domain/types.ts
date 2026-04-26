export type OrchestratorState = 'initial' | 'idle' | 'busy' | 'interrupting';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SessionOptions {
  model?: string;
  effort?: Effort;
}

export type Command =
  | { type: 'new'; options: SessionOptions }
  | { type: 'interrupt' }
  | { type: 'prompt'; text: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'rewind'; targetTurn: number; newSessionId: string; prompt?: string };

export type ProgressEvent =
  | { kind: 'started' }
  | { kind: 'tool_use'; toolName: string; target: string }
  | { kind: 'thinking'; text: string };

export interface UsageInfo {
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  sevenDaySonnet: { utilization: number; resetsAt: string } | null;
}

export type Notification =
  | { type: 'info'; message: string }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; exitCode: number }
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'usage'; usage: UsageInfo };

export type NotifyFn = (notification: Notification) => void;

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

export interface Workspace {
  name: string;
  path: string;
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
