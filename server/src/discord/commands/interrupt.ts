import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionManager } from '../../domain/session-manager.js';

export interface InterruptCommandDeps {
  sessionManager: SessionManager;
}

export type InterruptCommandFn = (interaction: ChatInputCommandInteraction) => Promise<void>;

/**
 * `/cc interrupt` サブコマンドのハンドラを生成する。
 *
 * 処理中 (`busy`) の Claude プロセスに中断コマンドを送り、SIGINT → 10 秒待機 → SIGKILL の
 * フローを起動する。スレッド外では拒否し、対象スレッドにセッションが紐づいていなければ
 * 拒否メッセージを返す。詳細は docs/07_PoC_Improvements.md を参照。
 */
export function createInterruptCommand(deps: InterruptCommandDeps): InterruptCommandFn {
  const { sessionManager } = deps;

  return async (interaction) => {
    const isThread =
      interaction.channel?.type === ChannelType.PublicThread ||
      interaction.channel?.type === ChannelType.PrivateThread;

    if (!isThread) {
      await interaction.reply({
        content: 'セッションスレッド内で実行してください',
        ephemeral: true,
      });
      return;
    }

    const ctx = sessionManager.get(interaction.channelId);
    if (!ctx) {
      await interaction.reply({
        content: 'このスレッドにはセッションが紐づいていません',
        ephemeral: true,
      });
      return;
    }

    if (ctx.orchestrator.state === 'busy') {
      ctx.orchestrator.handleCommand({ type: 'interrupt' });
      await interaction.reply({ content: '✅', ephemeral: true });
    } else if (ctx.orchestrator.state === 'interrupting') {
      await interaction.reply({ content: '既に中断処理中です', ephemeral: true });
    } else {
      await interaction.reply({ content: '処理中ではありません', ephemeral: true });
    }
  };
}
