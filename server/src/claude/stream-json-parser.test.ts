import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine } from './stream-json-parser.js';

/** 実際の Claude CLI stream-json フォーマットに合わせたヘルパー */
function assistantEvent(content: unknown[]) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content,
    },
  });
}

describe('parseStreamJsonLine', () => {
  // ----- ツール使用イベント -----

  describe('ツール使用イベント', () => {
    it('Edit ツール → file_path を target として抽出', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'src/index.ts' } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'src/index.ts' },
      });
    });

    it('Read ツール → file_path を target として抽出', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/utils.ts' } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Read', target: 'src/utils.ts' },
      });
    });

    it('Write ツール → file_path を target として抽出', () => {
      const line = assistantEvent([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Write',
          input: { file_path: 'src/new-file.ts' },
        },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Write', target: 'src/new-file.ts' },
      });
    });

    it('Bash ツール → command を target として抽出', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Bash', target: 'npm test' },
      });
    });

    it('Bash ツール → 100文字を超える command は切り詰め', () => {
      const longCommand = 'a'.repeat(150);
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: longCommand } },
      ]);

      const result = parseStreamJsonLine(line);
      expect(result.kind).toBe('progress');
      if (result.kind === 'progress') {
        expect(result.event.kind).toBe('tool_use');
        if (result.event.kind === 'tool_use') {
          expect(result.event.target).toHaveLength(100);
          expect(result.event.target).toBe('a'.repeat(100));
        }
      }
    });

    it('Glob ツール → pattern を target として抽出', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Glob', input: { pattern: '**/*.ts' } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Glob', target: '**/*.ts' },
      });
    });

    it('Grep ツール → pattern を target として抽出', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'TODO' } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Grep', target: 'TODO' },
      });
    });

    it('Bash ツール → command が文字列でない場合はツール名を target にする', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 123 } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Bash', target: 'Bash' },
      });
    });

    it('Edit ツール → file_path が文字列でない場合はツール名を target にする', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 123 } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Edit', target: 'Edit' },
      });
    });

    it('Glob ツール → pattern が文字列でない場合はツール名を target にする', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Glob', input: { pattern: null } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Glob', target: 'Glob' },
      });
    });

    it('未知のツール → ツール名をそのまま target にする', () => {
      const line = assistantEvent([
        { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { some_field: 'value' } },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'Agent', target: 'Agent' },
      });
    });
  });

  // ----- 拡張思考イベント -----

  describe('拡張思考イベント', () => {
    it('thinking イベント → 思考テキストを抽出', () => {
      const line = assistantEvent([
        { type: 'thinking', thinking: '分析中...', signature: 'sig_test' },
      ]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'thinking', text: '分析中...' },
      });
    });

    it('message.content が空 → ignored', () => {
      const line = assistantEvent([]);

      expect(parseStreamJsonLine(line)).toEqual({ kind: 'ignored' });
    });
  });

  // ----- 最終結果イベント -----

  describe('最終結果イベント', () => {
    it('result イベント → 結果テキストを抽出', () => {
      const line = JSON.stringify({
        type: 'result',
        result: '回答テキスト',
        session_id: 'abc-123',
        is_error: false,
      });

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'result',
        text: '回答テキスト',
      });
    });

    it('result が非文字列 → 空文字列の result', () => {
      const line = JSON.stringify({
        type: 'result',
        result: { complex: 'object' },
      });

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'result',
        text: '',
      });
    });

    it('result が空文字列 → 空文字列の result', () => {
      const line = JSON.stringify({
        type: 'result',
        result: '',
      });

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'result',
        text: '',
      });
    });
  });

  // ----- 無視すべきイベント -----

  describe('無視すべきイベント', () => {
    it('system イベント → ignored', () => {
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123',
        tools: ['Edit', 'Read'],
      });

      expect(parseStreamJsonLine(line)).toEqual({ kind: 'ignored' });
    });

    it('不正な JSON → ignored', () => {
      expect(parseStreamJsonLine('not a json')).toEqual({ kind: 'ignored' });
    });

    it('空文字列 → ignored', () => {
      expect(parseStreamJsonLine('')).toEqual({ kind: 'ignored' });
    });

    it('未知の type → ignored', () => {
      const line = JSON.stringify({ type: 'unknown', data: 'something' });
      expect(parseStreamJsonLine(line)).toEqual({ kind: 'ignored' });
    });

    it('assistant だが message がない → ignored', () => {
      const line = JSON.stringify({ type: 'assistant' });
      expect(parseStreamJsonLine(line)).toEqual({ kind: 'ignored' });
    });

    it('assistant の message.content が undefined → ignored', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: { model: 'test', id: 'msg', type: 'message', role: 'assistant' },
      });
      expect(parseStreamJsonLine(line)).toEqual({ kind: 'ignored' });
    });

    it('tool_use の input がない場合はツール名を target にする', () => {
      const line = assistantEvent([{ type: 'tool_use', id: 'toolu_1', name: 'CustomTool' }]);

      expect(parseStreamJsonLine(line)).toEqual({
        kind: 'progress',
        event: { kind: 'tool_use', toolName: 'CustomTool', target: 'CustomTool' },
      });
    });

    it('assistant だが text 型 → ignored', () => {
      const line = assistantEvent([{ type: 'text', text: 'hello' }]);

      expect(parseStreamJsonLine(line)).toEqual({ kind: 'ignored' });
    });
  });
});
