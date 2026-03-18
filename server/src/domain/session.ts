import { randomUUID } from 'node:crypto';

export class Session {
  private _sessionId: string | null = null;
  private _isNew = false;
  readonly workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** セッションが作成済みだがまだ使われていないかどうか */
  get isNew(): boolean {
    return this._isNew;
  }

  /** セッションを作成済みとしてマークする（最初のプロンプト送信後に呼ぶ） */
  markUsed(): void {
    this._isNew = false;
  }

  ensure(): string {
    if (this._sessionId === null) {
      this._sessionId = randomUUID();
      this._isNew = true;
    }
    return this._sessionId;
  }

  reset(): void {
    this._sessionId = null;
    this._isNew = false;
  }
}
