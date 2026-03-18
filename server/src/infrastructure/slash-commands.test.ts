import { describe, it, expect } from 'vitest';
import { ccCommand } from './slash-commands.js';

describe('ccCommand', () => {
  const json = ccCommand.toJSON();

  it('コマンド名が "cc"', () => {
    expect(json.name).toBe('cc');
  });

  it('サブコマンド "new" が定義されている', () => {
    const sub = json.options?.find((o) => o.name === 'new');
    expect(sub).toBeDefined();
  });

  it('サブコマンド "interrupt" が定義されている', () => {
    const sub = json.options?.find((o) => o.name === 'interrupt');
    expect(sub).toBeDefined();
  });

  it('"new" サブコマンドに model オプションがある（3つの選択肢）', () => {
    const sub = json.options?.find((o) => o.name === 'new') as Record<string, unknown>;
    const options = sub?.options as Array<Record<string, unknown>>;
    const modelOpt = options?.find((o) => o.name === 'model');
    expect(modelOpt).toBeDefined();
    expect(modelOpt?.required).toBe(false);
    const choices = modelOpt?.choices as Array<Record<string, string>>;
    expect(choices?.map((c) => c.value)).toEqual(['sonnet', 'opus', 'haiku']);
  });

  it('"new" サブコマンドに effort オプションがある（3つの選択肢）', () => {
    const sub = json.options?.find((o) => o.name === 'new') as Record<string, unknown>;
    const options = sub?.options as Array<Record<string, unknown>>;
    const effortOpt = options?.find((o) => o.name === 'effort');
    expect(effortOpt).toBeDefined();
    expect(effortOpt?.required).toBe(false);
    const choices = effortOpt?.choices as Array<Record<string, string>>;
    expect(choices?.map((c) => c.value)).toEqual(['medium', 'high', 'max']);
  });
});
