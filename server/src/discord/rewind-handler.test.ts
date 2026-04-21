import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from 'discord.js';
import type { SessionContext } from '../domain/session-manager.js';
import type { Command, OrchestratorState } from '../domain/types.js';
import type { SessionBrancher } from '../infrastructure/session-brancher.js';
import type { TurnStore } from '../infrastructure/turn-store.js';
import type { PersistMappingFn } from './session-factory.js';
import { createRewindHandler } from './rewind-handler.js';

interface TurnStoreMock {
  findTurn: ReturnType<typeof vi.fn>;
  findTurnAcrossSessions: ReturnType<typeof vi.fn>;
}

interface BrancherMock {
  branch: ReturnType<typeof vi.fn>;
}

interface MessageStub {
  channelId: string;
  reference: { messageId: string } | null;
  channel: { send: ReturnType<typeof vi.fn> };
}

interface CtxStub {
  session: {
    sessionId: string | null;
    workDir: string;
    workspaceName: string;
  };
  orchestrator: {
    state: OrchestratorState;
    handleCommand: ReturnType<typeof vi.fn>;
  };
}

function makeTurnStore(): TurnStoreMock {
  return {
    findTurn: vi.fn().mockResolvedValue(null),
    findTurnAcrossSessions: vi.fn().mockResolvedValue(null),
  };
}

function makeBrancher(): BrancherMock {
  return {
    branch: vi.fn().mockResolvedValue('new-session-id'),
  };
}

function makeMessage(
  options: {
    channelId?: string;
    referencedId?: string | null;
  } = {},
): MessageStub {
  const { channelId = 'thread-1', referencedId = 'ref-msg-1' } = options;
  return {
    channelId,
    reference: referencedId === null ? null : { messageId: referencedId },
    channel: { send: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeCtx(
  options: {
    sessionId?: string | null;
    state?: OrchestratorState;
    workDir?: string;
    workspaceName?: string;
  } = {},
): CtxStub {
  const {
    sessionId = 'current-session-id',
    state = 'idle',
    workDir = '/ws/path',
    workspaceName = 'ws-name',
  } = options;
  return {
    session: { sessionId, workDir, workspaceName },
    orchestrator: { state, handleCommand: vi.fn() },
  };
}

function coerceMessage(m: MessageStub): Message {
  return m as unknown as Message;
}

function coerceCtx(c: CtxStub): SessionContext {
  return c as unknown as SessionContext;
}

function coerceTurnStore(t: TurnStoreMock): TurnStore {
  return t as unknown as TurnStore;
}

function coerceBrancher(b: BrancherMock): SessionBrancher {
  return b as unknown as SessionBrancher;
}

describe('createRewindHandler', () => {
  let turnStore: TurnStoreMock;
  let brancher: BrancherMock;
  let persistMapping: ReturnType<typeof vi.fn<PersistMappingFn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    turnStore = makeTurnStore();
    brancher = makeBrancher();
    persistMapping = vi.fn<PersistMappingFn>().mockResolvedValue(undefined);
  });

  function makeHandler() {
    return createRewindHandler({
      turnStore: coerceTurnStore(turnStore),
      sessionBrancher: coerceBrancher(brancher),
      persistMapping,
    });
  }

  it('リプライがない場合は handled: false を返し、副作用を起こさない', async () => {
    const handler = makeHandler();
    const msg = makeMessage({ referencedId: null });
    const ctx = makeCtx();

    const result = await handler(coerceMessage(msg), coerceCtx(ctx), 'hello');

    expect(result).toEqual({ handled: false });
    expect(turnStore.findTurn).not.toHaveBeenCalled();
    expect(turnStore.findTurnAcrossSessions).not.toHaveBeenCalled();
    expect(brancher.branch).not.toHaveBeenCalled();
    expect(persistMapping).not.toHaveBeenCalled();
    expect(ctx.orchestrator.handleCommand).not.toHaveBeenCalled();
  });

  it('ctx が null の場合は handled: false を返す', async () => {
    const handler = makeHandler();
    const msg = makeMessage();

    const result = await handler(coerceMessage(msg), null, 'hello');

    expect(result).toEqual({ handled: false });
    expect(turnStore.findTurn).not.toHaveBeenCalled();
  });

  it('session.sessionId が null の場合は handled: false を返す', async () => {
    const handler = makeHandler();
    const msg = makeMessage();
    const ctx = makeCtx({ sessionId: null });

    const result = await handler(coerceMessage(msg), coerceCtx(ctx), 'hello');

    expect(result).toEqual({ handled: false });
    expect(turnStore.findTurn).not.toHaveBeenCalled();
  });

  it('リプライ先のターンが現セッションにも他セッションにも見つからなければ handled: false', async () => {
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(null);
    turnStore.findTurnAcrossSessions.mockResolvedValueOnce(null);

    const result = await handler(coerceMessage(makeMessage()), coerceCtx(makeCtx()), 'hello');

    expect(result).toEqual({ handled: false });
    expect(brancher.branch).not.toHaveBeenCalled();
    expect(persistMapping).not.toHaveBeenCalled();
  });

  it('idle 状態でターンが見つかった場合、branch → rewind コマンド発行 → マッピング保存し handled: true', async () => {
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(5);
    brancher.branch.mockResolvedValueOnce('new-session-xyz');

    const msg = makeMessage({ channelId: 'ch-42', referencedId: 'ref-1' });
    const ctx = makeCtx({
      sessionId: 'src-session',
      state: 'idle',
      workDir: '/work',
      workspaceName: 'ws',
    });

    const result = await handler(coerceMessage(msg), coerceCtx(ctx), 'override prompt');

    expect(result).toEqual({ handled: true });
    expect(turnStore.findTurn).toHaveBeenCalledWith('src-session', '/work', 'ref-1');
    expect(turnStore.findTurnAcrossSessions).not.toHaveBeenCalled();
    expect(brancher.branch).toHaveBeenCalledWith('src-session', '/work', 4);
    expect(ctx.orchestrator.handleCommand).toHaveBeenCalledWith({
      type: 'rewind',
      targetTurn: 4,
      newSessionId: 'new-session-xyz',
      prompt: 'override prompt',
    } satisfies Command);
    expect(persistMapping).toHaveBeenCalledWith('ch-42', 'new-session-xyz', {
      path: '/work',
      name: 'ws',
    });
  });

  it('現セッションで見つからないが横断検索で見つかった場合、そのセッションを branch 元にする', async () => {
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(null);
    turnStore.findTurnAcrossSessions.mockResolvedValueOnce({
      sessionId: 'other-session',
      turn: 3,
    });
    brancher.branch.mockResolvedValueOnce('branched-from-other');

    const ctx = makeCtx({ sessionId: 'current', state: 'idle', workDir: '/w' });
    const result = await handler(coerceMessage(makeMessage()), coerceCtx(ctx), 'p');

    expect(result).toEqual({ handled: true });
    expect(brancher.branch).toHaveBeenCalledWith('other-session', '/w', 2);
    expect(ctx.orchestrator.handleCommand).toHaveBeenCalledWith({
      type: 'rewind',
      targetTurn: 2,
      newSessionId: 'branched-from-other',
      prompt: 'p',
    } satisfies Command);
  });

  it('busy 状態では branch せず、newSessionId 空の rewind コマンドのみ発行して handled: true', async () => {
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(7);
    const ctx = makeCtx({ state: 'busy' });

    const result = await handler(coerceMessage(makeMessage()), coerceCtx(ctx), 'mid-run prompt');

    expect(result).toEqual({ handled: true });
    expect(brancher.branch).not.toHaveBeenCalled();
    expect(persistMapping).not.toHaveBeenCalled();
    expect(ctx.orchestrator.handleCommand).toHaveBeenCalledWith({
      type: 'rewind',
      targetTurn: 6,
      newSessionId: '',
      prompt: 'mid-run prompt',
    } satisfies Command);
  });

  it('interrupting 状態でも branch せず通知のみ', async () => {
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(2);
    const ctx = makeCtx({ state: 'interrupting' });

    const result = await handler(coerceMessage(makeMessage()), coerceCtx(ctx), 'q');

    expect(result).toEqual({ handled: true });
    expect(brancher.branch).not.toHaveBeenCalled();
    expect(ctx.orchestrator.handleCommand).toHaveBeenCalledWith({
      type: 'rewind',
      targetTurn: 1,
      newSessionId: '',
      prompt: 'q',
    } satisfies Command);
  });

  it('branch() が throw した場合はエラーログと Discord 通知を行い handled: true を返す', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(3);
    const branchError = new Error('branch failed');
    brancher.branch.mockRejectedValueOnce(branchError);

    const msg = makeMessage();
    const ctx = makeCtx({ state: 'idle' });
    const result = await handler(coerceMessage(msg), coerceCtx(ctx), 'p');

    expect(result).toEqual({ handled: true });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Rewind error:', branchError);
    expect(msg.channel.send).toHaveBeenCalledWith('巻き戻しに失敗しました');
    expect(persistMapping).not.toHaveBeenCalled();
    expect(ctx.orchestrator.handleCommand).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('branch は成功したが Discord 通知送信が reject しても例外を伝播させない', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(3);
    brancher.branch.mockRejectedValueOnce(new Error('boom'));

    const msg = makeMessage();
    msg.channel.send.mockRejectedValueOnce(new Error('discord down'));

    await expect(
      handler(coerceMessage(msg), coerceCtx(makeCtx({ state: 'idle' })), 'p'),
    ).resolves.toEqual({ handled: true });

    expect(msg.channel.send).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('channel が send を持たない型 (例: PartialGroupDMChannel) の場合、エラー通知送信を試みない', async () => {
    // 実際の MessageCreate 経路ではスレッドチャンネルに絞り込み済みのため発生しないが、
    // 型安全のためのガードが機能していることを確認する
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = makeHandler();
    turnStore.findTurn.mockResolvedValueOnce(3);
    brancher.branch.mockRejectedValueOnce(new Error('boom'));

    const msg = {
      channelId: 'thread-1',
      reference: { messageId: 'r' },
      channel: {},
    } as unknown as Message;

    const result = await handler(msg, coerceCtx(makeCtx({ state: 'idle' })), 'p');

    expect(result).toEqual({ handled: true });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
