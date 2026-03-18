import { describe, it, expect } from 'vitest';
import { parseCommand } from './command.js';

describe('parseCommand', () => {
  it('"!new" → NewCommand（オプションなし）', () => {
    expect(parseCommand('!new')).toEqual({ type: 'new', options: {} });
  });

  it('"!interrupt" → InterruptCommand', () => {
    expect(parseCommand('!interrupt')).toEqual({ type: 'interrupt' });
  });

  it('通常テキスト → PromptInput', () => {
    expect(parseCommand('hello')).toEqual({ type: 'prompt', text: 'hello' });
  });

  it('前後の空白を除去して判定する', () => {
    expect(parseCommand('  !new  ')).toEqual({ type: 'new', options: {} });
    expect(parseCommand('  !interrupt  ')).toEqual({ type: 'interrupt' });
    expect(parseCommand('  hello  ')).toEqual({ type: 'prompt', text: 'hello' });
  });

  it('"!interrupt extra" は PromptInput', () => {
    expect(parseCommand('!interrupt extra')).toEqual({ type: 'prompt', text: '!interrupt extra' });
  });

  it('未知の ! コマンドは PromptInput', () => {
    expect(parseCommand('!unknown')).toEqual({ type: 'prompt', text: '!unknown' });
  });

  it('複数行テキストは PromptInput', () => {
    const text = 'line1\nline2\nline3';
    expect(parseCommand(text)).toEqual({ type: 'prompt', text });
  });

  // ----- !new オプション -----

  describe('!new オプション', () => {
    it('effort をショートハンドで指定', () => {
      expect(parseCommand('!new max')).toEqual({ type: 'new', options: { effort: 'max' } });
      expect(parseCommand('!new high')).toEqual({ type: 'new', options: { effort: 'high' } });
      expect(parseCommand('!new medium')).toEqual({ type: 'new', options: { effort: 'medium' } });
    });

    it('--effort フラグで指定', () => {
      expect(parseCommand('!new --effort max')).toEqual({ type: 'new', options: { effort: 'max' } });
    });

    it('--model フラグで指定', () => {
      expect(parseCommand('!new --model sonnet')).toEqual({ type: 'new', options: { model: 'sonnet' } });
    });

    it('model と effort を両方指定', () => {
      expect(parseCommand('!new --model sonnet --effort high')).toEqual({
        type: 'new',
        options: { model: 'sonnet', effort: 'high' },
      });
    });

    it('model と effort ショートハンドを組み合わせ', () => {
      expect(parseCommand('!new --model opus max')).toEqual({
        type: 'new',
        options: { model: 'opus', effort: 'max' },
      });
    });

    it('不正な effort は無視される', () => {
      expect(parseCommand('!new --effort invalid')).toEqual({ type: 'new', options: {} });
    });

    it('不正なショートハンドは無視される', () => {
      expect(parseCommand('!new unknown')).toEqual({ type: 'new', options: {} });
    });
  });
});
