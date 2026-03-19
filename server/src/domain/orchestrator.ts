import type { Session } from './session.js';
import type {
  Command,
  IClaudeProcess,
  NotifyFn,
  OrchestratorState,
  ProgressEvent,
  SessionOptions,
} from './types.js';

export class Orchestrator {
  private interruptReason: 'new' | 'interrupt' | null = null;
  private pendingNewOptions: SessionOptions = {};

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

  /** テキストメッセージをプロンプトとして処理する */
  handleMessage(text: string): void {
    this.handleCommand({ type: 'prompt', text: text.trim() });
  }

  /** パース済みコマンドを処理する */
  handleCommand(command: Command): void {
    const state = this.state;

    switch (command.type) {
      case 'prompt':
        if (state === 'initial') {
          this.notify({ type: 'info', message: '`/cc new` でセッションを開始してください' });
        } else if (state === 'busy' || state === 'interrupting') {
          this.notify({ type: 'info', message: '処理中です' });
        } else {
          this.notify({ type: 'progress', event: { kind: 'started' } });
          const sessionId = this.session.sessionId!;
          const resume = !this.session.isNew;
          this.session.markUsed();
          this.claudeProcess.spawn(
            command.text,
            sessionId,
            this.session.workDir,
            resume,
            this.session.options,
          );
        }
        break;

      case 'new':
        if (state === 'initial' || state === 'idle') {
          this.session.reset();
          this.session.ensure(command.options);
          this.notify({ type: 'info', message: this.formatNewSessionMessage() });
        } else if (state === 'busy') {
          this.pendingNewOptions = command.options;
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

  private formatNewSessionMessage(): string {
    const opts = this.session.options;
    const parts: string[] = ['新しいセッションを開始しました'];
    const details: string[] = [];
    if (opts.model) details.push(`model: ${opts.model}`);
    if (opts.effort) details.push(`effort: ${opts.effort}`);
    if (details.length > 0) parts.push(`(${details.join(', ')})`);
    return parts.join(' ');
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
      this.session.ensure(this.pendingNewOptions);
      this.pendingNewOptions = {};
      this.notify({ type: 'info', message: this.formatNewSessionMessage() });
    }
    this.interruptReason = null;
  }
}
