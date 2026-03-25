import type { Session } from './session.js';
import type {
  Command,
  IClaudeProcess,
  IUsageFetcher,
  NotifyFn,
  OrchestratorState,
  ProgressEvent,
  SessionOptions,
} from './types.js';

export class Orchestrator {
  private interruptReason: 'new' | 'interrupt' | null = null;
  private pendingNewOptions: SessionOptions = {};
  private turnCount = 0;

  constructor(
    private readonly session: Session,
    private readonly claudeProcess: IClaudeProcess,
    private readonly notify: NotifyFn,
    private readonly usageFetcher?: IUsageFetcher,
  ) {}

  get currentTurn(): number {
    return this.turnCount;
  }

  /** 永続化されたターンカウンタを復元する */
  restoreTurnCount(turn: number): void {
    this.turnCount = turn;
  }

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
          this.turnCount++;
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

      case 'resume':
        if (state === 'initial' || state === 'idle') {
          this.session.reset();
          this.session.restore(command.sessionId);
          this.notify({
            type: 'info',
            message: `セッションを再開しました [${this.formatSessionId()}]`,
          });
        }
        break;

      case 'rewind':
        if (state === 'idle') {
          if (!command.newSessionId) {
            this.notify({
              type: 'info',
              message: '巻き戻しに失敗しました（セッションIDが不正です）',
            });
            break;
          }
          const prevOptions = { ...this.session.options };
          this.session.reset();
          this.session.restore(command.newSessionId, prevOptions);
          this.turnCount = command.targetTurn;
          this.notify({
            type: 'info',
            message: `⏪ Turn ${command.targetTurn} まで巻き戻しました [${command.newSessionId.slice(0, 8)}]`,
          });
          if (command.prompt) {
            this.handleCommand({ type: 'prompt', text: command.prompt });
          }
        } else if (state === 'busy' || state === 'interrupting') {
          this.notify({
            type: 'info',
            message: '処理中のため巻き戻しできません。完了後に再度お試しください。',
          });
        }
        break;
    }
  }

  private formatSessionId(): string {
    return this.session.sessionId!.slice(0, 8);
  }

  private formatNewSessionMessage(): string {
    const opts = this.session.options;
    const details: string[] = [];
    if (opts.model) details.push(`model: ${opts.model}`);
    if (opts.effort) details.push(`effort: ${opts.effort}`);
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    return `新しいセッションを開始しました [${this.formatSessionId()}]${suffix}`;
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
    this.sendUsage();
  }

  private sendUsage(): void {
    if (!this.usageFetcher) {
      this.notify({
        type: 'usage',
        usage: { fiveHour: null, sevenDay: null, sevenDaySonnet: null },
      });
      return;
    }
    this.usageFetcher
      .fetch()
      .then((usage) => this.notify({ type: 'usage', usage }))
      .catch((err) => {
        console.error('Usage fetch error:', err);
        this.notify({
          type: 'usage',
          usage: { fiveHour: null, sevenDay: null, sevenDaySonnet: null },
        });
      });
  }
}
