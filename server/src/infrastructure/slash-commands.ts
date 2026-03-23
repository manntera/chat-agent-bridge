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
  .addSubcommand((sub) => sub.setName('interrupt').setDescription('処理を中断します'))
  .addSubcommand((sub) => sub.setName('resume').setDescription('過去のセッションを再開します'))
  .addSubcommand((sub) =>
    sub
      .setName('report')
      .setDescription('日報を生成します')
      .addStringOption((opt) =>
        opt
          .setName('date')
          .setDescription('対象日（YYYY-MM-DD、-1=昨日 等。省略時: 今日）')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('workspace')
      .setDescription('ワークスペースを管理します')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('ワークスペースを登録します（省略時はディレクトリを参照して選択）')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('ワークスペース名（省略時はディレクトリ名）').setRequired(false),
          )
          .addStringOption((opt) =>
            opt.setName('path').setDescription('作業ディレクトリの絶対パス（省略時はブラウズ選択）').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('ワークスペースを削除します')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('ワークスペース名').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('ワークスペース一覧を表示します'),
      ),
  );
