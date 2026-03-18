import { parseCommand } from './command.js';
import type { Session } from './session.js';
import type { IClaudeProcess, NotifyFn, OrchestratorState, ProgressEvent } from './types.js';

export class Orchestrator {
  private interruptReason: 'new' | 'interrupt' | null = null;

  constructor(
    private readonly session: Session,
    private readonly claudeProcess: IClaudeProcess,
    private readonly notify: NotifyFn,
  ) {}

  get state(): OrchestratorState {
    if (this.claudeProcess.isRunning) {
      return this.interruptReason !== null ? 'interrupting' : 'busy';
    }
    return this.session.sessionId !== null ? 'idle' : 'initial';
  }

  handleMessage(text: string): void {
    const command = parseCommand(text);
    const state = this.state;

    switch (command.type) {
      case 'prompt':
        if (state === 'busy' || state === 'interrupting') {
          this.notify({ type: 'info', message: '処理中です' });
        } else {
          const resume = state === 'idle';
          const sessionId = this.session.ensure();
          this.claudeProcess.spawn(command.text, sessionId, this.session.workDir, resume);
        }
        break;

      case 'new':
        if (state === 'initial') {
          this.notify({ type: 'info', message: 'セッションがありません' });
        } else if (state === 'idle') {
          this.session.reset();
          this.notify({ type: 'info', message: '新しいセッションを開始しました' });
        } else if (state === 'busy') {
          this.interruptReason = 'new';
          this.claudeProcess.interrupt();
        }
        break;

      case 'interrupt':
        if (state === 'busy') {
          this.interruptReason = 'interrupt';
          this.claudeProcess.interrupt();
        }
        break;
    }
  }

  onProgress(event: ProgressEvent): void {
    this.notify({ type: 'progress', event });
  }

  onProcessEnd(exitCode: number, output: string): void {
    if (this.interruptReason === null) {
      if (exitCode === 0) {
        this.notify({ type: 'result', text: output });
      } else {
        this.notify({ type: 'error', message: output, exitCode });
      }
    } else if (this.interruptReason === 'interrupt') {
      this.notify({ type: 'info', message: '中断しました' });
    } else {
      this.session.reset();
      this.notify({ type: 'info', message: '新しいセッションを開始しました' });
    }
    this.interruptReason = null;
  }
}
