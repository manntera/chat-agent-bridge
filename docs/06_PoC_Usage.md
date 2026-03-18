# 使い方ガイド：claude-discord-bridge PoC

スマートフォンの Discord から、自宅マシンの ClaudeCode を遠隔操作するための Bot です。

---

## 1. 必要なもの

| 項目 | 説明 |
|------|------|
| Ubuntu マシン | Bot と ClaudeCode を動かすホストマシン |
| Node.js 18 以上 | Bot の実行環境 |
| pnpm | パッケージマネージャ |
| claude CLI | ClaudeCode の CLI ツール（`claude` コマンドが使えること） |
| Discord アカウント | Bot の作成とメッセージの送受信に使用 |

---

## 2. Discord Bot のセットアップ

### 2.1 Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. **New Application** をクリックし、任意の名前を入力して作成
3. 左メニューの **Bot** を選択
4. **Reset Token** をクリックし、表示されたトークンをメモする（後で `.env` に設定する）

### 2.2 Message Content Intent の有効化

同じ Bot 設定ページの **Privileged Gateway Intents** セクションで：

- **MESSAGE CONTENT INTENT** を **ON** にする

> **重要：** この設定をしないと、Bot がメッセージの内容を読み取れません（`content` が空文字列になります）。

### 2.3 Bot をサーバーに招待

1. 左メニューの **OAuth2** を選択
2. **OAuth2 URL Generator** で以下にチェック：
   - **SCOPES:** `bot`
   - **BOT PERMISSIONS:** `Send Messages`, `Read Message History`
3. 生成された URL をブラウザで開き、Bot を追加するサーバーを選択

### 2.4 ID の取得

Discord アプリの設定で **開発者モード** を有効にしておくと、右クリックで各種 ID をコピーできます。

- **PC:** ユーザー設定 → 詳細設定 → 開発者モード ON
- **スマートフォン:** ユーザー設定 → アプリの設定 → 詳細設定 → 開発者モード ON

取得する ID：

| ID | 取得方法 | `.env` の設定先 |
|----|---------|----------------|
| チャンネル ID | Bot を動かすテキストチャンネルを右クリック → **チャンネル ID をコピー** | `CHANNEL_ID` |
| ユーザー ID | 自分のアイコンを右クリック → **ユーザー ID をコピー** | `ALLOWED_USER_IDS` |

---

## 3. サーバーのセットアップ

### 3.1 依存パッケージのインストール

```bash
cd server
pnpm install
```

### 3.2 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集し、各値を入力する。

```
DISCORD_TOKEN=あなたのBotトークン
CHANNEL_ID=テキストチャンネルのID
ALLOWED_USER_IDS=あなたのユーザーID
WORK_DIR=/home/user/projects
```

| 環境変数 | 説明 |
|----------|------|
| `DISCORD_TOKEN` | 2.1 で取得した Bot トークン |
| `CHANNEL_ID` | 2.4 で取得したチャンネル ID |
| `ALLOWED_USER_IDS` | 2.4 で取得したユーザー ID（カンマ区切りで複数指定可） |
| `WORK_DIR` | ClaudeCode に作業させるディレクトリの絶対パス |
| `CLAUDE_PATH` | claude CLI のパス（省略時は `claude`） |

### 3.3 起動

```bash
pnpm dev
```

以下が表示されれば起動成功です。

```
Discord に接続しました
claude-discord-bridge を起動しました
```

---

## 4. 使い方

### 4.1 基本操作

Bot が動作しているチャンネルにテキストを送信するだけで、ClaudeCode が応答します。

```
あなた: このプロジェクトの構成を教えて
Bot:    📁 プロジェクトの構成は以下の通りです...
```

セッション（会話の文脈）は自動的に管理されます。続けてメッセージを送ると、前の会話の続きとして処理されます。

```
あなた: テストを追加して
Bot:    🔧 Edit: src/index.test.ts     ← ツール使用のリアルタイム通知
Bot:    💭 テストケースを検討中...       ← 拡張思考のリアルタイム通知
Bot:    テストを追加しました。以下の3件のテストを...
```

### 4.2 コマンド

| コマンド | 説明 |
|----------|------|
| `!new` | セッションをリセットし、新しい会話を開始する |
| `!interrupt` | 実行中の処理を中断する |

**`!new` の使い方：**

```
あなた: !new
Bot:    新しいセッションを開始しました
あなた: 別のプロジェクトについて教えて    ← 前の会話とは独立した新しい会話
```

**`!interrupt` の使い方：**

```
あなた: プロジェクト全体をリファクタリングして    ← 時間がかかりそうな処理
Bot:    🔧 Read: src/index.ts
Bot:    🔧 Edit: src/app.ts
あなた: !interrupt                                ← 中断
Bot:    中断しました
あなた: やっぱりテストだけ先に書いて              ← 続きから別の指示が可能
```

### 4.3 処理中の入力

ClaudeCode が処理中にメッセージを送ると、`処理中です` と返されます。`!interrupt` または `!new` で中断してから次の指示を送ってください。

---

## 5. リアルタイム通知

ClaudeCode の処理中、以下の途中経過がリアルタイムで Discord に表示されます。

| 表示 | 意味 |
|------|------|
| `🔧 Edit: src/index.ts` | ファイルを編集中 |
| `🔧 Read: src/config.ts` | ファイルを読み取り中 |
| `🔧 Bash: npm test` | コマンドを実行中 |
| `🔧 Grep: TODO` | コード内を検索中 |
| `💭 コードの構造を分析中...` | AI が思考中（拡張思考） |

---

## 6. トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| Bot がメッセージに反応しない | `CHANNEL_ID` が正しいか確認する。開発者モードで ID を再取得する |
| Bot が反応するが `content` が空 | Developer Portal で **MESSAGE CONTENT INTENT** を ON にする |
| `チャンネルが見つからないか、TextChannel ではありません` | `CHANNEL_ID` がテキストチャンネルの ID であることを確認する（フォーラムやボイスチャンネルは不可） |
| 自分のメッセージが無視される | `ALLOWED_USER_IDS` に自分のユーザー ID が含まれているか確認する |
| `claude` コマンドが見つからない | `claude` CLI がインストールされ PATH が通っているか確認する。必要なら `.env` に `CLAUDE_PATH=/full/path/to/claude` を設定する |
| 応答が途中で切れる | Discord のメッセージ上限（2000文字）で自動分割されます。複数メッセージに分かれて届くのは正常な動作です |
