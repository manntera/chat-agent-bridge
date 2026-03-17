import { describe, it, expect } from 'vitest';
import { parseCommand } from './command.js';

describe('parseCommand', () => {
  it('"!new" → NewCommand', () => {
    expect(parseCommand('!new')).toEqual({ type: 'new' });
  });

  it('"!interrupt" → InterruptCommand', () => {
    expect(parseCommand('!interrupt')).toEqual({ type: 'interrupt' });
  });

  it('通常テキスト → PromptInput', () => {
    expect(parseCommand('hello')).toEqual({ type: 'prompt', text: 'hello' });
  });

  it('前後の空白を除去して判定する', () => {
    expect(parseCommand('  !new  ')).toEqual({ type: 'new' });
    expect(parseCommand('  !interrupt  ')).toEqual({ type: 'interrupt' });
    expect(parseCommand('  hello  ')).toEqual({ type: 'prompt', text: 'hello' });
  });

  it('"!new extra" は PromptInput（完全一致のみコマンド）', () => {
    expect(parseCommand('!new extra')).toEqual({ type: 'prompt', text: '!new extra' });
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
});
