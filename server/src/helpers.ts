import type { Notification, UsageInfo } from './domain/types.js';

export function formatRelativeDate(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}時間前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}日前`;
  return date.toLocaleDateString('ja-JP');
}

/** 現在の「今日」を JST 基準で取得（6時前なら前日扱い） */
export function todayJST(): Date {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (jstNow.getUTCHours() < 6) {
    jstNow.setUTCDate(jstNow.getUTCDate() - 1);
  }
  return new Date(
    Date.parse(
      `${jstNow.getUTCFullYear()}-${String(jstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(jstNow.getUTCDate()).padStart(2, '0')}T00:00:00+09:00`,
    ),
  );
}

/** JST の Date を YYYY-MM-DD 形式の文字列に変換 */
export function formatJSTDate(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * ユーザー入力の日付文字列をパースする。
 * - YYYY-MM-DD 形式
 * - 相対指定: -1(昨日), -2(一昨日), 0(今日) 等
 * 不正な値の場合は null を返す。
 */
export function parseDateInput(input: string): Date | null {
  // 相対指定: -N, +N, 0
  const relativeMatch = input.match(/^([+-]?\d+)$/);
  if (relativeMatch) {
    const offset = parseInt(relativeMatch[1], 10);
    const base = todayJST();
    base.setDate(base.getDate() + offset);
    return base;
  }

  // YYYY-MM-DD 形式
  const parsed = Date.parse(input + 'T00:00:00+09:00');
  if (isNaN(parsed)) return null;
  return new Date(parsed);
}

/** オートコンプリート用: 直近の日付候補を生成 */
export function generateDateChoices(): { name: string; value: string }[] {
  const labels = ['今日', '昨日', '一昨日'];
  const choices: { name: string; value: string }[] = [];
  const base = todayJST();

  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = formatJSTDate(d);
    const label = labels[i] ?? `${i}日前`;
    choices.push({ name: `${label} (${dateStr})`, value: dateStr });
  }
  return choices;
}

export function log(message: string): void {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  console.log(`[${time}] ${message}`);
}

export function logNotification(notification: Notification): void {
  switch (notification.type) {
    case 'info':
      log(`通知: ${notification.message}`);
      break;
    case 'result':
      log(`結果: ${notification.text.slice(0, 100)}${notification.text.length > 100 ? '...' : ''}`);
      break;
    case 'error':
      log(`エラー (exit ${notification.exitCode}): ${notification.message}`);
      break;
    case 'progress':
      if (notification.event.kind === 'started') {
        log('途中経過: 📨 受信しました。処理を開始します...');
      } else if (notification.event.kind === 'tool_use') {
        log(`途中経過: 🔧 ${notification.event.toolName}: ${notification.event.target}`);
      } else {
        log(`途中経過: 💭 ${notification.event.text}`);
      }
      break;
    case 'usage': {
      const u = notification.usage;
      const parts: string[] = [];
      if (u.fiveHour) parts.push(`5h ${u.fiveHour.utilization}%`);
      if (u.sevenDay) parts.push(`7d ${u.sevenDay.utilization}%`);
      if (u.sevenDaySonnet) parts.push(`Sonnet ${u.sevenDaySonnet.utilization}%`);
      log(`利用状況: ${parts.join(' | ') || 'N/A'}`);
      break;
    }
  }
}

export function formatUsageParts(usage: UsageInfo): string {
  const parts: string[] = [];
  if (usage.fiveHour) parts.push(`5h ${usage.fiveHour.utilization}%`);
  if (usage.sevenDay) parts.push(`7d ${usage.sevenDay.utilization}%`);
  if (usage.sevenDaySonnet) parts.push(`Sonnet ${usage.sevenDaySonnet.utilization}%`);
  return parts.join(' | ') || 'N/A';
}
