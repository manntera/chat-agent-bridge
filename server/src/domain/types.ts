export type OrchestratorState = 'initial' | 'idle' | 'busy' | 'interrupting';

export type ProgressEvent =
  | { kind: 'tool_use'; toolName: string; target: string }
  | { kind: 'thinking'; text: string };

export type Notification =
  | { type: 'info'; message: string }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; exitCode: number }
  | { type: 'progress'; event: ProgressEvent };

export type NotifyFn = (notification: Notification) => void;

export interface IClaudeProcess {
  readonly isRunning: boolean;
  spawn(prompt: string, sessionId: string, workDir: string, resume: boolean): void;
  interrupt(): void;
}
