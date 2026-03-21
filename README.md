# claude-discord-bridge

Discord 経由で Claude Code をリモート操作するための Discord Bot です。

スマートフォンの Discord アプリから開発タスクを送信し、Claude Code による AI コーディングの結果をリアルタイムに受け取ることができます。

## なぜ Discord で Claude Code を使うのか

**場所を選ばず開発を進められる**
外出先や移動中でも、スマホから自宅マシンの Claude Code に作業を指示できます。通勤中にリファクタリングを依頼して、帰宅したら完了している、といった使い方が可能です。

**作業の過程がチームに自然と共有される**
Claude Code への指示や結果はすべて Discord のスレッドに残ります。これまでローカルの端末にクローズしていた「どう考えて、どんな手順で作業を進めたか」というノウハウが、チャットを通じてチームメンバーに共有されます。

**日報のように作業状況が可視化される**
他のメンバーがスレッドを見るだけで、誰がどんな作業を進めていて、どこで困っているのかが自然とわかります。作業指示をチャットで行うこと自体が、リアルタイムな日報として機能します。

## 主な機能

- **リモート開発**: Discord メッセージで Claude Code に指示を送り、コーディング結果を受け取る
- **セッション管理**: Discord フォーラムのスレッドごとに独立したセッションを管理。複数の作業を並行して進められる
- **リアルタイム進捗表示**: ファイル編集・読み取りなどのツール使用状況や思考プロセスを Discord に逐次表示
- **セッション再開**: 過去のセッションを選択して会話を再開可能
- **中断機能**: 長時間の処理を途中で停止できる
- **アクセス制御**: 許可されたユーザー・チャンネルのみで動作
- **添付ファイル対応**: `.txt` ファイルを添付するとプロンプトに含めて送信

## 必要なもの

- Node.js 18 以上
- [pnpm](https://pnpm.io/)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` コマンドが使える状態)
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications) で取得）

## セットアップ

### 1. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で新しいアプリケーションを作成
2. 「Bot」セクションで Bot を追加し、トークンをコピー
3. 「OAuth2 > URL Generator」で以下の権限を付与して招待 URL を生成
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Create Public Threads`, `Send Messages in Threads`, `Use Slash Commands`
4. 生成した URL からサーバーに Bot を招待
5. Bot を動作させたいフォーラムチャンネル（またはテキストチャンネル）の ID を控えておく

### 2. インストール

```bash
git clone https://github.com/your-username/claude-discord-bridge.git
cd claude-discord-bridge/server
pnpm install
```

### 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` ファイルを編集し、以下を設定します。

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `DISCORD_TOKEN` | Discord Bot のトークン | `MTIz...` |
| `CHANNEL_ID` | Bot が動作するチャンネルの ID | `1234567890` |
| `ALLOWED_USER_IDS` | 操作を許可するユーザー ID（カンマ区切り） | `111111,222222` |
| `WORK_DIR` | Claude Code の作業ディレクトリ | `/home/user/projects` |
| `CLAUDE_PATH` | claude CLI のパス（省略可） | `claude` |

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

| コマンド | 説明 |
|----------|------|
| `/cc new` | 新しいセッション（スレッド）を作成。モデルやエフォートはメニューから選択可能 |
| `/cc resume` | 過去のセッションを選択して再開 |
| `/cc interrupt` | 実行中の処理を中断 |

### 基本的な流れ

1. `/cc new` でフォーラムにスレッドを作成
2. スレッド内にメッセージを送信すると、Claude Code に転送される
3. 処理の進捗がリアルタイムで表示される
4. 結果が返ってきたら、続けてメッセージを送信して会話を続ける

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
claude-discord-bridge (Node.js / discord.js)
    ↕
Claude Code CLI (claude -p --session-id ...)
    ↕
ローカルファイルシステム
```

domain / app / infrastructure のレイヤーに分離して実装されています。詳細は [docs/](docs/) を参照してください。

## ライセンス

MIT
