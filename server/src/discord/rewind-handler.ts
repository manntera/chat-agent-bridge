import type { Message } from 'discord.js';
import type { SessionContext } from '../domain/session-manager.js';
import type { SessionBrancher } from '../infrastructure/session-brancher.js';
import type { TurnStore } from '../infrastructure/turn-store.js';
import { log } from '../helpers.js';
import type { PersistMappingFn } from './session-factory.js';

export interface RewindHandlerDeps {
  turnStore: TurnStore;
  sessionBrancher: SessionBrancher;
  persistMapping: PersistMappingFn;
}

export type RewindHandlerFn = (
  msg: Message,
  ctx: SessionContext | null,
  prompt: string,
) => Promise<{ handled: boolean }>;

/**
 * Bot の過去応答に対するリプライを検出し、該当ターンまで会話を巻き戻した
 * 新セッションを発行する。詳細は docs/17_Conversation_Rewind.md を参照。
 *
 * 戻り値の `handled` が true の場合、呼び出し側 (MessageCreate ハンドラ) は
 * 通常のメッセージ処理をスキップする。
 */
export function createRewindHandler(deps: RewindHandlerDeps): RewindHandlerFn {
  const { turnStore, sessionBrancher, persistMapping } = deps;

  return async (msg, ctx, prompt) => {
    if (!msg.reference?.messageId || !ctx?.session.sessionId) {
      return { handled: false };
    }

    const referencedId = msg.reference.messageId;

    let sourceSessionId = ctx.session.sessionId;
    let turn = await turnStore.findTurn(sourceSessionId, ctx.session.workDir, referencedId);
    if (turn === null) {
      const found = await turnStore.findTurnAcrossSessions(ctx.session.workDir, referencedId);
      if (found) {
        sourceSessionId = found.sessionId;
        turn = found.turn;
      }
    }

    if (turn === null) {
      return { handled: false };
    }

    const branchTurn = turn - 1;

    if (ctx.orchestrator.state !== 'idle') {
      ctx.orchestrator.handleCommand({
        type: 'rewind',
        targetTurn: branchTurn,
        newSessionId: '',
        prompt,
      });
      return { handled: true };
    }

    try {
      const newSessionId = await sessionBrancher.branch(
        sourceSessionId,
        ctx.session.workDir,
        branchTurn,
      );
      log(
        `巻き戻し: Turn ${turn} を上書き (元セッション: ${sourceSessionId.slice(0, 8)}) → 新セッション ${newSessionId.slice(0, 8)} (thread: ${msg.channelId})`,
      );
      ctx.orchestrator.handleCommand({
        type: 'rewind',
        targetTurn: branchTurn,
        newSessionId,
        prompt,
      });
      await persistMapping(msg.channelId, newSessionId, {
        path: ctx.session.workDir,
        name: ctx.session.workspaceName,
      });
    } catch (err) {
      console.error('Rewind error:', err);
      if ('send' in msg.channel) {
        msg.channel.send('巻き戻しに失敗しました').catch(() => {});
      }
    }

    return { handled: true };
  };
}
