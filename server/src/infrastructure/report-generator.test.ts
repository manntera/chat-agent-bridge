import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DailySession } from './report-generator.js';

const FAKE_API_KEY = 'test-api-key';

function geminiResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

function makeSessions(count = 2): DailySession[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `session-${i}`,
    title: `タスク${i + 1}`,
    messageCount: 4,
    entries: [
      { role: 'user' as const, text: `指示${i + 1}` },
      { role: 'assistant' as const, text: `応答${i + 1}` },
    ],
  }));
}

describe('ReportGenerator', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createGenerator() {
    const { ReportGenerator } = await import('./report-generator.js');
    return new ReportGenerator(FAKE_API_KEY);
  }

  it('正常系: 2段階で日報を生成する', async () => {
    const sessionSummary = '【作業内容】\nタスクを実施\n【技術的な判断】\nなし\n【課題・問題点】\nなし\n【次のアクション】\nなし';
    const reportBody = '## やったこと\n### タスク1\n詳細\n## 技術的な判断・決定事項\nなし\n## 発生した課題・ブロッカー\nなし\n## 次にやること\n- なし';

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      // Pass 1 (セッション要約) と Pass 2 (日報生成) で異なるレスポンス
      const text = callCount <= 2 ? sessionSummary : reportBody;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(geminiResponse(text)),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const generator = await createGenerator();
    const date = new Date('2026-03-22T00:00:00+09:00');
    const report = await generator.generate(makeSessions(), date);

    expect(report).not.toBeNull();
    expect(report).toContain('📋 **日報 — 2026-03-22**');
    expect(report).toContain('## やったこと');
    expect(report).not.toContain('## セッション一覧');
    // 2セッション分の Pass 1 + 1回の Pass 2 = 3回
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('Pass 1 で各セッションの会話が個別に渡される', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(geminiResponse('要約テキスト')),
    });
    vi.stubGlobal('fetch', mockFetch);

    const generator = await createGenerator();
    await generator.generate(makeSessions(2), new Date('2026-03-22T00:00:00+09:00'));

    // Pass 1: 1回目はセッション1の会話を含む
    const pass1Call1Body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const pass1Prompt1 = pass1Call1Body.contents[0].parts[0].text;
    expect(pass1Prompt1).toContain('user: 指示1');
    expect(pass1Prompt1).not.toContain('user: 指示2');

    // Pass 1: 2回目はセッション2の会話を含む
    const pass1Call2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
    const pass1Prompt2 = pass1Call2Body.contents[0].parts[0].text;
    expect(pass1Prompt2).toContain('user: 指示2');
    expect(pass1Prompt2).not.toContain('user: 指示1');
  });

  it('Pass 2 で全セッションの要約が統合される', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      const text = callCount <= 2 ? `要約${callCount}の内容` : '最終日報';
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(geminiResponse(text)),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const generator = await createGenerator();
    await generator.generate(makeSessions(2), new Date());

    // Pass 2 (3回目の呼び出し) に両方の要約が含まれる
    const pass2Body = JSON.parse(mockFetch.mock.calls[2][1].body);
    const pass2Prompt = pass2Body.contents[0].parts[0].text;
    expect(pass2Prompt).toContain('要約1の内容');
    expect(pass2Prompt).toContain('要約2の内容');
    expect(pass2Prompt).toContain('セッション 1: タスク1');
    expect(pass2Prompt).toContain('セッション 2: タスク2');
  });

  it('空のセッションリストは null を返す', async () => {
    const generator = await createGenerator();
    const report = await generator.generate([], new Date());

    expect(report).toBeNull();
  });

  it('Pass 1 が全て失敗した場合は null を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const generator = await createGenerator();
    const report = await generator.generate(makeSessions(), new Date());

    expect(report).toBeNull();
  });

  it('Pass 2 が失敗した場合は null を返す', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(geminiResponse('要約')),
        });
      }
      // Pass 2 で失敗
      return Promise.resolve({ ok: false, status: 500 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const generator = await createGenerator();
    const report = await generator.generate(makeSessions(), new Date());

    expect(report).toBeNull();
  });

  it('タイムアウト時は null を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { name: 'AbortError' })),
    );

    const generator = await createGenerator();
    const report = await generator.generate(makeSessions(), new Date());

    expect(report).toBeNull();
  });

  it('一部の Pass 1 が失敗しても成功したセッションで日報を生成する', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // 1つ目のセッション要約は失敗
        return Promise.resolve({ ok: false, status: 500 });
      }
      // 2つ目のセッション要約と Pass 2 は成功
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(geminiResponse('成功した内容')),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const generator = await createGenerator();
    const report = await generator.generate(makeSessions(), new Date('2026-03-22T00:00:00+09:00'));

    expect(report).not.toBeNull();
    expect(report).toContain('📋 **日報 — 2026-03-22**');
    // Pass 1 失敗1 + Pass 1 成功1 + Pass 2 = 3回
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
