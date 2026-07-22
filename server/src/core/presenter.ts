import type { Notification, OutboundMessage, UsageInfo } from './types.js';
import { EMPTY_USAGE } from './types.js';

/**
 * Notification 列を OutboundMessage 列へ変換するプレゼンター。
 *
 * 旧 discord-notifier からプラットフォーム非依存のポリシーだけを抽出したもの:
 * - progress / info → 即時送出
 * - result / error → バッファし、usage 到着時にフッター付きで送出
 * - started で activity(タイピング表示等)を開始、usage で停止
 * - setAuthorId で設定された質問者を result / error にメンション対象として添付
 *
 * 文字数分割・Embed・メンション記法などの描画はレンダラー(プラットフォーム側)の責務。
 */

export type EmitFn = (message: OutboundMessage) => void;

type PendingResult =
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; exitCode: number };

export function formatProgressText(
  event: Extract<Notification, { type: 'progress' }>['event'],
): string {
  if (event.kind === 'started') return '📨 受信しました。処理を開始します...';
  if (event.kind === 'tool_use') return `🔧 ${event.toolName}: ${event.target}`;
  return `💭 ${event.text}`;
}

export function formatUsageFooter(usage: UsageInfo): string | null {
  const parts: string[] = [];
  if (usage.fiveHour) parts.push(`5h ${usage.fiveHour.utilization}%`);
  if (usage.sevenDay) parts.push(`7d ${usage.sevenDay.utilization}%`);
  if (usage.sevenDaySonnet) parts.push(`Sonnet ${usage.sevenDaySonnet.utilization}%`);
  return parts.length > 0 ? `📊 ${parts.join(' | ')}` : null;
}

export class Presenter {
  private pending: PendingResult | null = null;
  private authorId: string | null = null;
  private active = false;

  constructor(private readonly emit: EmitFn) {}

  setAuthorId(authorId: string): void {
    this.authorId = authorId;
  }

  /** 会話破棄時に activity を確実に止める */
  dispose(): void {
    if (this.active) {
      this.active = false;
      this.emit({ kind: 'activity', active: false });
    }
  }

  notify(notification: Notification): void {
    switch (notification.type) {
      case 'progress':
        if (notification.event.kind === 'started' && !this.active) {
          this.active = true;
          this.emit({ kind: 'activity', active: true });
        }
        this.emit({ kind: 'progress', text: formatProgressText(notification.event) });
        break;

      case 'info':
        this.emit({ kind: 'plain', text: notification.message });
        break;

      case 'result':
        this.pending = { type: 'result', text: notification.text };
        break;

      case 'error':
        this.pending = {
          type: 'error',
          message: notification.message,
          exitCode: notification.exitCode,
        };
        break;

      case 'usage':
        if (this.active) {
          this.active = false;
          this.emit({ kind: 'activity', active: false });
        }
        this.flush(notification.usage);
        break;
    }
  }

  private flush(usage: UsageInfo): void {
    const footer = formatUsageFooter(usage);
    const pending = this.pending;
    this.pending = null;

    if (pending === null) {
      // result/error なしで usage だけ届いた場合(中断・新セッション切替後)も
      // フッターだけは見せる
      if (footer) {
        this.emit({ kind: 'result', text: '', mentionUserId: null, footer });
      }
      return;
    }

    if (pending.type === 'result') {
      this.emit({
        kind: 'result',
        text: pending.text,
        mentionUserId: this.authorId,
        footer,
      });
    } else {
      this.emit({
        kind: 'error',
        title: `エラー (exit ${pending.exitCode})`,
        body: pending.message,
        mentionUserId: this.authorId,
        footer,
      });
    }
  }
}

export { EMPTY_USAGE };
