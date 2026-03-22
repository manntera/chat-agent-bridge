import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConversationEntry } from './session-reader.js';

const FAKE_API_KEY = 'test-api-key';

// モックの戻り値を制御する変数
let mockEntries: ConversationEntry[] = [];
let mockReadSessionError: Error | null = null;

vi.mock('./session-reader.js', () => ({
  readSession: vi.fn(async () => {
    if (mockReadSessionError) throw mockReadSessionError;
    return mockEntries;
  }),
  formatForTitleGeneration: vi.fn((entries: ConversationEntry[]) => {
    return entries.map((e) => `${e.role}: ${e.text}`).join('\n');
  }),
}));

function geminiResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

describe('TitleGenerator', () => {
  beforeEach(() => {
    mockEntries = [{ role: 'user', text: 'hello' }];
    mockReadSessionError = null;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // TitleGenerator を動的インポートして vi.mock のホイスティングを確実にする
  async function createGenerator() {
    const { TitleGenerator } = await import('./title-generator.js');
    return new TitleGenerator(FAKE_API_KEY);
  }

  it('正常系: Gemini API からタイトルを取得する', async () => {
    mockEntries = [
      { role: 'user', text: 'バグを直して' },
      { role: 'assistant', text: '修正しました' },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(geminiResponse('認証バグの修正')),
    });
    vi.stubGlobal('fetch', mockFetch);

    const generator = await createGenerator();
    const title = await generator.generate('session-123', '/work');

    expect(title).toBe('認証バグの修正');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('API エラー時は null を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const generator = await createGenerator();
    const title = await generator.generate('session-123', '/work');

    expect(title).toBeNull();
  });

  it('空のレスポンスは null を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ candidates: [] }),
      }),
    );

    const generator = await createGenerator();
    const title = await generator.generate('session-123', '/work');

    expect(title).toBeNull();
  });

  it('セッション読み込み失敗時は null を返す', async () => {
    mockReadSessionError = new Error('file not found');

    const generator = await createGenerator();
    const title = await generator.generate('nonexistent', '/work');

    expect(title).toBeNull();
  });

  it('100文字超のタイトルは切り詰められる', async () => {
    const longTitle = 'あ'.repeat(150);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(geminiResponse(longTitle)),
      }),
    );

    const generator = await createGenerator();
    const title = await generator.generate('session-123', '/work');

    expect(title).toHaveLength(100);
  });

  it('会話エントリが空の場合は null を返す', async () => {
    mockEntries = [];

    const generator = await createGenerator();
    const title = await generator.generate('session-123', '/work');

    expect(title).toBeNull();
  });

  it('fetch がネットワークエラーの場合は null を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const generator = await createGenerator();
    const title = await generator.generate('session-123', '/work');

    expect(title).toBeNull();
  });

  it('タイムアウト(AbortError)の場合は null を返す', async () => {
    // fetch を遅延させて setTimeout(controller.abort) が先に発火するようにする
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            reject(Object.assign(new Error('abort'), { name: 'AbortError' }));
          };
          if (options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener('abort', onAbort);
          }
        }),
    );
    vi.stubGlobal('fetch', mockFetch);

    vi.useFakeTimers();

    const generator = await createGenerator();
    const promise = generator.generate('session-123', '/work');

    // タイムアウトを発火させる（TitleGenerator の TIMEOUT_MS = 10_000）
    await vi.advanceTimersByTimeAsync(10_000);

    const title = await promise;

    expect(title).toBeNull();

    vi.useRealTimers();
  });

  it('100文字以下のタイトルはそのまま返す', async () => {
    const shortTitle = 'バグ修正';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(geminiResponse(shortTitle)),
      }),
    );

    const generator = await createGenerator();
    const title = await generator.generate('session-123', '/work');

    expect(title).toBe(shortTitle);
  });
});
