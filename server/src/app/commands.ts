/**
 * `/cc` コマンド体系の宣言的スキーマ(単一ソース)。
 *
 * 各プラットフォームアダプタはこのデータを自プラットフォームのネイティブ UI に
 * コンパイルする(Discord: SlashCommandBuilder / Slack: Block Kit 等)。
 * コマンドの名前・説明・選択肢をここ以外に書かないこと。
 */

export interface CommandChoice {
  name: string;
  value: string;
}

export interface CommandOptionSpec {
  name: string;
  description: string;
  required: boolean;
  autocomplete?: boolean;
  choices?: CommandChoice[];
}

export interface SubcommandSpec {
  name: string;
  description: string;
  options?: CommandOptionSpec[];
}

export interface CommandGroupSpec {
  name: string;
  description: string;
  subcommands: SubcommandSpec[];
}

export interface CommandSpec {
  name: string;
  description: string;
  subcommands: SubcommandSpec[];
  groups: CommandGroupSpec[];
}

export const MODEL_CHOICES: CommandChoice[] = [
  { name: 'fable (最高性能)', value: 'fable' },
  { name: 'opus (高性能)', value: 'opus' },
  { name: 'sonnet (バランス)', value: 'sonnet' },
  { name: 'haiku (高速・低コスト)', value: 'haiku' },
];

export const EFFORT_CHOICES: CommandChoice[] = [
  { name: 'low', value: 'low' },
  { name: 'medium', value: 'medium' },
  { name: 'high', value: 'high' },
  { name: 'xhigh (デフォルト・推奨)', value: 'xhigh' },
  { name: 'max', value: 'max' },
];

export const VALID_EFFORTS = new Set(EFFORT_CHOICES.map((c) => c.value));

export const ccCommandSpec: CommandSpec = {
  name: 'cc',
  description: 'Claude Code を操作します',
  subcommands: [
    {
      name: 'new',
      description: '新しいセッションを開始します',
      options: [
        {
          name: 'model',
          description: '使用するモデル',
          required: false,
          choices: MODEL_CHOICES,
        },
        {
          name: 'effort',
          description: '思考の深さ (非対応モデルでは自動的に近い下位レベルにフォールバック)',
          required: false,
          choices: EFFORT_CHOICES,
        },
      ],
    },
    { name: 'interrupt', description: '処理を中断します' },
    { name: 'resume', description: '過去のセッションを再開します' },
    {
      name: 'report',
      description: '日報を生成します',
      options: [
        {
          name: 'date',
          description: '対象日（YYYY-MM-DD、-1=昨日 等。省略時: 今日）',
          required: false,
          autocomplete: true,
        },
      ],
    },
  ],
  groups: [
    {
      name: 'workspace',
      description: 'ワークスペースを管理します',
      subcommands: [
        {
          name: 'add',
          description: 'ワークスペースを登録します（省略時はディレクトリを参照して選択）',
          options: [
            {
              name: 'name',
              description: 'ワークスペース名（省略時はディレクトリ名）',
              required: false,
            },
            {
              name: 'path',
              description: '作業ディレクトリの絶対パス（省略時はブラウズ選択）',
              required: false,
            },
          ],
        },
        {
          name: 'remove',
          description: 'ワークスペースを削除します',
          options: [{ name: 'name', description: 'ワークスペース名', required: true }],
        },
        { name: 'list', description: 'ワークスペース一覧を表示します' },
      ],
    },
  ],
};

/** 選択 UI(セレクトメニュー等)の識別子。アダプタ間で共有する。 */
export const SELECT_IDS = {
  workspaceForNew: 'cc_workspace_select',
  resumeSession: 'cc_resume_select',
  workspaceBrowse: 'cc_workspace_browse',
} as const;
