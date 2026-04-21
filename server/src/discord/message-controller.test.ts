import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType, type Message } from 'discord.js';
import type { MessageHandlerFn } from '../app/message-handler.js';
import type { SessionContext, SessionManager } from '../domain/session-manager.js';
import type { OrchestratorState } from '../domain/types.js';
import type { SessionRestorer } from '../infrastructure/session-restorer.js';
import type { TurnStore } from '../infrastructure/turn-store.js';
import { createMessageController } from './message-controller.js';
import type { RewindHandlerFn } from './rewind-handler.js';

vi.mock('../infrastructure/attachment-resolver.js', () => ({
  resolvePrompt: vi
    .fn<
      (
        content: string,
        attachments: unknown[],
      ) => Promise<{ prompt: string | null; error: string | null }>
    >()
    .mockImplementation(async (content) => ({ prompt: content, error: null })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolvePromptModule: any = await import('../infrastructure/attachment-resolver.js');
const mockedResolvePrompt = resolvePromptModule.resolvePrompt as ReturnType<typeof vi.fn>;

interface CtxStub {
  session: { sessionId: string | null; workDir: string; workspaceName: string };
  orchestrator: { state: OrchestratorState; currentTurn: number };
  setAuthorId: ReturnType<typeof vi.fn>;
}

function makeCtx(
  options: {
    sessionId?: string | null;
    state?: OrchestratorState;
    currentTurn?: number;
  } = {},
): CtxStub {
  const { sessionId = 'sess-1', state = 'idle', currentTurn = 0 } = options;
  return {
    session: { sessionId, workDir: '/work', workspaceName: 'ws' },
    orchestrator: { state, currentTurn },
    setAuthorId: vi.fn(),
  };
}

function coerceCtx(c: CtxStub): SessionContext {
  return c as unknown as SessionContext;
}

interface MessageStubOptions {
  authorBot?: boolean;
  authorId?: string;
  authorUsername?: string;
  channelType?: ChannelType;
  parentId?: string | null;
  channelId?: string;
  messageId?: string;
  content?: string;
  attachments?: Map<
    string,
    { contentType: string | null; name: string | null; size: number; url: string }
  >;
}

function makeMessage(opts: MessageStubOptions = {}): Message {
  const {
    authorBot = false,
    authorId = 'user-1',
    authorUsername = 'alice',
    channelType = ChannelType.PublicThread,
    parentId = 'parent-channel',
    channelId = 'thread-1',
    messageId = 'msg-1',
    content = 'hello',
    attachments = new Map(),
  } = opts;

  const channelSend = vi.fn().mockResolvedValue(undefined);

  return {
    author: { bot: authorBot, id: authorId, username: authorUsername },
    channel: { type: channelType, parentId, send: channelSend },
    channelId,
    id: messageId,
    content,
    attachments,
  } as unknown as Message;
}

function channelSendOf(msg: Message): ReturnType<typeof vi.fn> {
  return (msg.channel as unknown as { send: ReturnType<typeof vi.fn> }).send;
}

describe('createMessageController', () => {
  let sessionManager: { get: ReturnType<typeof vi.fn> };
  let sessionRestorer: { tryRestore: ReturnType<typeof vi.fn> };
  let rewindHandler: ReturnType<typeof vi.fn<RewindHandlerFn>>;
  let turnStore: { record: ReturnType<typeof vi.fn> };
  let handleMessage: ReturnType<typeof vi.fn<MessageHandlerFn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager = { get: vi.fn().mockReturnValue(null) };
    sessionRestorer = { tryRestore: vi.fn().mockResolvedValue(null) };
    rewindHandler = vi.fn<RewindHandlerFn>().mockResolvedValue({ handled: false });
    turnStore = { record: vi.fn().mockResolvedValue(undefined) };
    handleMessage = vi.fn<MessageHandlerFn>();
    mockedResolvePrompt.mockImplementation(async (content: string) => ({
      prompt: content,
      error: null,
    }));
  });

  function makeController() {
    return createMessageController({
      sessionManager: sessionManager as unknown as SessionManager,
      sessionRestorer: sessionRestorer as unknown as SessionRestorer,
      rewindHandler,
      turnStore: turnStore as unknown as TurnStore,
      handleMessage,
    });
  }

  it('Bot 自身の発言は早期 return', async () => {
    const controller = makeController();
    await controller(makeMessage({ authorBot: true }));

    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(rewindHandler).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('スレッド外 (TextChannel 直下) のメッセージは早期 return', async () => {
    const controller = makeController();
    await controller(makeMessage({ channelType: ChannelType.GuildText }));

    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('parentId が null のスレッド (通常はありえない) は早期 return', async () => {
    const controller = makeController();
    await controller(makeMessage({ parentId: null }));

    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('resolvePrompt が prompt: null を返した場合は早期 return', async () => {
    mockedResolvePrompt.mockResolvedValueOnce({ prompt: null, error: 'too large' });
    const controller = makeController();
    await controller(makeMessage());

    expect(sessionManager.get).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('PrivateThread でも処理対象', async () => {
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    const controller = makeController();
    await controller(makeMessage({ channelType: ChannelType.PrivateThread }));

    expect(handleMessage).toHaveBeenCalled();
  });

  it('セッションが既にあれば tryRestore を呼ばない', async () => {
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    const controller = makeController();
    await controller(makeMessage());

    expect(sessionRestorer.tryRestore).not.toHaveBeenCalled();
    expect(ctx.setAuthorId).toHaveBeenCalledWith('user-1');
  });

  it('セッションが無ければ tryRestore で復元を試みる', async () => {
    sessionManager.get.mockReturnValue(null);
    const restored = makeCtx();
    sessionRestorer.tryRestore.mockResolvedValueOnce(coerceCtx(restored));

    const controller = makeController();
    await controller(makeMessage({ channelId: 'thread-42' }));

    expect(sessionRestorer.tryRestore).toHaveBeenCalledWith('thread-42', expect.anything());
    expect(restored.setAuthorId).toHaveBeenCalledWith('user-1');
  });

  it('resolvePrompt が error を返し、ctx があれば channel.send で通知する', async () => {
    mockedResolvePrompt.mockResolvedValueOnce({
      prompt: 'hello',
      error: '一部の添付ファイルを展開できませんでした',
    });
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    const msg = makeMessage();
    const controller = makeController();
    await controller(msg);

    expect(channelSendOf(msg)).toHaveBeenCalledWith('一部の添付ファイルを展開できませんでした');
  });

  it('resolvePrompt が error を返しても ctx が null なら send しない', async () => {
    mockedResolvePrompt.mockResolvedValueOnce({ prompt: 'hello', error: 'some error' });
    sessionManager.get.mockReturnValue(null);
    sessionRestorer.tryRestore.mockResolvedValueOnce(null);

    const msg = makeMessage();
    const controller = makeController();
    await controller(msg);

    expect(channelSendOf(msg)).not.toHaveBeenCalled();
  });

  it('rewindHandler が handled: true を返せば handleMessage を呼ばない', async () => {
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));
    rewindHandler.mockResolvedValueOnce({ handled: true });

    const controller = makeController();
    await controller(makeMessage());

    expect(handleMessage).not.toHaveBeenCalled();
    expect(turnStore.record).not.toHaveBeenCalled();
  });

  it('rewindHandler が handled: false なら handleMessage に委譲する', async () => {
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    const controller = makeController();
    await controller(
      makeMessage({
        channelId: 'thr-1',
        messageId: 'm-99',
        content: 'please do X',
        authorId: 'usr-7',
      }),
    );

    expect(handleMessage).toHaveBeenCalledWith({
      authorBot: false,
      authorId: 'usr-7',
      channelId: 'parent-channel',
      threadId: 'thr-1',
      content: 'please do X',
    });
  });

  it('idle → busy 遷移したときにユーザーメッセージ ID を turnStore.record に記録する', async () => {
    const ctx = makeCtx({ sessionId: 'sess-77', state: 'idle', currentTurn: 0 });
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    handleMessage.mockImplementation(() => {
      ctx.orchestrator.state = 'busy';
      ctx.orchestrator.currentTurn = 3;
    });

    const controller = makeController();
    await controller(makeMessage({ messageId: 'm-abc' }));
    await Promise.resolve();

    expect(turnStore.record).toHaveBeenCalledWith('sess-77', '/work', 3, 'm-abc');
  });

  it('状態が idle のままなら turnStore.record を呼ばない', async () => {
    const ctx = makeCtx({ state: 'idle' });
    sessionManager.get.mockReturnValue(coerceCtx(ctx));
    handleMessage.mockImplementation(() => {
      // state は変わらない (AccessControl で弾かれたケース等)
    });

    const controller = makeController();
    await controller(makeMessage());

    expect(turnStore.record).not.toHaveBeenCalled();
  });

  it('ctx が null のままでも handleMessage は (App 層で弾く前提で) 呼ばれ、turnStore.record は呼ばれない', async () => {
    sessionManager.get.mockReturnValue(null);
    sessionRestorer.tryRestore.mockResolvedValueOnce(null);

    const controller = makeController();
    await controller(makeMessage());

    expect(handleMessage).toHaveBeenCalled();
    expect(turnStore.record).not.toHaveBeenCalled();
  });

  it('添付ファイルを resolvePrompt に正しい形で渡す', async () => {
    const attachments = new Map([
      [
        'a1',
        {
          contentType: 'text/plain',
          name: 'notes.txt',
          size: 100,
          url: 'https://cdn/notes.txt',
        },
      ],
    ]);
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    const controller = makeController();
    await controller(makeMessage({ content: 'body', attachments }));

    expect(mockedResolvePrompt).toHaveBeenCalledWith('body', [
      { contentType: 'text/plain', name: 'notes.txt', size: 100, url: 'https://cdn/notes.txt' },
    ]);
  });

  it('100 文字を超える prompt はログで省略されるが正常に処理される', async () => {
    const longContent = 'x'.repeat(250);
    mockedResolvePrompt.mockResolvedValueOnce({ prompt: longContent, error: null });
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    const controller = makeController();
    await controller(makeMessage({ content: longContent }));

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: longContent }),
    );
  });

  it('turnStore.record が reject しても例外を伝播させない', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx({ sessionId: 'sess', state: 'idle', currentTurn: 1 });
    sessionManager.get.mockReturnValue(coerceCtx(ctx));
    turnStore.record.mockRejectedValueOnce(new Error('disk full'));
    handleMessage.mockImplementation(() => {
      ctx.orchestrator.state = 'busy';
    });

    const controller = makeController();
    await expect(controller(makeMessage())).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(turnStore.record).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('channel.send が reject しても例外を伝播させない (error 通知時)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedResolvePrompt.mockResolvedValueOnce({ prompt: 'hi', error: 'oops' });
    const ctx = makeCtx();
    sessionManager.get.mockReturnValue(coerceCtx(ctx));

    const msg = makeMessage();
    channelSendOf(msg).mockRejectedValueOnce(new Error('discord down'));

    const controller = makeController();
    await expect(controller(msg)).resolves.toBeUndefined();
    await Promise.resolve();

    consoleErrorSpy.mockRestore();
  });
});
