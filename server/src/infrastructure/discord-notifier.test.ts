import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    sendTyping: vi.fn(() => Promise.resolve()),
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
    it('started イベントを Embed で送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('embed');
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].description).toBe('📨 受信しました。処理を開始します...');
    });

    it('ツール使用イベントを Embed で送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'src/index.ts' },
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('embed');
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].description).toContain('Edit');
      expect(options.embeds[0].description).toContain('src/index.ts');
    });

    it('拡張思考イベントを Embed で送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'thinking', text: 'コードを分析中...' } });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('embed');
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].description).toBe('💭 コードを分析中...');
    });
  });

  // ----- info 通知 -----

  describe('info 通知', () => {
    it('プレーンテキストで送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

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
      const { notify } = createNotifier(thread);

      notify({ type: 'result', text: 'テストを追加しました' });

      expect(sent).toHaveLength(0); // まだ送信されない
    });

    it('usage 到着時に result をプレーンテキストで送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'result', text: 'テストを追加しました' });
      notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toBe('テストを追加しました');
    });

    it('usage データがある場合はフッターがテキストで送信される', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(2);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toBe('完了');
      expect(sent[1].type).toBe('text');
      expect(sent[1].content).toBe('📊 5h 45% | 7d 30%');
    });

    it('Sonnet 利用状況がフッターがテキストで送信される', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageWithSonnet });

      expect(sent).toHaveLength(2);
      expect(sent[0].type).toBe('text');
      expect(sent[1].type).toBe('text');
      expect(sent[1].content).toBe('📊 5h 45% | Sonnet 80%');
    });

    it('usage データがない場合はフッターなし', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toBe('完了');
    });

    it('長文 result はプレーンテキスト分割で送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      const longText = 'A'.repeat(5000);
      notify({ type: 'result', text: longText });
      notify({ type: 'usage', usage: usageEmpty });

      // 5000文字 → 2000 + 2000 + 1000 のプレーンテキスト
      expect(sent).toHaveLength(3);
      expect(sent[0].type).toBe('text');
      expect(sent[1].type).toBe('text');
      expect(sent[2].type).toBe('text');
    });

    it('長文 result はプレーンテキスト分割 + フッターテキストで送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      const longText = 'A'.repeat(5000);
      notify({ type: 'result', text: longText });
      notify({ type: 'usage', usage: usageWithData });

      // 5000文字 → 2000 + 2000 + 1000 のプレーンテキスト + 1 フッターテキスト
      expect(sent).toHaveLength(4);
      expect(sent[0].type).toBe('text');
      expect(sent[1].type).toBe('text');
      expect(sent[2].type).toBe('text');
      expect(sent[3].type).toBe('text');
      expect(sent[3].content).toBe('📊 5h 45% | 7d 30%');
    });
  });

  // ----- error + usage 通知 -----

  describe('error + usage 通知', () => {
    it('error は usage が来るまでバッファされる', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'error', message: 'spawn failed', exitCode: 1 });

      expect(sent).toHaveLength(0);
    });

    it('usage 到着時に error を赤色 Embed で送信する', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

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
      const { notify } = createNotifier(thread);

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
      const { notify } = createNotifier(thread);

      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('embed');
      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].footer?.text).toBe('📊 5h 45% | 7d 30%');
    });

    it('バッファされた result がなく usage データもない場合は何も送信しない', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(0);
    });
  });

  // ----- 複合シナリオ -----

  describe('複合シナリオ', () => {
    it('progress → result → usage の完全フロー', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      notify({ type: 'progress', event: { kind: 'tool_use', toolName: 'Edit', target: 'a.ts' } });
      notify({ type: 'result', text: '完了しました' });
      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(4); // 2 progress embed + 1 result text + 1 footer text
      expect(sent[0].type).toBe('embed');
      expect(sent[1].type).toBe('embed');
      expect(sent[2].type).toBe('text');
      expect(sent[2].content).toBe('完了しました');
      expect(sent[3].type).toBe('text');
      expect(sent[3].content).toBe('📊 5h 45% | 7d 30%');
    });

    it('progress → error → usage の完全フロー', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      notify({ type: 'error', message: 'command failed', exitCode: 1 });
      notify({ type: 'usage', usage: usageWithData });

      expect(sent).toHaveLength(2); // 1 progress embed + 1 error embed
      expect(sent[0].type).toBe('embed');
      expect(sent[1].type).toBe('embed');
      const options = sent[1].content as SendOptions;
      expect(options.embeds[0].color).toBe(0xff1744);
    });
  });

  // ----- error + usage フッターなし -----

  describe('error + usage フッターなし', () => {
    it('error 通知で usage データなしの場合もフッターなし', () => {
      const { thread, sent } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'error', message: 'failed', exitCode: 2 });
      notify({ type: 'usage', usage: usageEmpty });

      const options = sent[0].content as SendOptions;
      expect(options.embeds[0].color).toBe(0xff1744);
      expect(options.embeds[0].footer).toBeUndefined();
    });
  });

  // ----- メンション -----

  describe('メンション', () => {
    it('progress (started / tool_use / thinking) にはメンションが付かない', () => {
      const { thread, sent } = createMockThread();
      const notifier = createNotifier(thread);
      notifier.setAuthorId('user123');

      notifier.notify({ type: 'progress', event: { kind: 'started' } });
      notifier.notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'a.ts' },
      });
      notifier.notify({ type: 'progress', event: { kind: 'thinking', text: '考え中' } });

      for (const item of sent) {
        const options = item.content as SendOptions;
        expect(options.content).toBeUndefined();
      }
    });

    it('result のテキスト送信時にメンションが付く', () => {
      const { thread, sent } = createMockThread();
      const notifier = createNotifier(thread);
      notifier.setAuthorId('user456');

      notifier.notify({ type: 'result', text: '完了' });
      notifier.notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect(sent[0].content).toBe('<@user456> 完了');
    });

    it('error の Embed 送信時に content でメンションが付く', () => {
      const { thread, sent } = createMockThread();
      const notifier = createNotifier(thread);
      notifier.setAuthorId('user789');

      notifier.notify({ type: 'error', message: 'failed', exitCode: 1 });
      notifier.notify({ type: 'usage', usage: usageEmpty });

      const options = sent[0].content as SendOptions;
      expect(options.content).toBe('<@user789>');
    });

    it('長文分割時は最初のメッセージにのみメンションが付く', () => {
      const { thread, sent } = createMockThread();
      const notifier = createNotifier(thread);
      notifier.setAuthorId('user123');

      const longText = 'A'.repeat(5000);
      notifier.notify({ type: 'result', text: longText });
      notifier.notify({ type: 'usage', usage: usageEmpty });

      // 最初のチャンクにメンション付き
      expect(sent[0].type).toBe('text');
      expect((sent[0].content as string).startsWith('<@user123> ')).toBe(true);
      // 2番目以降にはメンションなし
      expect((sent[1].content as string).startsWith('<@')).toBe(false);
    });

    it('メンション付きでも各メッセージが2000文字以内に収まる', () => {
      const { thread, sent } = createMockThread();
      const notifier = createNotifier(thread);
      notifier.setAuthorId('user123');

      // ちょうど2000文字のテキスト — メンション分を考慮して分割されるはず
      const longText = 'B'.repeat(2000);
      notifier.notify({ type: 'result', text: longText });
      notifier.notify({ type: 'usage', usage: usageEmpty });

      // メンションプレフィックス "<@user123> " = 12文字
      // 最初のチャンクは 2000-12=1988 文字 + メンション12文字 = 2000文字
      // 残りは 2000-1988=12 文字
      expect(sent).toHaveLength(2);
      expect(sent[0].type).toBe('text');
      expect((sent[0].content as string).length).toBeLessThanOrEqual(2000);
      expect((sent[0].content as string).startsWith('<@user123> ')).toBe(true);
      expect(sent[1].type).toBe('text');
      expect((sent[1].content as string).length).toBeLessThanOrEqual(2000);
    });

    it('メンションなしで2000文字ちょうどのテキストは分割されない', () => {
      const { thread, sent } = createMockThread();
      const notifier = createNotifier(thread);
      // authorId を設定しない — メンションなし

      const longText = 'C'.repeat(2000);
      notifier.notify({ type: 'result', text: longText });
      notifier.notify({ type: 'usage', usage: usageEmpty });

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('text');
      expect((sent[0].content as string).length).toBe(2000);
    });

    it('info にはメンションが付かない', () => {
      const { thread, sent } = createMockThread();
      const notifier = createNotifier(thread);
      notifier.setAuthorId('user123');

      notifier.notify({ type: 'info', message: 'セッション開始' });

      expect(sent[0].content).toBe('セッション開始');
    });
  });

  // ----- Typing Indicator -----

  describe('Typing Indicator', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('progress started で sendTyping が呼ばれる', () => {
      const { thread } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });

      expect(thread.sendTyping).toHaveBeenCalledTimes(2); // startTyping + sendEmbed 後の再送
    });

    it('8秒間隔で sendTyping が再送される', () => {
      const { thread } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      expect(thread.sendTyping).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(8000);
      expect(thread.sendTyping).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(8000);
      expect(thread.sendTyping).toHaveBeenCalledTimes(4);
    });

    it('sendEmbed 後に sendTyping が再送される', () => {
      const { thread } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      const countAfterStarted = vi.mocked(thread.sendTyping).mock.calls.length;

      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'a.ts' },
      });

      expect(thread.sendTyping).toHaveBeenCalledTimes(countAfterStarted + 1);
    });

    it('sendText 後に sendTyping が再送される', () => {
      const { thread } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      const countAfterStarted = vi.mocked(thread.sendTyping).mock.calls.length;

      notify({ type: 'info', message: 'テスト' });

      expect(thread.sendTyping).toHaveBeenCalledTimes(countAfterStarted + 1);
    });

    it('usage 通知で typing が停止する', () => {
      const { thread } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageEmpty });

      const countAfterUsage = vi.mocked(thread.sendTyping).mock.calls.length;

      vi.advanceTimersByTime(16000);
      expect(thread.sendTyping).toHaveBeenCalledTimes(countAfterUsage);
    });

    it('usage 後の flush 内メッセージ送信では sendTyping が再送されない', () => {
      const { thread } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      const countBeforeUsage = vi.mocked(thread.sendTyping).mock.calls.length;

      notify({ type: 'result', text: '完了' });
      notify({ type: 'usage', usage: usageEmpty });

      // stopTyping が先に呼ばれるため、flush 内の sendText では sendTyping されない
      expect(thread.sendTyping).toHaveBeenCalledTimes(countBeforeUsage);
    });

    it('startTyping は二重に呼ばれない', () => {
      const { thread } = createMockThread();
      const { notify } = createNotifier(thread);

      notify({ type: 'progress', event: { kind: 'started' } });
      const countAfterFirst = vi.mocked(thread.sendTyping).mock.calls.length;

      // 2回目の started は startTyping を再度呼ばない（isTyping ガード）
      // ただし sendEmbed 後の再送は発生する
      notify({ type: 'progress', event: { kind: 'started' } });
      expect(thread.sendTyping).toHaveBeenCalledTimes(countAfterFirst + 1); // sendEmbed 後の再送のみ
    });

    it('dispose() で typing が停止しインターバルがクリアされる', () => {
      const { thread } = createMockThread();
      const notifier = createNotifier(thread);

      notifier.notify({ type: 'progress', event: { kind: 'started' } });
      const countAfterStart = vi.mocked(thread.sendTyping).mock.calls.length;

      notifier.dispose();

      vi.advanceTimersByTime(16000);
      expect(thread.sendTyping).toHaveBeenCalledTimes(countAfterStart);
    });

    it('dispose() は複数回呼んでも安全', () => {
      const { thread } = createMockThread();
      const notifier = createNotifier(thread);

      notifier.notify({ type: 'progress', event: { kind: 'started' } });
      notifier.dispose();
      expect(() => notifier.dispose()).not.toThrow();
    });

    it('sendTyping のエラーは握りつぶされる', () => {
      const thread: ThreadSender = {
        send: vi.fn(() => Promise.resolve()),
        sendTyping: vi.fn(() => Promise.reject(new Error('typing error'))),
        setName: vi.fn(() => Promise.resolve()),
      };
      const { notify } = createNotifier(thread);

      expect(() => notify({ type: 'progress', event: { kind: 'started' } })).not.toThrow();
    });
  });

  // ----- 送信エラー -----

  describe('送信エラー', () => {
    it('テキスト send が失敗してもエラーを投げない', () => {
      const thread: ThreadSender = {
        send: vi.fn(() => Promise.reject(new Error('network error'))),
        sendTyping: vi.fn(() => Promise.resolve()),
        setName: vi.fn(() => Promise.resolve()),
      };
      const { notify } = createNotifier(thread);

      expect(() => notify({ type: 'info', message: 'test' })).not.toThrow();
    });

    it('embed send が失敗してもエラーを投げない', () => {
      const thread: ThreadSender = {
        send: vi.fn(() => Promise.reject(new Error('network error'))),
        sendTyping: vi.fn(() => Promise.resolve()),
        setName: vi.fn(() => Promise.resolve()),
      };
      const { notify } = createNotifier(thread);

      notify({ type: 'result', text: '完了' });
      expect(() => notify({ type: 'usage', usage: usageEmpty })).not.toThrow();
    });

    it('progress の embed send が失敗してもエラーを投げない', () => {
      const thread: ThreadSender = {
        send: vi.fn(() => Promise.reject(new Error('network error'))),
        sendTyping: vi.fn(() => Promise.resolve()),
        setName: vi.fn(() => Promise.resolve()),
      };
      const { notify } = createNotifier(thread);

      expect(() => notify({ type: 'progress', event: { kind: 'started' } })).not.toThrow();
    });
  });
});
