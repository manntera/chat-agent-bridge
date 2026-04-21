import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionContext, SessionManager } from '../../domain/session-manager.js';
import type { Command, OrchestratorState } from '../../domain/types.js';
import { createInterruptCommand } from './interrupt.js';

interface CtxStub {
  orchestrator: {
    state: OrchestratorState;
    handleCommand: ReturnType<typeof vi.fn>;
  };
}

interface InteractionStub {
  channel: { type: ChannelType } | null;
  channelId: string;
  reply: ReturnType<typeof vi.fn>;
}

function makeCtx(state: OrchestratorState = 'idle'): CtxStub {
  return {
    orchestrator: { state, handleCommand: vi.fn() },
  };
}

function makeInteraction(
  options: {
    channelType?: ChannelType | null;
    channelId?: string;
  } = {},
): InteractionStub {
  const { channelType = ChannelType.PublicThread, channelId = 'thread-1' } = options;
  return {
    channel: channelType === null ? null : { type: channelType },
    channelId,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function coerceCtx(c: CtxStub): SessionContext {
  return c as unknown as SessionContext;
}

function coerceInteraction(i: InteractionStub): ChatInputCommandInteraction {
  return i as unknown as ChatInputCommandInteraction;
}

describe('createInterruptCommand', () => {
  let sessionManager: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager = { get: vi.fn().mockReturnValue(null) };
  });

  function makeHandler() {
    return createInterruptCommand({
      sessionManager: sessionManager as unknown as SessionManager,
    });
  }

  it('スレッド外で実行された場合は拒否メッセージを返し、セッションを検索しない', async () => {
    const handler = makeHandler();
    const interaction = makeInteraction({ channelType: ChannelType.GuildText });

    await handler(coerceInteraction(interaction));

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'セッションスレッド内で実行してください',
      ephemeral: true,
    });
    expect(sessionManager.get).not.toHaveBeenCalled();
  });

  it('スレッド内でもセッションが紐づいていなければ拒否メッセージを返す', async () => {
    const handler = makeHandler();
    sessionManager.get.mockReturnValue(null);
    const interaction = makeInteraction({ channelId: 'thread-42' });

    await handler(coerceInteraction(interaction));

    expect(sessionManager.get).toHaveBeenCalledWith('thread-42');
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'このスレッドにはセッションが紐づいていません',
      ephemeral: true,
    });
  });

  it('busy 状態なら interrupt コマンドを発行し「✅」を返す', async () => {
    const ctx = makeCtx('busy');
    sessionManager.get.mockReturnValue(coerceCtx(ctx));
    const handler = makeHandler();
    const interaction = makeInteraction();

    await handler(coerceInteraction(interaction));

    expect(ctx.orchestrator.handleCommand).toHaveBeenCalledWith({
      type: 'interrupt',
    } satisfies Command);
    expect(interaction.reply).toHaveBeenCalledWith({ content: '✅', ephemeral: true });
  });

  it('interrupting 状態なら「既に中断処理中です」を返し、コマンドは発行しない', async () => {
    const ctx = makeCtx('interrupting');
    sessionManager.get.mockReturnValue(coerceCtx(ctx));
    const handler = makeHandler();
    const interaction = makeInteraction();

    await handler(coerceInteraction(interaction));

    expect(ctx.orchestrator.handleCommand).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: '既に中断処理中です',
      ephemeral: true,
    });
  });

  it('idle 状態なら「処理中ではありません」を返し、コマンドは発行しない', async () => {
    const ctx = makeCtx('idle');
    sessionManager.get.mockReturnValue(coerceCtx(ctx));
    const handler = makeHandler();
    const interaction = makeInteraction();

    await handler(coerceInteraction(interaction));

    expect(ctx.orchestrator.handleCommand).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: '処理中ではありません',
      ephemeral: true,
    });
  });

  it('initial 状態なら「処理中ではありません」を返し、コマンドは発行しない (OrchestratorState 初期値の網羅)', async () => {
    const ctx = makeCtx('initial');
    sessionManager.get.mockReturnValue(coerceCtx(ctx));
    const handler = makeHandler();
    const interaction = makeInteraction();

    await handler(coerceInteraction(interaction));

    expect(ctx.orchestrator.handleCommand).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: '処理中ではありません',
      ephemeral: true,
    });
  });
});
