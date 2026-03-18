import { describe, it, expect, vi } from 'vitest';
import type { ChannelSender, Threadable, ThreadSender } from './discord-notifier.js';
import { createNotifier } from './discord-notifier.js';

// --- モック用ヘルパー ---

function createMockThread() {
  const messages: string[] = [];
  const thread: ThreadSender = {
    send: vi.fn((content: string) => {
      messages.push(content);
      return Promise.resolve();
    }),
  };
  return { thread, messages };
}

function createMockChannel() {
  const channelMessages: string[] = [];
  const channel: ChannelSender = {
    send: vi.fn((content: string) => {
      channelMessages.push(content);
      return Promise.resolve();
    }),
  };
  return { channel, channelMessages };
}

function createMockOrigin(thread: ThreadSender): Threadable {
  return {
    startThread: vi.fn(() => Promise.resolve(thread)),
  };
}

// =================================================================
// テスト本体
// =================================================================

describe('createNotifier', () => {
  // ----- info 通知 -----

  describe('info 通知', () => {
    it('メインチャンネルにメッセージを送信する', () => {
      const { channel, channelMessages } = createMockChannel();
      const notify = createNotifier(channel);

      notify({ type: 'info', message: '処理中です' });

      expect(channelMessages).toEqual(['処理中です']);
    });
  });

  // ----- result 通知 -----

  describe('result 通知', () => {
    it('メインチャンネルにテキストを送信する', () => {
      const { channel, channelMessages } = createMockChannel();
      const notify = createNotifier(channel);

      notify({ type: 'result', text: 'ClaudeCode の応答' });

      expect(channelMessages).toEqual(['ClaudeCode の応答']);
    });

    it('2000文字を超えるテキストは分割して送信する', () => {
      const { channel, channelMessages } = createMockChannel();
      const notify = createNotifier(channel);

      const longText = 'A'.repeat(4500);
      notify({ type: 'result', text: longText });

      expect(channelMessages).toHaveLength(3);
      expect(channelMessages[0]).toHaveLength(2000);
      expect(channelMessages[1]).toHaveLength(2000);
      expect(channelMessages[2]).toHaveLength(500);
      expect(channelMessages.join('')).toBe(longText);
    });

    it('ちょうど2000文字のテキストは分割されない', () => {
      const { channel, channelMessages } = createMockChannel();
      const notify = createNotifier(channel);

      const exactText = 'B'.repeat(2000);
      notify({ type: 'result', text: exactText });

      expect(channelMessages).toHaveLength(1);
      expect(channelMessages[0]).toBe(exactText);
    });

    it('空文字列の result はそのまま送信する', () => {
      const { channel, channelMessages } = createMockChannel();
      const notify = createNotifier(channel);

      notify({ type: 'result', text: '' });

      expect(channelMessages).toEqual(['']);
    });
  });

  // ----- error 通知 -----

  describe('error 通知', () => {
    it('メインチャンネルにエラー接頭辞付きで送信する', () => {
      const { channel, channelMessages } = createMockChannel();
      const notify = createNotifier(channel);

      notify({ type: 'error', message: 'spawn failed', exitCode: 1 });

      expect(channelMessages).toHaveLength(1);
      expect(channelMessages[0]).toContain('エラー');
      expect(channelMessages[0]).toContain('exit 1');
      expect(channelMessages[0]).toContain('spawn failed');
    });
  });

  // ----- progress 通知（スレッド） -----

  describe('progress 通知', () => {
    it('ツール使用イベントをスレッドに送信する', async () => {
      const { channel } = createMockChannel();
      const { thread, messages: threadMessages } = createMockThread();
      const notify = createNotifier(channel);

      notify.setThreadOrigin(createMockOrigin(thread));
      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'src/index.ts' },
      });

      await vi.waitFor(() => {
        expect(threadMessages).toHaveLength(1);
      });
      expect(threadMessages[0]).toContain('Edit');
      expect(threadMessages[0]).toContain('src/index.ts');
    });

    it('拡張思考イベントをスレッドに送信する', async () => {
      const { channel } = createMockChannel();
      const { thread, messages: threadMessages } = createMockThread();
      const notify = createNotifier(channel);

      notify.setThreadOrigin(createMockOrigin(thread));
      notify({
        type: 'progress',
        event: { kind: 'thinking', text: 'コードの構造を分析中...' },
      });

      await vi.waitFor(() => {
        expect(threadMessages).toHaveLength(1);
      });
      expect(threadMessages[0]).toContain('コードの構造を分析中...');
    });

    it('ユーザーのメッセージからスレッドが作成される', async () => {
      const { channel } = createMockChannel();
      const { thread, messages: threadMessages } = createMockThread();
      const origin = createMockOrigin(thread);
      const notify = createNotifier(channel);

      notify.setThreadOrigin(origin);
      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Read', target: 'file.ts' },
      });

      await vi.waitFor(() => {
        expect(threadMessages).toHaveLength(1);
      });
      expect(origin.startThread).toHaveBeenCalledWith({ name: '途中経過' });
    });

    it('複数の progress イベントで同一スレッドを再利用する', async () => {
      const { channel } = createMockChannel();
      const { thread, messages: threadMessages } = createMockThread();
      const origin = createMockOrigin(thread);
      const notify = createNotifier(channel);

      notify.setThreadOrigin(origin);
      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Read', target: 'a.ts' },
      });
      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'b.ts' },
      });

      await vi.waitFor(() => {
        expect(threadMessages).toHaveLength(2);
      });
      expect(origin.startThread).toHaveBeenCalledTimes(1);
    });

    it('result 後の progress では新しいスレッドを作成する', async () => {
      const { channel } = createMockChannel();
      const { thread: thread1, messages: threadMessages1 } = createMockThread();
      const { thread: thread2, messages: threadMessages2 } = createMockThread();
      const notify = createNotifier(channel);

      // 1回目のタスク
      notify.setThreadOrigin(createMockOrigin(thread1));
      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Read', target: 'a.ts' },
      });
      await vi.waitFor(() => {
        expect(threadMessages1).toHaveLength(1);
      });

      // result でスレッドリセット
      notify({ type: 'result', text: '完了' });

      // 2回目のタスク
      notify.setThreadOrigin(createMockOrigin(thread2));
      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'b.ts' },
      });
      await vi.waitFor(() => {
        expect(threadMessages2).toHaveLength(1);
      });
    });
  });

  // ----- 送信エラーのハンドリング -----

  describe('送信エラー', () => {
    it('send が失敗してもエラーを投げない（fire-and-forget）', () => {
      const channel: ChannelSender = {
        send: vi.fn(() => Promise.reject(new Error('network error'))),
      };
      const notify = createNotifier(channel);

      expect(() => notify({ type: 'info', message: 'test' })).not.toThrow();
    });
  });
});
