import { ChannelType, type Message } from 'discord.js';
import type { MessageHandlerFn } from '../app/message-handler.js';
import type { SessionManager } from '../domain/session-manager.js';
import { resolvePrompt } from '../infrastructure/attachment-resolver.js';
import type { ThreadSender } from '../infrastructure/discord-notifier.js';
import type { SessionRestorer } from '../infrastructure/session-restorer.js';
import type { TurnStore } from '../infrastructure/turn-store.js';
import { log } from '../helpers.js';
import type { RewindHandlerFn } from './rewind-handler.js';

export interface MessageControllerDeps {
  sessionManager: SessionManager;
  sessionRestorer: SessionRestorer;
  rewindHandler: RewindHandlerFn;
  turnStore: TurnStore;
  handleMessage: MessageHandlerFn;
}

export type MessageControllerFn = (msg: Message) => Promise<void>;

/**
 * Discord の MessageCreate イベントに登録するハンドラを生成する。
 *
 * 処理の流れ:
 *  1. Bot 自身の発言 / スレッド外の発言を早期 return で除外
 *  2. 添付テキストファイルをプロンプトに展開 (docs/10_Attachment_Text)
 *  3. セッションを取得、なければディスクから遅延復元 (docs/19_Session_Persistence)
 *  4. Bot 応答へのリプライなら巻き戻しを試行 (rewindHandler, docs/17_Conversation_Rewind)
 *  5. 通常メッセージとして App 層 (handleMessage) に委譲
 *  6. busy 遷移したらユーザーのメッセージ ID をターンストアに記録 (巻き戻し支援)
 */
export function createMessageController(deps: MessageControllerDeps): MessageControllerFn {
  const { sessionManager, sessionRestorer, rewindHandler, turnStore, handleMessage } = deps;

  return async (msg) => {
    if (msg.author.bot) return;

    if (
      msg.channel.type !== ChannelType.PublicThread &&
      msg.channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    const parentChannelId = msg.channel.parentId;
    if (!parentChannelId) return;

    const attachments = [...msg.attachments.values()].map((a) => ({
      contentType: a.contentType,
      name: a.name,
      size: a.size,
      url: a.url,
    }));
    const { prompt, error } = await resolvePrompt(msg.content, attachments);

    if (prompt === null) return;

    log(
      `メッセージ受信: ${msg.author.username} "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}" (thread: ${msg.channelId})`,
    );

    let ctx = sessionManager.get(msg.channelId);
    if (!ctx) {
      ctx = await sessionRestorer.tryRestore(msg.channelId, msg.channel as ThreadSender);
    }

    if (error && ctx) {
      msg.channel.send(error).catch((err) => console.error('Discord send error:', err));
    }

    if (ctx) {
      ctx.setAuthorId(msg.author.id);
    }

    const rewindResult = await rewindHandler(msg, ctx, prompt);
    if (rewindResult.handled) return;

    const prevState = ctx?.orchestrator.state;

    handleMessage({
      authorBot: false,
      authorId: msg.author.id,
      channelId: parentChannelId,
      threadId: msg.channelId,
      content: prompt,
    });

    if (ctx && prevState === 'idle' && ctx.orchestrator.state === 'busy') {
      turnStore
        .record(ctx.session.sessionId!, ctx.session.workDir, ctx.orchestrator.currentTurn, msg.id)
        .catch((err) => console.error('Turn record error:', err));
    }

    const newState = ctx?.orchestrator.state;
    if (prevState !== newState) {
      log(`状態遷移: ${prevState} → ${newState} (thread: ${msg.channelId})`);
    }
  };
}
