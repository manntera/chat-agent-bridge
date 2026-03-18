import { describe, it, expect, vi } from 'vitest';
import type { MessageSender } from './discord-notifier.js';
import { createNotifier } from './discord-notifier.js';

// --- モック用ヘルパー ---

function createMockSender() {
  const sentMessages: string[] = [];
  const sender: MessageSender = {
    send: vi.fn((content: string) => {
      sentMessages.push(content);
      return Promise.resolve();
    }),
  };
  return { sender, sentMessages };
}

// =================================================================
// テスト本体
// =================================================================

describe('createNotifier', () => {
  // ----- info 通知 -----

  describe('info 通知', () => {
    it('メッセージをそのまま送信する', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      notify({ type: 'info', message: '処理中です' });

      expect(sentMessages).toEqual(['処理中です']);
    });
  });

  // ----- result 通知 -----

  describe('result 通知', () => {
    it('テキストをそのまま送信する', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      notify({ type: 'result', text: 'ClaudeCode の応答' });

      expect(sentMessages).toEqual(['ClaudeCode の応答']);
    });

    it('2000文字を超えるテキストは分割して送信する', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      const longText = 'A'.repeat(4500);
      notify({ type: 'result', text: longText });

      expect(sentMessages).toHaveLength(3);
      expect(sentMessages[0]).toHaveLength(2000);
      expect(sentMessages[1]).toHaveLength(2000);
      expect(sentMessages[2]).toHaveLength(500);
      expect(sentMessages.join('')).toBe(longText);
    });

    it('ちょうど2000文字のテキストは分割されない', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      const exactText = 'B'.repeat(2000);
      notify({ type: 'result', text: exactText });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toBe(exactText);
    });

    it('空文字列の result はそのまま送信する', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      notify({ type: 'result', text: '' });

      expect(sentMessages).toEqual(['']);
    });
  });

  // ----- error 通知 -----

  describe('error 通知', () => {
    it('エラー接頭辞付きで送信する', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      notify({ type: 'error', message: 'spawn failed', exitCode: 1 });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('エラー');
      expect(sentMessages[0]).toContain('exit 1');
      expect(sentMessages[0]).toContain('spawn failed');
    });
  });

  // ----- progress 通知（ツール使用） -----

  describe('progress 通知（ツール使用）', () => {
    it('ツール名と対象を送信する', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      notify({
        type: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'src/index.ts' },
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Edit');
      expect(sentMessages[0]).toContain('src/index.ts');
    });
  });

  // ----- progress 通知（拡張思考） -----

  describe('progress 通知（拡張思考）', () => {
    it('思考テキストを送信する', () => {
      const { sender, sentMessages } = createMockSender();
      const notify = createNotifier(sender);

      notify({
        type: 'progress',
        event: { kind: 'thinking', text: 'コードの構造を分析中...' },
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('コードの構造を分析中...');
    });
  });

  // ----- 送信エラーのハンドリング -----

  describe('送信エラー', () => {
    it('send が失敗してもエラーを投げない（fire-and-forget）', () => {
      const sender: MessageSender = {
        send: vi.fn(() => Promise.reject(new Error('network error'))),
      };
      const notify = createNotifier(sender);

      // エラーが throw されないことを確認
      expect(() => notify({ type: 'info', message: 'test' })).not.toThrow();
    });
  });
});
