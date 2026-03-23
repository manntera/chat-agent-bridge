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

  it('サブコマンド "resume" が定義されている', () => {
    const sub = json.options?.find((o) => o.name === 'resume');
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

  it('サブコマンドグループ "workspace" が定義されている', () => {
    const group = json.options?.find((o) => o.name === 'workspace');
    expect(group).toBeDefined();
  });

  it('"workspace" グループに add, remove, list サブコマンドがある', () => {
    const group = json.options?.find((o) => o.name === 'workspace') as Record<string, unknown>;
    const subs = group?.options as Array<Record<string, unknown>>;
    const names = subs?.map((s) => s.name);
    expect(names).toContain('add');
    expect(names).toContain('remove');
    expect(names).toContain('list');
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
