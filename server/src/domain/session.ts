import { randomUUID } from 'node:crypto';

export class Session {
  private _sessionId: string | null = null;
  readonly workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  ensure(): string {
    if (this._sessionId === null) {
      this._sessionId = randomUUID();
    }
    return this._sessionId;
  }

  reset(): void {
    this._sessionId = null;
  }
}
