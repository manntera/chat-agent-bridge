import { describe, it, expect, vi } from 'vitest';
import type { SendOptions, ThreadSender } from './discord-notifier.js';
import { createNotifier } from './discord-notifier.js';
import type { UsageInfo } from '../domain/types.js';

// --- モック用ヘルパー ---

interface SentItem {
  type: 'text' | 'embed';
  content: string | SendOptions;
}

function createMockThread() {
  const sent: SentItem[] = [];
  const thread: ThreadSender = {
    send: vi.fn((content: string | SendOptions) => {
      const type = typeof content === 'string' ? 'text' : 'embed';
      sent.push({ type, content });
      return Promise.resolve();
    }),
    setName: vi.fn(() => Promise.resolve()),
  };
  return { thread, sent };
}

const usageWithData: UsageInfo = {
  fiveHour: { utilization: 45, resetsAt: '2026-03-20T07:00:00Z' },
  sevenDay: { utilization: 30, resetsAt: '2026-03-22T02:00:00Z' },
  sevenDaySonnet: null,
};

const usageWithSonnet: UsageInfo = {
  fiveHour: { utilization: 45, resetsAt: '2026-03-20T07:00:00Z' },
  sevenDay: null,
  sevenDaySonnet: { utilization: 80, resetsAt: '2026-03-22T02:00:00Z' },
};

const usageEmpty: UsageInfo = {
  fiveHour: null,
  sevenDay: null,
  sevenDaySonnet: null,
};

// =================================================================
// テスト本体
// =================================================================

describe('createNotifier', () => {
  // ----- progress 通知 -----

  describe('progress 通知', () => {
    it('started イベントをプレーンテキストで送信する', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toBe('📨 受信しました。処理を開始します...');
    });

    it('ツール使用イベントをプレーンテキストで送信する', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'src/index.ts' },
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toContain('Edit');
      expect(sent[0].content).toContain('src/index.ts');
    });

    it('拡張思考イベントをプレーンテキストで送信する', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'thinking', text: 'コードを分析中...' } });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toBe('💭 コードを分析中...');
    });
  });

  // ----- info 通知 -----

  describe('info 通知', () => {
    it('プレーンテキストで送信する', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'info', message: 'セッションを開始しました' });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toBe('セッションを開始しました');
    });
  });

  // ----- result + usage 通知 -----

  describe('result + usage 通知', () => {
    it('result は usage が来るまでバッファされる', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'result', text: 'テストを追加しました' });

      expect(sent).toHaveLength(0); // まだ送信されない
    });

    it('usage 到着時に result を緑色 Embed で送信する', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'result', text: 'テストを追加しました' });
      notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('embed');
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].color).toBe(0x00c853);
      expect(options.embeds[0].description).toBe('テストを追加しました');
    });

    it('usage データがある場合はフッターに含まれる', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(1);
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].footer?.text).toBe('📊 5h 45% | 7d 30%');
    });

    it('Sonnet 利用状況がフッターに含まれる', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageWithSonnet });

      expect(sent).toHaveLength(1);
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].footer?.text).toBe('📊 5h 45% | Sonnet 80%');
    });

    it('usage データがない場合はフッターなし', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageEmpty });

      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].footer).toBeUndefined();
    });

    it('4096 文字超の result（usage データなし）はプレーンテキスト分割 + 空 Embed', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      const longText = 'A'.repeat(5000);
      notify({ type: 'result', text: longText });
      notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(4);
      expect(sent[0].type).toBe('text');
      expect(sent[3].type).toBe('embed');
      const options = sent[3].content as SendOptions;
      expect(options.embeds[0].color).toBe(0x00c853);
      expect(options.embeds[0].footer).toBeUndefined();
    });

    it('4096 文字超の result はプレーンテキスト分割 + フッター Embed', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      const longText = 'A'.repeat(5000);
      notify({ type: 'result', text: longText });
      notify({ type: 'usage', usage: usageWithData });

      // 5000文字 → 2000 + 2000 + 1000 のプレーンテキスト + 1 Embed
      expect(sent).toHaveLength(4);
      expect(sent[0].type).toBe('text');
      expect(sent[1].type).toBe('text');
      expect(sent[2].type).toBe('text');
      expect(sent[3].type).toBe('embed');
      const options = sent[3].content as SendOptions;
      expect(options.embeds[0].color).toBe(0x00c853);
      expect(options.embeds[0].footer?.text).toBe('📊 5h 45% | 7d 30%');
      expect(options.embeds[0].description).toBeUndefined();
    });
  });

  // ----- error + usage 通知 -----

  describe('error + usage 通知', () => {
    it('error は usage が来るまでバッファされる', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'error', message: 'spawn failed', exitCode: 1 });

      expect(sent).toHaveLength(0);
    });

    it('usage 到着時に error を赤色 Embed で送信する', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'error', message: 'spawn failed', exitCode: 1 });
      notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('embed');
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].color).toBe(0xff1744);
      expect(options.embeds[0].title).toBe('エラー (exit 1)');
      expect(options.embeds[0].description).toBe('spawn failed');
    });

    it('error にも usage フッターが付く', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'error', message: 'failed', exitCode: 2 });
      notify({ type: 'usage', usage: usageWithData });

      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].footer?.text).toBe('📊 5h 45% | 7d 30%');
    });
  });

  // ----- usage のみ（result/error なし） -----

  describe('usage のみ', () => {
    it('バッファされた result がない場合、usage データがあれば Embed で送信する', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('embed');
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].footer?.text).toBe('📊 5h 45% | 7d 30%');
    });

    it('バッファされた result がなく usage データもない場合は何も送信しない', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(0);
    });
  });

  // ----- 複合シナリオ -----

  describe('複合シナリオ', () => {
    it('progress → result → usage の完全フロー', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      notify({ type: 'progress', event: { kind: 'tool_use', toolName: 'Edit', target: 'a.ts' } });
      notify({ type: 'result', text: '完了しました' });
      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(3); // 2 progress + 1 embed
      expect(sent[0].type).toBe('text');
      expect(sent[1].type).toBe('text');
      expect(sent[2].type).toBe('embed');
      const options = sent[2].content as SendOptions;
      expect(options.embeds[0].color).toBe(0x00c853);
      expect(options.embeds[0].description).toBe('完了しました');
      expect(options.embeds[0].footer?.text).toBe('📊 5h 45% | 7d 30%');
    });

    it('progress → error → usage の完全フロー', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      notify({ type: 'error', message: 'command failed', exitCode: 1 });
      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(2); // 1 progress + 1 embed
      expect(sent[0].type).toBe('text');
      expect(sent[1].type).toBe('embed');
      const options = sent[1].content as SendOptions;
      expect(options.embeds[0].color).toBe(0xff1744);
    });
  });

  // ----- error + usage フッターなし -----

  describe('error + usage フッターなし', () => {
    it('error 通知で usage データなしの場合もフッターなし', () => {
      const { thread, sent } = createMockThread();
      const notify = createNotifier(thread);

      notify({ type: 'error', message: 'failed', exitCode: 2 });
      notify({ type: 'usage', usage: usageEmpty });

      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].color).toBe(0xff1744);
      expect(options.embeds[0].footer).toBeUndefined();
    });
  });

  // ----- 送信エラー -----

  describe('送信エラー', () => {
    it('テキスト send が失敗してもエラーを投げない', () => {
      const thread: ThreadSender = {
        send: vi.fn(() => Promise.reject(new Error('network error'))),
        setName: vi.fn(() => Promise.resolve()),
      };
      const notify = createNotifier(thread);

      expect(() => notify({ type: 'info', message: 'test' })).not.toThrow();
    });

    it('embed send が失敗してもエラーを投げない', () => {
      const thread: ThreadSender = {
        send: vi.fn(() => Promise.reject(new Error('network error'))),
        setName: vi.fn(() => Promise.resolve()),
      };
      const notify = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      expect(() => notify({ type: 'usage', usage: usageEmpty })).not.toThrow();
    });
  });
});
