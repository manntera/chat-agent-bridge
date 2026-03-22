import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatRelativeDate,
  todayJST,
  formatJSTDate,
  parseDateInput,
  generateDateChoices,
  log,
  logNotification,
  formatUsageParts,
} from './helpers.js';
import type { UsageInfo } from './domain/types.js';

describe('formatRelativeDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1分未満は「たった今」', () => {
    const date = new Date('2026-03-22T11:59:30Z');
    expect(formatRelativeDate(date)).toBe('たった今');
  });

  it('1分〜60分未満は「N分前」', () => {
    const date = new Date('2026-03-22T11:30:00Z');
    expect(formatRelativeDate(date)).toBe('30分前');
  });

  it('1時間〜24時間未満は「N時間前」', () => {
    const date = new Date('2026-03-22T06:00:00Z');
    expect(formatRelativeDate(date)).toBe('6時間前');
  });

  it('1日〜30日未満は「N日前」', () => {
    const date = new Date('2026-03-20T12:00:00Z');
    expect(formatRelativeDate(date)).toBe('2日前');
  });

  it('30日以上は日付文字列', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const result = formatRelativeDate(date);
    expect(result).toMatch(/2026/);
  });
});

describe('todayJST', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('JST 6時以降は当日を返す', () => {
    vi.useFakeTimers();
    // UTC 00:00 = JST 09:00
    vi.setSystemTime(new Date('2026-03-22T00:00:00Z'));
    const result = todayJST();
    const jstDate = new Date(result.getTime() + 9 * 60 * 60 * 1000);
    expect(jstDate.getUTCDate()).toBe(22);
  });

  it('JST 6時前は前日扱い', () => {
    vi.useFakeTimers();
    // UTC 20:00 = JST 翌日05:00 → 前日扱い
    vi.setSystemTime(new Date('2026-03-21T20:00:00Z'));
    const result = todayJST();
    const jstDate = new Date(result.getTime() + 9 * 60 * 60 * 1000);
    expect(jstDate.getUTCDate()).toBe(21);
  });
});

describe('formatJSTDate', () => {
  it('Date を YYYY-MM-DD 形式に変換する', () => {
    const date = new Date('2026-03-22T00:00:00+09:00');
    expect(formatJSTDate(date)).toBe('2026-03-22');
  });

  it('月・日が1桁の場合は0埋めする', () => {
    const date = new Date('2026-01-05T00:00:00+09:00');
    expect(formatJSTDate(date)).toBe('2026-01-05');
  });
});

describe('parseDateInput', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('YYYY-MM-DD 形式をパースする', () => {
    const result = parseDateInput('2026-03-22');
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toContain('2026-03-21T15:00:00');
  });

  it('相対指定 0 は今日を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:00:00Z'));
    const result = parseDateInput('0');
    expect(result).not.toBeNull();
  });

  it('相対指定 -1 は昨日を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:00:00Z'));
    const today = parseDateInput('0');
    const yesterday = parseDateInput('-1');
    expect(today!.getTime() - yesterday!.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('相対指定 +1 は明日を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:00:00Z'));
    const today = parseDateInput('0');
    const tomorrow = parseDateInput('+1');
    expect(tomorrow!.getTime() - today!.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('不正な文字列は null を返す', () => {
    expect(parseDateInput('invalid')).toBeNull();
  });
});

describe('generateDateChoices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('7つの日付候補を生成する', () => {
    const choices = generateDateChoices();
    expect(choices).toHaveLength(7);
  });

  it('最初の3つは「今日」「昨日」「一昨日」ラベル', () => {
    const choices = generateDateChoices();
    expect(choices[0].name).toContain('今日');
    expect(choices[1].name).toContain('昨日');
    expect(choices[2].name).toContain('一昨日');
  });

  it('4日目以降は「N日前」ラベル', () => {
    const choices = generateDateChoices();
    expect(choices[3].name).toContain('3日前');
    expect(choices[6].name).toContain('6日前');
  });

  it('value は YYYY-MM-DD 形式', () => {
    const choices = generateDateChoices();
    for (const c of choices) {
      expect(c.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('log', () => {
  it('タイムスタンプ付きでログを出力する', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('テストメッセージ');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('テストメッセージ');
    spy.mockRestore();
  });
});

describe('logNotification', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('info 通知をログ出力する', () => {
    logNotification({ type: 'info', message: 'テスト情報' });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('テスト情報');
  });

  it('result 通知をログ出力する（100文字以下）', () => {
    logNotification({ type: 'result', text: '短い結果' });
    expect(spy.mock.calls[0][0]).toContain('短い結果');
    expect(spy.mock.calls[0][0]).not.toContain('...');
  });

  it('result 通知をログ出力する（100文字超は省略）', () => {
    logNotification({ type: 'result', text: 'A'.repeat(150) });
    expect(spy.mock.calls[0][0]).toContain('...');
  });

  it('error 通知をログ出力する', () => {
    logNotification({ type: 'error', message: 'エラー発生', exitCode: 1 });
    expect(spy.mock.calls[0][0]).toContain('エラー');
    expect(spy.mock.calls[0][0]).toContain('exit 1');
  });

  it('progress started をログ出力する', () => {
    logNotification({ type: 'progress', event: { kind: 'started' } });
    expect(spy.mock.calls[0][0]).toContain('受信しました');
  });

  it('progress tool_use をログ出力する', () => {
    logNotification({
      type: 'progress',
      event: { kind: 'tool_use', toolName: 'Edit', target: 'file.ts' },
    });
    expect(spy.mock.calls[0][0]).toContain('Edit');
  });

  it('progress thinking をログ出力する', () => {
    logNotification({ type: 'progress', event: { kind: 'thinking', text: '分析中' } });
    expect(spy.mock.calls[0][0]).toContain('分析中');
  });

  it('usage 通知をログ出力する（データあり）', () => {
    const usage: UsageInfo = {
      fiveHour: { utilization: 45, resetsAt: '' },
      sevenDay: { utilization: 30, resetsAt: '' },
      sevenDaySonnet: { utilization: 10, resetsAt: '' },
    };
    logNotification({ type: 'usage', usage });
    expect(spy.mock.calls[0][0]).toContain('5h 45%');
    expect(spy.mock.calls[0][0]).toContain('Sonnet 10%');
  });

  it('usage 通知をログ出力する（データなし）', () => {
    logNotification({
      type: 'usage',
      usage: { fiveHour: null, sevenDay: null, sevenDaySonnet: null },
    });
    expect(spy.mock.calls[0][0]).toContain('N/A');
  });
});

describe('formatUsageParts', () => {
  it('全てのデータがある場合', () => {
    const usage: UsageInfo = {
      fiveHour: { utilization: 45, resetsAt: '' },
      sevenDay: { utilization: 30, resetsAt: '' },
      sevenDaySonnet: { utilization: 10, resetsAt: '' },
    };
    expect(formatUsageParts(usage)).toBe('5h 45% | 7d 30% | Sonnet 10%');
  });

  it('データがない場合は N/A', () => {
    expect(formatUsageParts({ fiveHour: null, sevenDay: null, sevenDaySonnet: null })).toBe('N/A');
  });
});
