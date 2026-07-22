import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from './fetch-with-retry.js';

function makeRetryableError(code: string): TypeError {
  const cause = new Error('connect failed');
  (cause as NodeJS.ErrnoException).code = code;
  const err = new TypeError('fetch failed', { cause });
  return err;
}

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('成功時はそのまま Response を返す', async () => {
    const mockResponse = new Response('ok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const res = await fetchWithRetry('https://example.com');
    expect(res).toBe(mockResponse);

    vi.unstubAllGlobals();
  });

  it('リトライ可能なエラーで最終的に成功する', async () => {
    const mockResponse = new Response('ok');
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(makeRetryableError('EHOSTUNREACH'))
      .mockResolvedValueOnce(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com', undefined, {
      maxRetries: 2,
      baseDelayMs: 100,
    });

    // 1回目失敗後、100ms 待ってリトライ
    await vi.advanceTimersByTimeAsync(100);

    const res = await promise;
    expect(res).toBe(mockResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('リトライ可能なエラーで全リトライ失敗時は throw する', async () => {
    const error = makeRetryableError('ECONNRESET');
    const mockFetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com', undefined, {
      maxRetries: 2,
      baseDelayMs: 100,
    });

    // catch を先に登録して unhandled rejection を防ぐ
    const resultPromise = promise.catch((e) => e);

    // attempt 0 失敗 → 100ms 待ち → attempt 1 失敗 → 200ms 待ち → attempt 2 失敗 → throw
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    const caught = await resultPromise;
    expect(caught).toBe(error);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
  });

  it('リトライ不可能なエラーは即座に throw する', async () => {
    const error = new Error('something else');
    const mockFetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      fetchWithRetry('https://example.com', undefined, { maxRetries: 3, baseDelayMs: 100 }),
    ).rejects.toThrow(error);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('TypeError だが cause に code がない場合はリトライしない', async () => {
    const error = new TypeError('fetch failed');
    const mockFetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      fetchWithRetry('https://example.com', undefined, { maxRetries: 3, baseDelayMs: 100 }),
    ).rejects.toThrow(error);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('TypeError だが cause.code がリトライ対象外の場合はリトライしない', async () => {
    const cause = new Error('unknown');
    (cause as NodeJS.ErrnoException).code = 'ENOENT';
    const error = new TypeError('fetch failed', { cause });
    const mockFetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      fetchWithRetry('https://example.com', undefined, { maxRetries: 3, baseDelayMs: 100 }),
    ).rejects.toThrow(error);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('指数バックオフで待機時間が増加する', async () => {
    const mockResponse = new Response('ok');
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(makeRetryableError('ETIMEDOUT'))
      .mockRejectedValueOnce(makeRetryableError('ETIMEDOUT'))
      .mockResolvedValueOnce(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com', undefined, {
      maxRetries: 3,
      baseDelayMs: 100,
    });

    // attempt 0 失敗 → 100ms
    await vi.advanceTimersByTimeAsync(100);
    // attempt 1 失敗 → 200ms
    await vi.advanceTimersByTimeAsync(200);

    const res = await promise;
    expect(res).toBe(mockResponse);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('各リトライ可能コードでリトライされる', async () => {
    const codes = [
      'EHOSTUNREACH',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
    ];

    for (const code of codes) {
      const mockResponse = new Response('ok');
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(makeRetryableError(code))
        .mockResolvedValueOnce(mockResponse);
      vi.stubGlobal('fetch', mockFetch);

      const promise = fetchWithRetry('https://example.com', undefined, {
        maxRetries: 1,
        baseDelayMs: 10,
      });

      await vi.advanceTimersByTimeAsync(10);

      const res = await promise;
      expect(res).toBe(mockResponse);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    }
  });

  it('init オプションが fetch に渡される', async () => {
    const mockResponse = new Response('ok');
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const init: RequestInit = { method: 'POST', body: 'data' };
    await fetchWithRetry('https://example.com', init);

    expect(mockFetch).toHaveBeenCalledWith('https://example.com', init);

    vi.unstubAllGlobals();
  });

  it('デフォルトオプション（maxRetries=3, baseDelayMs=1000）が使われる', async () => {
    const mockResponse = new Response('ok');
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(makeRetryableError('EHOSTUNREACH'))
      .mockResolvedValueOnce(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const promise = fetchWithRetry('https://example.com');

    // デフォルト baseDelayMs=1000
    await vi.advanceTimersByTimeAsync(1000);

    const res = await promise;
    expect(res).toBe(mockResponse);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt 1/4 failed, retrying in 1000ms'),
    );

    vi.unstubAllGlobals();
  });
});
