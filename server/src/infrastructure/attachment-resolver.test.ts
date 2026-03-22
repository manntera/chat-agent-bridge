import { describe, it, expect, vi } from 'vitest';
import { resolvePrompt, type Attachment, type FetchFn } from './attachment-resolver.js';

// --- ヘルパー ---

function textAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    contentType: 'text/plain; charset=utf-8',
    name: 'message.txt',
    size: 100,
    url: 'https://cdn.discord.com/attachments/123/message.txt',
    ...overrides,
  };
}

function imageAttachment(): Attachment {
  return {
    contentType: 'image/png',
    name: 'screenshot.png',
    size: 50_000,
    url: 'https://cdn.discord.com/attachments/123/screenshot.png',
  };
}

const mockFetch: FetchFn = vi.fn(() => Promise.resolve('添付テキストの内容'));

// =================================================================
// テスト本体
// =================================================================

describe('resolvePrompt', () => {
  // ----- 添付なし -----

  describe('添付なし', () => {
    it('content あり → content をそのまま返す', async () => {
      const result = await resolvePrompt('hello', [], mockFetch);

      expect(result).toEqual({ prompt: 'hello', error: null });
    });

    it('content 空 → null を返す', async () => {
      const result = await resolvePrompt('', [], mockFetch);

      expect(result).toEqual({ prompt: null, error: null });
    });
  });

  // ----- テキスト添付あり -----

  describe('テキスト添付あり', () => {
    it('content 空 + テキスト添付 → 添付テキストを返す', async () => {
      const fetch = vi.fn(() => Promise.resolve('長いプロンプト'));
      const result = await resolvePrompt('', [textAttachment()], fetch);

      expect(result).toEqual({ prompt: '長いプロンプト', error: null });
      expect(fetch).toHaveBeenCalledWith('https://cdn.discord.com/attachments/123/message.txt');
    });

    it('content あり + テキスト添付 → 結合して返す', async () => {
      const fetch = vi.fn(() => Promise.resolve('添付の内容'));
      const result = await resolvePrompt('指示テキスト', [textAttachment()], fetch);

      expect(result).toEqual({
        prompt: '指示テキスト\n\n添付の内容',
        error: null,
      });
    });
  });

  // ----- contentType / ファイル名判定 -----

  describe('テキスト判定', () => {
    it('contentType が text/plain で判定される', async () => {
      const fetch = vi.fn(() => Promise.resolve('text'));
      const result = await resolvePrompt(
        '',
        [textAttachment({ contentType: 'text/plain' })],
        fetch,
      );

      expect(result.prompt).toBe('text');
    });

    it('contentType が text/markdown で判定される', async () => {
      const fetch = vi.fn(() => Promise.resolve('# markdown'));
      const result = await resolvePrompt(
        '',
        [textAttachment({ contentType: 'text/markdown', name: 'doc.md' })],
        fetch,
      );

      expect(result.prompt).toBe('# markdown');
    });

    it('.txt ファイル名で判定される（contentType なし）', async () => {
      const fetch = vi.fn(() => Promise.resolve('text'));
      const result = await resolvePrompt(
        '',
        [textAttachment({ contentType: null, name: 'message.txt' })],
        fetch,
      );

      expect(result.prompt).toBe('text');
    });

    it('非テキスト添付は無視される', async () => {
      const result = await resolvePrompt('hello', [imageAttachment()], mockFetch);

      expect(result).toEqual({ prompt: 'hello', error: null });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ----- サイズ制限 -----

  describe('サイズ制限', () => {
    it('100KB 超の添付 → エラーメッセージを返す', async () => {
      const largeAttachment = textAttachment({ size: 200 * 1024 });
      const result = await resolvePrompt('', [largeAttachment], mockFetch);

      expect(result.prompt).toBeNull();
      expect(result.error).toContain('大きすぎます');
      expect(result.error).toContain('200KB');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('100KB 超でも content があればそれを返す', async () => {
      const largeAttachment = textAttachment({ size: 200 * 1024 });
      const result = await resolvePrompt('指示テキスト', [largeAttachment], mockFetch);

      expect(result.prompt).toBe('指示テキスト');
      expect(result.error).toContain('大きすぎます');
    });
  });

  // ----- 複数添付 -----

  describe('複数添付', () => {
    it('最初のテキスト添付のみ使用する', async () => {
      const fetch = vi.fn(() => Promise.resolve('最初のファイル'));
      const result = await resolvePrompt(
        '',
        [
          textAttachment({ url: 'https://example.com/first.txt' }),
          textAttachment({ url: 'https://example.com/second.txt' }),
        ],
        fetch,
      );

      expect(result.prompt).toBe('最初のファイル');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('https://example.com/first.txt');
    });

    it('非テキスト添付を飛ばしてテキスト添付を見つける', async () => {
      const fetch = vi.fn(() => Promise.resolve('テキスト'));
      const result = await resolvePrompt('', [imageAttachment(), textAttachment()], fetch);

      expect(result.prompt).toBe('テキスト');
    });
  });

  // ----- デフォルト fetch を使用 -----

  describe('デフォルト fetch', () => {
    it('fetchFn 未指定時はグローバル fetch を使用する', async () => {
      const mockGlobalFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('ダウンロード結果'),
      });
      vi.stubGlobal('fetch', mockGlobalFetch);

      const result = await resolvePrompt('指示', [textAttachment()]);

      expect(result.prompt).toBe('指示\n\nダウンロード結果');
      expect(mockGlobalFetch).toHaveBeenCalledWith(
        'https://cdn.discord.com/attachments/123/message.txt',
      );

      vi.unstubAllGlobals();
    });

    it('デフォルト fetch が HTTP エラーの場合は content のみ', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      const result = await resolvePrompt('指示', [textAttachment()]);

      expect(result.prompt).toBe('指示');
      expect(result.error).toBeNull();

      vi.unstubAllGlobals();
    });
  });

  // ----- ダウンロード失敗 -----

  describe('ダウンロード失敗', () => {
    it('fetch 失敗時は content のみで処理を継続する', async () => {
      const failFetch = vi.fn(() => Promise.reject(new Error('network error')));
      const result = await resolvePrompt('指示テキスト', [textAttachment()], failFetch);

      expect(result).toEqual({ prompt: '指示テキスト', error: null });
    });

    it('fetch 失敗 + content 空 → null を返す', async () => {
      const failFetch = vi.fn(() => Promise.reject(new Error('network error')));
      const result = await resolvePrompt('', [textAttachment()], failFetch);

      expect(result).toEqual({ prompt: null, error: null });
    });
  });
});
