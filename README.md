# chat-agent-bridge

Discord 経由で Claude Code をリモート操作するための Discord Bot です。

スマートフォンの Discord アプリから開発タスクを送信し、Claude Code による AI コーディングの結果をリアルタイムに受け取ることができます。

## なぜ Discord で Claude Code を使うのか

**場所を選ばず開発を進められる**
外出先や移動中でも、スマホから自宅マシンの Claude Code に作業を指示できます。通勤中にリファクタリングを依頼して、帰宅したら完了している、といった使い方が可能です。

**作業の過程がチームに自然と共有される**
Claude Code への指示や結果はすべて Discord のスレッドに残ります。これまでローカルの端末にクローズしていた「どう考えて、どんな手順で作業を進めたか」というノウハウが、チャットを通じてチームメンバーに共有されます。

**日報のように作業状況が可視化される**
他のメンバーがスレッドを見るだけで、誰がどんな作業を進めていて、どこで困っているのかが自然とわかります。`/cc report` コマンドで AI が日報を自動生成することもできます。

## 主な機能

- **リモート開発**: Discord メッセージで Claude Code に指示を送り、コーディング結果を受け取る
- **ワークスペース管理**: 複数のプロジェクトディレクトリを登録し、セッション作成時に切り替え可能
- **セッション管理**: テキストチャンネル内のスレッドごとに独立したセッションを管理。複数の作業を並行して進められる
- **リアルタイム進捗表示**: ファイル編集・読み取りなどのツール使用状況や思考プロセスを Discord にエンベッドで逐次表示
- **セッション再開**: 過去のセッションを選択して会話を再開可能
- **会話の巻き戻し・ブランチ**: 過去のメッセージにリプライすると、その時点から分岐した新しいセッションを作成
- **中断機能**: 長時間の処理を途中で停止できる（SIGINT → 10 秒後に SIGKILL）
- **日報生成**: Gemini API を使い、全ワークスペースの作業内容を要約した日報を自動生成
- **スレッドタイトル自動生成**: セッション完了後、会話内容からスレッド名を自動設定
- **API 使用量表示**: 各ターン完了後に 5h / 7d / Sonnet-7d の使用率をフッターに表示
- **アクセス制御**: 許可されたユーザー・チャンネルのみで動作
- **添付ファイル対応**: `text/*` MIME タイプのファイル（100KB 以下）を添付するとプロンプトに含めて送信
- **セッション永続化**: Bot 再起動後もスレッドとセッションのマッピングを復元

## 必要なもの

- Node.js 18 以上
- [pnpm](https://pnpm.io/)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` コマンドが使える状態)
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications) で取得）
- （任意）Gemini API キー — 日報生成・スレッドタイトル自動生成に必要

## セットアップ

### 1. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で新しいアプリケーションを作成
2. 「Bot」セクションで Bot を追加し、トークンをコピー
3. 「Bot」セクションで **MESSAGE CONTENT INTENT** を有効化（Privileged Gateway Intents）
4. 「OAuth2 > URL Generator」で以下の権限を付与して招待 URL を生成
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Create Public Threads`, `Send Messages in Threads`, `Use Slash Commands`, `Embed Links`
5. 生成した URL からサーバーに Bot を招待
6. Bot を動作させたいテキストチャンネルの ID を控えておく

### 2. インストール

```bash
git clone https://github.com/manntera/chat-agent-bridge.git
cd chat-agent-bridge/server
pnpm install
```

### 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` ファイルを編集し、以下を設定します。

**必須**

- `DISCORD_TOKEN` — Discord Bot のトークン（例: `MTIz...`）
- `CHANNEL_ID` — Bot が動作するテキストチャンネルの ID（例: `1234567890`）
- `ALLOWED_USER_IDS` — 操作を許可するユーザー ID（カンマ区切り。例: `111111,222222`）

**任意**

- `CLAUDE_PATH` — claude CLI のパス（デフォルト: `claude`）
- `GEMINI_API_KEY` — Gemini API キー。設定するとスレッドタイトル自動生成・日報生成が有効になる
- `WORKSPACES_FILE` — ワークスペース設定ファイルのパス（デフォルト: `workspaces.json`）
- `WORKSPACE_BASE_DIR` — `/cc workspace add` のディレクトリブラウズ起点（デフォルト: ホームディレクトリ）
- `THREAD_SESSIONS_FILE` — スレッド⇔セッションマッピングの保存先（デフォルト: `thread-sessions.json`）

### 4. 起動

```bash
# 開発モード（ホットリロード）
pnpm dev

# 本番用
pnpm build
pnpm start
```

## 使い方

### スラッシュコマンド

**セッション操作**

- `/cc new` — 新しいセッション（スレッド）を作成。`model`（sonnet / opus / haiku）と `effort`（medium / high / max）をオプションで指定可能。ワークスペースが複数ある場合はセレクトメニューで選択
- `/cc resume` — 過去のセッションを選択して再開（直近 25 件から選択）
- `/cc interrupt` — 実行中の処理を中断（セッションスレッド内で実行）

**ワークスペース管理**

- `/cc workspace add` — 作業ディレクトリを登録。`name` と `path` を指定するか、インタラクティブなディレクトリブラウザで選択
- `/cc workspace remove` — 登録済みのワークスペースを削除
- `/cc workspace list` — 登録済みワークスペースの一覧を表示

**レポート**

- `/cc report` — 指定日の日報を AI で自動生成（`GEMINI_API_KEY` が必要）。`date` オプションで `YYYY-MM-DD` または `-1`（昨日）のような相対指定が可能

### 基本的な流れ

1. `/cc workspace add` で作業ディレクトリを登録（初回のみ）
2. `/cc new` でテキストチャンネルにスレッドを作成
3. スレッド内にメッセージを送信すると、Claude Code に転送される
4. 処理の進捗がリアルタイムで表示される
5. 結果が返ってきたら、続けてメッセージを送信して会話を続ける
6. 過去のメッセージにリプライすると、その時点から会話を分岐できる

## 開発

```bash
pnpm test           # テスト実行
pnpm lint           # リント
pnpm format:check   # フォーマットチェック
pnpm check          # 全チェック（型検査 + リント + フォーマット + テスト）
```

## アーキテクチャ

```
スマートフォン (Discord App)
    ↕
Discord API
    ↕
chat-agent-bridge (Node.js / discord.js)
    ├── domain/          … ビジネスロジック（セッション管理・状態遷移・アクセス制御）
    ├── app/             … ユースケース（メッセージルーティング・コマンド解釈）
    └── infrastructure/  … 外部連携（Claude CLI・Discord通知・Gemini API・永続化）
    ↕                ↕
Claude Code CLI    Gemini API（任意）
    ↕
ローカルファイルシステム
```

セッションデータは Claude Code CLI が `~/.claude/projects/` 配下に JSONL 形式で管理します。Bot はこのデータを読み取り、セッションの再開やブランチを実現しています。

詳細は [docs/](docs/) を参照してください。

## 注意事項

- この Bot は Claude Code CLI を `--dangerously-skip-permissions` フラグ付きで実行します。これにより、Claude Code はファイルの読み書きやコマンド実行を確認なしで行います。信頼できる環境でのみ使用し、ワークスペースには意図したプロジェクトディレクトリのみを登録してください。
- `--append-system-prompt` により、Claude Code の出力が Discord 互換のマークダウンに制限されます。
- `GEMINI_API_KEY` を設定した場合、セッション内容が Gemini API に送信されます（タイトル生成・日報生成時）。

## ライセンス

MIT
