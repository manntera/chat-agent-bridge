import { SlashCommandBuilder } from 'discord.js';

export const ccCommand = new SlashCommandBuilder()
  .setName('cc')
  .setDescription('Claude Code を操作します')
  .addSubcommand((sub) =>
    sub
      .setName('new')
      .setDescription('新しいセッションを開始します')
      .addStringOption((opt) =>
        opt
          .setName('model')
          .setDescription('使用するモデル')
          .setRequired(false)
          .addChoices(
            { name: 'sonnet', value: 'sonnet' },
            { name: 'opus', value: 'opus' },
            { name: 'haiku', value: 'haiku' },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName('effort')
          .setDescription('思考の深さ')
          .setRequired(false)
          .addChoices(
            { name: 'medium', value: 'medium' },
            { name: 'high', value: 'high' },
            { name: 'max', value: 'max' },
          ),
      ),
  )
  .addSubcommand((sub) => sub.setName('interrupt').setDescription('処理を中断します'));
