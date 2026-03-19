import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsageFetcher } from './usage-fetcher.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockedReadFile = vi.mocked(fs.readFile);

const VALID_CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-token-123',
    refreshToken: 'refresh-token',
    expiresAt: 9999999999999,
  },
});

const USAGE_API_RESPONSE = {
  five_hour: { utilization: 10.0, resets_at: '2026-03-19T07:00:00Z' },
  seven_day: { utilization: 25.0, resets_at: '2026-03-21T02:00:00Z' },
  seven_day_sonnet: { utilization: 5.0, resets_at: '2026-03-21T02:00:00Z' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_cowork: null,
  extra_usage: { is_enabled: false },
};

describe('UsageFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('credentials を読み込んで usage API を呼び出し、結果を返す', async () => {
    mockedReadFile.mockResolvedValue(VALID_CREDENTIALS);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(USAGE_API_RESPONSE),
      } as Response),
    );

    const fetcher = new UsageFetcher();
    const result = await fetcher.fetch();

    expect(result).toEqual({
      fiveHour: { utilization: 10.0, resetsAt: '2026-03-19T07:00:00Z' },
      sevenDay: { utilization: 25.0, resetsAt: '2026-03-21T02:00:00Z' },
      sevenDaySonnet: { utilization: 5.0, resetsAt: '2026-03-21T02:00:00Z' },
    });

    // Authorization ヘッダーの確認
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token-123',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      }),
    );
  });

  it('null のバケットは null として返される', async () => {
    mockedReadFile.mockResolvedValue(VALID_CREDENTIALS);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            five_hour: { utilization: 6.0, resets_at: '2026-03-19T07:00:00Z' },
            seven_day: null,
            seven_day_sonnet: null,
          }),
      } as Response),
    );

    const fetcher = new UsageFetcher();
    const result = await fetcher.fetch();

    expect(result).toEqual({
      fiveHour: { utilization: 6.0, resetsAt: '2026-03-19T07:00:00Z' },
      sevenDay: null,
      sevenDaySonnet: null,
    });
  });

  it('accessToken フォールバック: creds.accessToken', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ accessToken: 'fallback-token' }));
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ five_hour: null, seven_day: null, seven_day_sonnet: null }),
      } as Response),
    );

    const fetcher = new UsageFetcher();
    await fetcher.fetch();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fallback-token',
        }),
      }),
    );
  });

  it('accessToken フォールバック: creds.access_token', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ access_token: 'snake-case-token' }));
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ five_hour: null, seven_day: null, seven_day_sonnet: null }),
      } as Response),
    );

    const fetcher = new UsageFetcher();
    await fetcher.fetch();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer snake-case-token',
        }),
      }),
    );
  });

  it('credentials にトークンが無い場合はエラーを投げる', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ noToken: true }));

    const fetcher = new UsageFetcher();
    await expect(fetcher.fetch()).rejects.toThrow('Access token not found in credentials');
  });

  it('credentials ファイルが読めない場合はエラーを投げる', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const fetcher = new UsageFetcher();
    await expect(fetcher.fetch()).rejects.toThrow('ENOENT');
  });

  it('API が非 200 を返した場合はエラーを投げる', async () => {
    mockedReadFile.mockResolvedValue(VALID_CREDENTIALS);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
      } as Response),
    );

    const fetcher = new UsageFetcher();
    await expect(fetcher.fetch()).rejects.toThrow('Usage API returned 401');
  });
});
