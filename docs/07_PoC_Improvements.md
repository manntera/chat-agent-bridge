# PoC ブラッシュアップ記録

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `02_PoC_Plan.md` — PoC の範囲と完了条件
- `03_PoC_DomainModel.md` — ドメインモデルの詳細仕様
- `04_PoC_Infrastructure.md` — インフラストラクチャ層の設計
- `05_PoC_App.md` — App 層の設計
- `06_PoC_Usage.md` — 使い方ガイド

**本ドキュメントの位置づけ：** PoC 実装完了後に行った改善・変更をまとめたものである。上記ドキュメントに記載された仕様からの差分を記録する。

---

## 1. コマンド体系の変更：テキストコマンドからスラッシュコマンドへ

### 変更前（PoC ドキュメント）

Discord のテキストメッセージ中の `!` 接頭辞でコマンドを識別する方式。

| コマンド | 操作内容 |
|----------|----------|
| `!new` | セッション ID をリセットし、新しい会話を開始 |
| `!interrupt` | 実行中のプロセスを中断 |
| 上記以外のテキスト | ClaudeCode への入力として転送 |

ドメイン層の `Command` 型は以下の 3 種:

```typescript
// PoC ドキュメント時点
type Command = 'NewCommand' | 'InterruptCommand' | 'PromptInput';
```

### 変更後（現在の実装）

Discord のスラッシュコマンド（`/cc`）でシステム制御を行い、テキストメッセージはすべてプロンプトとして扱う方式に変更した。

| 入力 | 操作内容 |
|------|----------|
| `/cc new [model] [effort]` | 新しいセッションを開始（オプションでモデルと思考深度を指定） |
| `/cc interrupt` | 実行中のプロセスを中断 |
| テキストメッセージ | すべて ClaudeCode への入力として転送 |

`Command` 型はタグ付きユニオンに変更:

```typescript
// 現在の実装
type Command =
  | { type: 'new'; options: SessionOptions }
  | { type: 'interrupt' }
  | { type: 'prompt'; text: string };
```

### 変更理由

- テキストメッセージ中の `!new` や `!interrupt` を誤って ClaudeCode に送ってしまうリスクを排除
- スラッシュコマンドの補完・バリデーションを Discord 側に委譲できる
- モデル・思考深度などのオプションをスラッシュコマンドの引数として自然に指定できる

### 影響範囲

| コンポーネント | 変更内容 |
|---------------|----------|
| `domain/types.ts` | `Command` 型をタグ付きユニオンに変更 |
| `domain/orchestrator.ts` | `handleCommand(command: Command)` メソッドを追加 |
| `app/interaction-handler.ts` | **新規追加。** スラッシュコマンドのルーティングを担当 |
| `infrastructure/slash-commands.ts` | **新規追加。** `/cc` コマンドの定義（discord.js `SlashCommandBuilder`） |
| `index.ts` | `InteractionCreate` イベントハンドラを追加、スラッシュコマンド登録処理を追加 |

---

## 2. セッションオプション（model / effort）の追加

### 変更前（PoC ドキュメント）

セッションは `sessionId` と `workDir` のみで構成されていた。

### 変更後（現在の実装）

`SessionOptions` 型を導入し、セッション開始時にモデルと思考深度を指定できるようにした。

```typescript
type Effort = 'medium' | 'high' | 'max';

interface SessionOptions {
  model?: string;    // 'sonnet' | 'opus' | 'haiku'
  effort?: Effort;
}
```

スラッシュコマンドの選択肢:

```
/cc new                     → デフォルト設定
/cc new model:opus          → Opus モデルを使用
/cc new effort:max          → 最大思考深度
/cc new model:haiku effort:medium → Haiku + medium
```

### 影響範囲

| コンポーネント | 変更内容 |
|---------------|----------|
| `domain/types.ts` | `Effort` 型、`SessionOptions` 型を追加 |
| `domain/session.ts` | `options` プロパティ、`ensure(options)` の引数を追加 |
| `domain/orchestrator.ts` | `handleCommand` の `new` 分岐でオプションを Session に渡す。`pendingNewOptions` で Busy→Interrupting→new 時のオプション保持 |
| `infrastructure/claude-process.ts` | `spawn()` に `options` 引数を追加、`--model` / `--effort` 引数を生成 |
| `infrastructure/slash-commands.ts` | model・effort の選択肢を定義 |

---

## 3. セッション起動方式の変更

### 3.1 自動開始から明示的開始へ

**変更前：** Initial 状態でユーザーがテキストを送信すると `Session.ensure()` が自動的に呼ばれ、セッションが開始された。

**変更後：** Initial 状態でテキストを送信すると「`/cc new` でセッションを開始してください」と返す。セッション開始は `/cc new` コマンドで明示的に行う。

**変更理由：** スラッシュコマンドでのオプション指定を前提としたフローへの移行。

### 3.2 `--session-id` と `--resume` の使い分け

**変更前：** 常に `--session-id` オプションで claude CLI を起動していた。

**変更後：** 初回は `--session-id`（新規セッション作成）、2 回目以降は `--resume`（既存セッション継続）で起動する。

```typescript
// claude CLI 起動引数の切り替え
const sessionArgs = resume
  ? ['--resume', sessionId]
  : ['--session-id', sessionId];
```

**影響範囲：**

| コンポーネント | 変更内容 |
|---------------|----------|
| `domain/session.ts` | `isNew` プロパティ、`markUsed()` メソッドを追加 |
| `domain/types.ts` | `IClaudeProcess.spawn()` に `resume: boolean` パラメータを追加 |
| `domain/orchestrator.ts` | spawn 呼び出し前に `session.isNew` を確認し、呼び出し後に `session.markUsed()` を実行 |
| `infrastructure/claude-process.ts` | `resume` フラグに応じて `--session-id` / `--resume` を切り替え |

### 3.3 `/cc new` の振る舞い変更

**変更前（PoC ドキュメント）：**

| 状態 | 振る舞い |
|------|----------|
| Initial | 「セッションがありません」と応答 |
| Idle | `Session.reset()` → Initial → 「新しいセッションを開始しました」 |
| Busy | Interrupting を経由 → プロセス終了後に `Session.reset()` → Initial |

**変更後（現在の実装）：**

| 状態 | 振る舞い |
|------|----------|
| Initial | `Session.reset()` → `Session.ensure(options)` → Idle → 「新しいセッションを開始しました (model: ..., effort: ...)」 |
| Idle | 同上（Initial と同じ振る舞い） |
| Busy | Interrupting を経由 → プロセス終了後に `Session.reset()` → `Session.ensure(pendingOptions)` → Idle |

**変更点の要約：** `/cc new` は常にセッションを即座に準備完了状態（Idle）にする。PoC では Initial に戻してユーザーの次のメッセージで自動開始する方式だったが、現在は `/cc new` の時点で `Session.ensure()` まで完了し、次のテキストメッセージですぐに ClaudeCode を起動できる。

---

## 4. スレッド通知機能

### 変更前（PoC ドキュメント）

途中経過（ツール使用、拡張思考）はチャンネルに直接メッセージとして送信していた。

### 変更後（現在の実装）

途中経過をユーザーのメッセージに対するスレッド内に送信するように変更した。

**通知先の分類：**

| 通知の種別 | 送信先 |
|-----------|--------|
| `progress`（started / tool_use / thinking） | ユーザーのメッセージに作成されたスレッド |
| `result` / `error` / `info` | チャンネルに直接送信 |

**スレッドのライフサイクル：**

1. ユーザーがメッセージ送信時に `setThreadOrigin(message)` でスレッドの起点を保持
2. 最初の `progress` 通知時にスレッドを作成（スレッド名: 「途中経過」）
3. `result` または `error` の送信後にスレッドをアーカイブ（`setArchived(true)`）してリセット（次のメッセージで新しいスレッドが作られる）

**DiscordNotifier のインターフェース変更：**

```typescript
// PoC ドキュメント時点
interface MessageSender {
  send(content: string): Promise<unknown>;
}

// 現在の実装
interface ChannelSender {
  send(content: string): Promise<unknown>;
}
interface ThreadSender {
  send(content: string): Promise<unknown>;
  setArchived(archived: boolean): Promise<unknown>;
}
interface Threadable {
  startThread(options: { name: string }): Promise<ThreadSender>;
}

// createNotifier の戻り値にも setThreadOrigin を追加
function createNotifier(
  channel: ChannelSender,
): NotifyFn & { setThreadOrigin(message: Threadable): void };
```

**変更理由：** チャンネルに途中経過が大量に流れると、他のメッセージが埋もれてしまう。スレッドに分離することで、途中経過を追いたいときだけスレッドを開けばよくなり、チャンネルの可読性が向上した。

---

## 5. 「started」イベントの追加

### 変更前（PoC ドキュメント）

`ProgressEvent` は `tool_use` と `thinking` の 2 種類のみ。

```typescript
type ProgressEvent =
  | { kind: 'tool_use'; toolName: string; target: string }
  | { kind: 'thinking'; text: string };
```

### 変更後（現在の実装）

`started` イベントを追加。

```typescript
type ProgressEvent =
  | { kind: 'started' }
  | { kind: 'tool_use'; toolName: string; target: string }
  | { kind: 'thinking'; text: string };
```

Orchestrator が Idle → Busy 遷移時に `{ type: 'progress', event: { kind: 'started' } }` を通知する。Discord には「📨 受信しました。処理を開始します...」と表示される。

**変更理由：** ClaudeCode の応答が返るまでに時間がかかる場合、ユーザーにメッセージが受信されたことを即座にフィードバックするため。

---

## 6. Discord 互換マークダウン指示（システムプロンプト）

### 変更前（PoC ドキュメント）

claude CLI への引数は以下のみ:

```bash
claude -p <prompt> --session-id <ID> --output-format stream-json --dangerously-skip-permissions
```

### 変更後（現在の実装）

`--append-system-prompt` と `--verbose` を追加:

```bash
claude -p <prompt> \
  --session-id <ID> (or --resume <ID>) \
  --model <model> \              # オプション
  --effort <effort> \            # オプション
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  --append-system-prompt "<Discord互換マークダウン指示>"
```

**システムプロンプトの内容：**

> 回答のマークダウンはDiscordで表示されます。Discord互換の構文のみ使用してください。
>
> 使用可能: \*\*太字\*\* \*斜体\* ~~取り消し線~~ \`インラインコード\` \`\`\`コードブロック\`\`\` > 引用 >>> 複数行引用 # ## ### 見出し - リスト 1. 番号リスト \[リンク\](URL) ||スポイラー|| -# 小文字テキスト
>
> 使用禁止: テーブル(| |)、画像(![]())、HTMLタグ、脚注、タスクリスト(- [x])、水平線(---)
>
> テーブルの代わりにリストやコードブロックで情報を整理してください。

**変更理由：** ClaudeCode が Markdown テーブルや画像記法を使用すると、Discord 上で正しく表示されない。システムプロンプトで禁止することで、Discord 互換の出力を得られるようにした。

---

## 7. stderr 出力のフォールバック

### 変更前（PoC ドキュメント）

`stdio` 設定やstderr 出力の取り扱いについて言及なし。

### 変更後（現在の実装）

```typescript
{ stdio: ['ignore', 'pipe', 'pipe'] }
```

- stdin: `'ignore'`（非対話モードのため不要）
- stdout: `'pipe'`（stream-json の読み取り）
- stderr: `'pipe'`（エラー出力の取得）

stderr 出力をバッファリングし、stdout から結果テキストが得られなかった場合のフォールバックとして使用する:

```typescript
const output = resultText || stderrOutput;
this.onProcessEnd(exitCode ?? 1, output);
```

**変更理由：** claude CLI がエラーを stderr に出力する場合があり、stdout にのみ依存するとエラー内容を Discord に伝えられないケースがあった。

---

## 8. Orchestrator の handleCommand メソッド追加

### 変更前（PoC ドキュメント）

Orchestrator は `handleMessage(text: string)` のみを公開し、内部でテキストを `Command` に分類していた。

### 変更後（現在の実装）

2 つのエントリーポイントを持つ:

```typescript
class Orchestrator {
  /** テキストメッセージをプロンプトとして処理する */
  handleMessage(text: string): void {
    this.handleCommand({ type: 'prompt', text: text.trim() });
  }

  /** パース済みコマンドを処理する */
  handleCommand(command: Command): void { ... }
}
```

**変更理由：** テキストコマンド（`!new` / `!interrupt`）を廃止しスラッシュコマンドに移行したことで、コマンド解析の責務が Orchestrator の外（InteractionHandler）に移った。`handleMessage` はテキストを無条件でプロンプトとして委譲し、`handleCommand` はパース済みのコマンドを直接受け付ける。

---

## 9. App 層の拡張（InteractionHandler）

### 変更前（PoC ドキュメント）

App 層は `MessageHandler` のみ。

### 変更後（現在の実装）

`InteractionHandler` を追加。

```
server/src/app/
├── message-handler.ts           # テキストメッセージのルーティング（変更なし）
├── message-handler.test.ts
├── interaction-handler.ts       # スラッシュコマンドのルーティング（新規追加）
└── interaction-handler.test.ts
```

**InteractionHandler の責務：**

1. `AccessControl.check()` でアクセス制御
2. サブコマンド名とオプションを `Command` 型に変換
3. `Orchestrator.handleCommand()` に委譲

```typescript
interface InteractionContext extends MessageContext {
  subcommand: string;
  model?: string;
  effort?: string;
}
```

**MessageHandler との違い：**

| 観点 | MessageHandler | InteractionHandler |
|------|---------------|-------------------|
| 入力元 | Discord テキストメッセージ | Discord スラッシュコマンド |
| 呼び出し先 | `orchestrator.handleMessage(text)` | `orchestrator.handleCommand(command)` |
| コマンド解析 | なし（全テキストがプロンプト） | サブコマンド → `Command` 型への変換 |

---

## 10. 起動時メッセージ

### 変更前（PoC ドキュメント）

起動時の動作についてドキュメントに記載なし。

### 変更後（現在の実装）

Bot 起動完了時にチャンネルへメッセージを送信する:

```typescript
await channel.send('chat-agent-bridge を起動しました 🟢');
```

**変更理由：** Bot が正常に起動しチャンネルに接続されたことを、スマートフォン側から確認できるようにするため。

---

## 11. ログ出力の強化

### 変更前（PoC ドキュメント）

ログ出力についてドキュメントに記載なし。

### 変更後（現在の実装）

日本語ローカライズされたタイムスタンプ付きのログ出力を実装。

```
[14:32:15] 設定読み込み完了 (workDir: /home/user/projects)
[14:32:16] Discord に接続しました
[14:32:16] スラッシュコマンド /cc を登録しました
[14:32:16] チャンネル #claude-bridge を取得しました
[14:32:16] chat-agent-bridge を起動しました
[14:33:01] メッセージ受信: username "テスト追加して"
[14:33:01] 状態遷移: idle → busy
[14:33:01] 途中経過: 📨 受信しました。処理を開始します...
[14:33:03] 途中経過: 🔧 Edit: src/index.ts
[14:33:05] 途中経過: 💭 テストケースを検討中...
[14:33:10] ClaudeProcess 終了 (exitCode: 0)
[14:33:10] 結果: テストを追加しました。以下の3件の...
```

**ログ対象：**

| イベント | ログ内容 |
|---------|---------|
| 設定読み込み | workDir パス |
| Discord 接続 | 接続完了 |
| チャンネル取得 | チャンネル名 |
| メッセージ受信 | ユーザー名 + メッセージ内容 |
| コマンド受信 | ユーザー名 + サブコマンド |
| 状態遷移 | 遷移前 → 遷移後 |
| 途中経過 | イベント種別に応じたテキスト |
| プロセス終了 | exitCode |
| 結果 | 先頭 100 文字（コンソールのみ。Discord には全文送信） |
| エラー | エラーメッセージ + exitCode |

---

## 12. ビルド・実行スクリプトの追加

### 変更前（PoC ドキュメント）

開発実行のみ: `pnpm dev`

### 変更後（現在の実装）

本番向けのビルド・実行スクリプトを追加:

```json
{
  "dev": "tsx src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js"
}
```

- `pnpm dev` — TypeScript を直接実行（開発時）
- `pnpm build` — TypeScript をコンパイル（`dist/` に出力）
- `pnpm start` — コンパイル済み JavaScript を実行（本番時）

---

## 13. 状態遷移の変更まとめ

PoC ドキュメントからの状態遷移表の変更をまとめる。

### ユーザー入力による遷移

| 現在の状態 | 入力 | PoC での動作 | 現在の動作 |
|-----------|------|-------------|-----------|
| **Initial** | prompt | Session.ensure() → spawn() → Busy | 「`/cc new` でセッションを開始してください」 |
| **Initial** | `/cc new` | 「セッションがありません」 | Session.reset() → Session.ensure(options) → Idle |
| **Idle** | `/cc new` | Session.reset() → Initial | Session.reset() → Session.ensure(options) → Idle |
| **Busy** | `/cc new` | interruptReason='new' → interrupt() → Interrupting | 同左（加えて `pendingNewOptions` を保持） |

### プロセス終了による遷移

| 現在の状態 | interruptReason | PoC での動作 | 現在の動作 |
|-----------|-----------------|-------------|-----------|
| Interrupting | `'new'` | Session.reset() → Initial | Session.reset() → Session.ensure(pendingNewOptions) → Idle |
