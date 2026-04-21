import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { SessionSummary, Workspace } from '../../domain/types.js';
import type { DailySession, IReportGenerator } from '../../infrastructure/report-generator.js';
import { readSession } from '../../infrastructure/session-reader.js';
import { getDayBoundary } from '../../infrastructure/session-store.js';
import type { IWorkspaceStore } from '../../infrastructure/workspace-store.js';
import { generateDateChoices, log, parseDateInput, todayJST } from '../../helpers.js';

const DISCORD_MESSAGE_LIMIT = 2000;

/** report を送信するチャンネル。TextChannel のうち send だけを利用。 */
export interface ReportChannel {
  send(content: string): Promise<unknown>;
}

/** report コマンドが使用する SessionStore の部分インターフェース。 */
export interface ReportSessionStore {
  listSessionsByDateRange(workDir: string, from: Date, to: Date): Promise<SessionSummary[]>;
}

export interface ReportCommandDeps {
  reportGenerator: IReportGenerator | null;
  workspaceStore: Pick<IWorkspaceStore, 'list'>;
  sessionStore: ReportSessionStore;
  channel: ReportChannel;
}

export interface ReportCommandHandlers {
  handleCommand: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleAutocomplete: (interaction: AutocompleteInteraction) => Promise<void>;
}

/**
 * Discord の 2000 文字制限に合わせて日報を分割送信する。
 *  - report.length <= 2000: editReply のみ
 *  - それ以上: 先頭を editReply, 残りを channel.send
 */
export async function sendReport(
  interaction: Pick<ChatInputCommandInteraction, 'editReply'>,
  channel: ReportChannel,
  report: string,
): Promise<void> {
  if (report.length <= DISCORD_MESSAGE_LIMIT) {
    await interaction.editReply(report);
    return;
  }

  const chunks: string[] = [];
  let remaining = report;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, DISCORD_MESSAGE_LIMIT));
    remaining = remaining.slice(DISCORD_MESSAGE_LIMIT);
  }
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await channel.send(chunks[i]);
  }
}

/**
 * `/cc report` コマンド本体とオートコンプリートのハンドラを生成する。
 *
 * 処理の流れ (handleCommand):
 *  1. reportGenerator が null (GEMINI_API_KEY 未設定) なら ephemeral で案内して終了
 *  2. 公開応答として deferReply (ephemeral 指定なし) する
 *  3. date 引数をパース。未指定なら今日 (JST)、不正なら編集応答で案内して終了
 *  4. 対象日の [from, to) で全ワークスペースのセッションを収集
 *  5. 0 件なら編集応答で案内して終了
 *  6. 各セッション本文を読み込み、ReportGenerator.generate に渡す
 *  7. 返ってきた文字列を sendReport で 2000 文字制限に収めて投稿
 *
 * handleAutocomplete は `focused.name === 'date'` 以外を早期 return し、
 * 将来他コマンドにオートコンプリートを追加した際の衝突を避ける。
 */
export function createReportCommand(deps: ReportCommandDeps): ReportCommandHandlers {
  const { reportGenerator, workspaceStore, sessionStore, channel } = deps;

  const handleAutocomplete = async (interaction: AutocompleteInteraction): Promise<void> => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'date') return;

    const choices = generateDateChoices();
    const input = focused.value.toLowerCase();
    const filtered = input
      ? choices.filter((c) => c.name.includes(input) || c.value.includes(input))
      : choices;
    await interaction.respond(filtered.slice(0, 25));
  };

  const handleCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!reportGenerator) {
      await interaction.reply({
        content: '⚠️ 日報生成には GEMINI_API_KEY の設定が必要です',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const dateStr = interaction.options.getString('date');
      let targetDate: Date;

      if (dateStr) {
        const parsed = parseDateInput(dateStr);
        if (!parsed) {
          await interaction.editReply(
            '⚠️ 日付の形式が不正です（YYYY-MM-DD または -1, -2 等の相対指定で入力してください）',
          );
          return;
        }
        targetDate = parsed;
      } else {
        targetDate = todayJST();
      }

      const { from, to } = getDayBoundary(targetDate);

      // 全ワークスペースからセッションを収集
      const workspaces = workspaceStore.list();
      const allSessions: Array<{
        workspace: Workspace;
        sessions: Awaited<ReturnType<typeof sessionStore.listSessionsByDateRange>>;
      }> = [];
      for (const ws of workspaces) {
        const sessions = await sessionStore.listSessionsByDateRange(ws.path, from, to);
        if (sessions.length > 0) {
          allSessions.push({ workspace: ws, sessions });
        }
      }

      const totalCount = allSessions.reduce((sum, e) => sum + e.sessions.length, 0);
      if (totalCount === 0) {
        const dateLabel =
          dateStr ?? targetDate.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
        await interaction.editReply(`⚠️ ${dateLabel} のセッションが見つかりません`);
        return;
      }

      log(`日報生成開始: ${totalCount} セッション (${allSessions.length} ワークスペース)`);

      // 各セッションの会話を読み込み
      const dailySessions: DailySession[] = [];
      for (const { workspace: ws, sessions } of allSessions) {
        for (const s of sessions) {
          try {
            const entries = await readSession(s.sessionId, ws.path);
            dailySessions.push({
              sessionId: s.sessionId,
              title: `[${ws.name}] ${s.slug ?? s.firstUserMessage.slice(0, 50)}`,
              messageCount: entries.length,
              entries,
            });
          } catch {
            log(`セッション読み込みスキップ: ${s.sessionId}`);
          }
        }
      }

      if (dailySessions.length === 0) {
        await interaction.editReply('⚠️ セッションの読み込みに失敗しました');
        return;
      }

      const report = await reportGenerator.generate(dailySessions, targetDate);

      if (!report) {
        await interaction.editReply('⚠️ 日報の生成に失敗しました');
        return;
      }

      await sendReport(interaction, channel, report);

      log('日報生成完了');
    } catch (err) {
      console.error('Report generation error:', err);
      await interaction.editReply('⚠️ 日報の生成中にエラーが発生しました');
    }
  };

  return { handleCommand, handleAutocomplete };
}
