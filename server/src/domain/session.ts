import { randomUUID } from 'node:crypto';
import type { SessionOptions } from './types.js';

export class Session {
  private _sessionId: string | null = null;
  private _isNew = false;
  private _options: SessionOptions = {};
  readonly workDir: string;
  readonly workspaceName: string;

  constructor(workDir: string, workspaceName: string) {
    this.workDir = workDir;
    this.workspaceName = workspaceName;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get isNew(): boolean {
    return this._isNew;
  }

  get options(): SessionOptions {
    return this._options;
  }

  markUsed(): void {
    this._isNew = false;
  }

  ensure(options: SessionOptions = {}): string {
    if (this._sessionId === null) {
      this._sessionId = randomUUID();
      this._isNew = true;
      this._options = options;
    }
    return this._sessionId;
  }

  restore(sessionId: string): void {
    this._sessionId = sessionId;
    this._isNew = false;
    this._options = {};
  }

  reset(): void {
    this._sessionId = null;
    this._isNew = false;
    this._options = {};
  }
}
