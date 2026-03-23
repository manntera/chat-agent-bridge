import type { Orchestrator } from './orchestrator.js';
import type { Session } from './session.js';
import type { IClaudeProcess } from './types.js';

export interface SessionContext {
  orchestrator: Orchestrator;
  session: Session;
  claudeProcess: IClaudeProcess;
  threadId: string;
  setAuthorId(authorId: string): void;
}

export class SessionManager {
  private sessions = new Map<string, SessionContext>();

  get(threadId: string): SessionContext | null {
    return this.sessions.get(threadId) ?? null;
  }

  register(threadId: string, context: SessionContext): void {
    this.sessions.set(threadId, context);
  }

  remove(threadId: string): void {
    this.sessions.delete(threadId);
  }

  all(): SessionContext[] {
    return [...this.sessions.values()];
  }

  size(): number {
    return this.sessions.size;
  }
}
