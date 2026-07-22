import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  initialState,
  reduce,
  resumedState,
  type ConversationEvent,
  type ConversationState,
  type Effect,
} from '../core/conversation.js';
import { Presenter } from '../core/presenter.js';
import {
  refKey,
  type ConversationRef,
  type IClaudeProcess,
  type IUsageFetcher,
  type ProgressEvent,
  type SessionOptions,
  type Workspace,
} from '../core/types.js';
import { EMPTY_USAGE } from '../core/types.js';
import type { ConversationStore } from '../store/conversation-store.js';
import { logNotification } from '../helpers.js';
import type { ConversationHandle } from './ports.js';

/**
 * 会話ランタイム: リデューサーの状態を保持し、Effect を実行する。
 *
 * 1会話 = 1 ConversationRuntime。イベントは dispatch() で直列に適用され、
 * 適用のたびに ConversationStore へ upsert される(再起動後はストアの行から復元)。
 */

export interface ITitleGenerator {
  generate(sessionId: string, workDir: string): Promise<string | null>;
}

export type ProcessFactory = (
  ref: ConversationRef,
  onProgress: (event: ProgressEvent) => void,
  onProcessEnd: (exitCode: number, output: string) => void,
) => IClaudeProcess;

export interface RuntimeDeps {
  store: ConversationStore;
  usageFetcher: IUsageFetcher;
  titleGenerator: ITitleGenerator | null;
  createProcess: ProcessFactory;
  log: (message: string) => void;
}

export class ConversationRuntime {
  readonly key: string;
  private state_: ConversationState;
  readonly presenter: Presenter;
  private readonly process: IClaudeProcess;

  constructor(
    readonly ref: ConversationRef,
    readonly handle: ConversationHandle,
    state: ConversationState,
    private readonly deps: RuntimeDeps,
  ) {
    this.key = refKey(ref);
    this.state_ = state;
    this.presenter = new Presenter((message) => handle.send(message));
    this.process = deps.createProcess(
      ref,
      (event) => this.dispatch({ type: 'progress', event }),
      (exitCode, output) => {
        deps.log(`ClaudeProcess 終了 (exitCode: ${exitCode}, conversation: ${this.key})`);
        this.dispatch({ type: 'processEnded', exitCode, output });
      },
    );
  }

  get state(): ConversationState {
    return this.state_;
  }

  dispatch(event: ConversationEvent): void {
    const { state, effects } = reduce(this.state_, event);
    this.state_ = state;
    this.persist();
    for (const effect of effects) {
      this.applyEffect(effect);
    }
  }

  /** 現在の状態をストアへ書き込む(イベントを介さない初期永続化用) */
  persistNow(): void {
    this.persist();
  }

  private persist(): void {
    const s = this.state_;
    this.deps.store.upsert({
      ref: this.key,
      platform: this.ref.platform,
      sessionId: s.sessionId,
      workDir: s.workspace.path,
      workspaceName: s.workspace.name,
      options: s.options,
      turn: s.turn,
    });
  }

  private applyEffect(effect: Effect): void {
    switch (effect.type) {
      case 'spawn':
        this.process.spawn(
          effect.prompt,
          effect.sessionId,
          effect.workDir,
          effect.resume,
          effect.options,
        );
        break;

      case 'interruptProcess':
        this.process.interrupt();
        break;

      case 'notify':
        logNotification(effect.notification);
        this.presenter.notify(effect.notification);
        break;

      case 'recordTurn':
        this.deps.store.recordTurn(this.key, {
          seq: effect.turn,
          sessionId: this.state_.sessionId,
          platformMessageId: effect.platformMessageId,
          prompt: effect.prompt,
        });
        break;

      case 'truncateTurnsAfter':
        this.deps.store.truncateTurnsAfter(this.key, effect.turn);
        break;

      case 'fetchUsage':
        this.deps.usageFetcher
          .fetch()
          .then((usage) => this.presenter.notify({ type: 'usage', usage }))
          .catch((err) => {
            console.error('Usage fetch error:', err);
            this.presenter.notify({ type: 'usage', usage: EMPTY_USAGE });
          });
        break;

      case 'turnCompleted':
        this.generateTitle();
        break;
    }
  }

  /** ターン完了後のタイトル生成(非同期・失敗しても無視) */
  private generateTitle(): void {
    const { titleGenerator, log } = this.deps;
    if (!titleGenerator || !this.handle.setTitle) return;
    const { sessionId, workspace } = this.state_;
    titleGenerator
      .generate(sessionId, workspace.path)
      .then((title) => {
        if (title) {
          log(`タイトル生成: "${title}" (conversation: ${this.key})`);
          return this.handle.setTitle?.(title);
        }
      })
      .catch((err) => console.error('Title generation error:', err));
  }

  dispose(): void {
    this.presenter.dispose();
  }
}

/**
 * 会話ランタイムのレジストリ。生成・遅延復元・破棄を担う。
 * (旧 SessionManager + SessionRestorer + session-factory の統合)
 */
export class ConversationHub {
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly pendingRestores = new Map<string, Promise<ConversationRuntime | null>>();

  constructor(private readonly deps: RuntimeDeps) {}

  get(ref: ConversationRef): ConversationRuntime | null {
    return this.runtimes.get(refKey(ref)) ?? null;
  }

  /** 新規セッションで会話を開始する */
  openNew(
    ref: ConversationRef,
    handle: ConversationHandle,
    workspace: Workspace,
    options: SessionOptions,
    sessionId: string = randomUUID(),
  ): ConversationRuntime {
    return this.register(ref, handle, initialState(workspace, sessionId, options));
  }

  /** 既存の Claude セッションを新しい会話として再開する */
  openResumed(
    ref: ConversationRef,
    handle: ConversationHandle,
    workspace: Workspace,
    sessionId: string,
    turn: number,
  ): ConversationRuntime {
    return this.register(ref, handle, resumedState(workspace, sessionId, turn));
  }

  private register(
    ref: ConversationRef,
    handle: ConversationHandle,
    state: ConversationState,
  ): ConversationRuntime {
    const runtime = new ConversationRuntime(ref, handle, state, this.deps);
    this.runtimes.set(runtime.key, runtime);
    // 初期状態を即永続化(サーバー再起動後の復元源)
    runtime.persistNow();
    return runtime;
  }

  /**
   * ストアの行からランタイムを遅延復元する(サーバー再起動後の最初のメッセージ受信時)。
   * 並行メッセージによる二重復元は Promise 共有で排他する。
   */
  async tryRestore(
    ref: ConversationRef,
    handle: ConversationHandle,
  ): Promise<ConversationRuntime | null> {
    const key = refKey(ref);
    const pending = this.pendingRestores.get(key);
    if (pending) return pending;

    const promise = this.doRestore(ref, handle);
    this.pendingRestores.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pendingRestores.delete(key);
    }
  }

  private async doRestore(
    ref: ConversationRef,
    handle: ConversationHandle,
  ): Promise<ConversationRuntime | null> {
    const key = refKey(ref);
    const record = this.deps.store.get(key);
    if (!record) return null;

    try {
      const s = await stat(record.workDir);
      if (!s.isDirectory()) throw new Error('Not a directory');
    } catch {
      handle.send({
        kind: 'plain',
        text: 'セッションの復元に失敗しました。ワークディレクトリが見つかりません。`/cc resume` で再開するか、`/cc new` で新しいセッションを開始してください。',
      });
      this.deps.store.remove(key);
      return null;
    }

    const state = resumedState(
      { name: record.workspaceName, path: record.workDir },
      record.sessionId,
      record.turn,
      record.options,
    );
    const runtime = new ConversationRuntime(ref, handle, state, this.deps);
    this.runtimes.set(key, runtime);
    this.deps.log(
      `セッション復元: ${record.workspaceName} [${record.sessionId.slice(0, 8)}...] (conversation: ${key})`,
    );
    return runtime;
  }

  remove(ref: ConversationRef): void {
    const key = refKey(ref);
    this.runtimes.get(key)?.dispose();
    this.runtimes.delete(key);
  }
}
