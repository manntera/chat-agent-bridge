import {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  type SlashCommandStringOption,
} from 'discord.js';
import type { CommandOptionSpec, CommandSpec, SubcommandSpec } from '../../app/commands.js';

/**
 * app/commands.ts の宣言的スキーマを Discord の SlashCommandBuilder にコンパイルする。
 * コマンドの内容(名前・説明・選択肢)はスキーマ側が単一ソース。
 */

function applyOption(
  opt: SlashCommandStringOption,
  spec: CommandOptionSpec,
): SlashCommandStringOption {
  opt.setName(spec.name).setDescription(spec.description).setRequired(spec.required);
  if (spec.autocomplete) opt.setAutocomplete(true);
  if (spec.choices) {
    opt.addChoices(...spec.choices.map((c) => ({ name: c.name, value: c.value })));
  }
  return opt;
}

function buildSubcommand(
  sub: SlashCommandSubcommandBuilder,
  spec: SubcommandSpec,
): SlashCommandSubcommandBuilder {
  sub.setName(spec.name).setDescription(spec.description);
  for (const option of spec.options ?? []) {
    sub.addStringOption((opt) => applyOption(opt, option));
  }
  return sub;
}

export function buildSlashCommand(spec: CommandSpec): SlashCommandBuilder {
  const builder = new SlashCommandBuilder().setName(spec.name).setDescription(spec.description);

  for (const sub of spec.subcommands) {
    builder.addSubcommand((s) => buildSubcommand(s, sub));
  }

  for (const group of spec.groups) {
    builder.addSubcommandGroup((g) => {
      g.setName(group.name).setDescription(group.description);
      for (const sub of group.subcommands) {
        g.addSubcommand((s) => buildSubcommand(s, sub));
      }
      return g;
    });
  }

  return builder;
}
