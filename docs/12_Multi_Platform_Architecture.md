# マルチプラットフォーム対応アーキテクチャ設計（参考資料）

> **このドキュメントは作業計画として使用しないでください。**
>
> 本書は執筆時点のスナップショットであり、その後の実装は本書に記されたディレクトリ構成・ポート設計・作業手順（Phase 1／Phase 2、Step 1-1 以降）に従っていません。以降のコード変更も本書にフィードバックされないため、記述と実装は今後さらに乖離していきます。
>
> 新規メンバーは本書を**マルチプラットフォーム化を検討した際の設計思想・論点の参考資料**として読むに留め、ここに書かれたファイルパスや移動手順をそのまま実装タスクとして起票しないでください。現状のコード構造は `server/src/` 以下の実コードを正としてください。

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `09_Parallel_Sessions.md` — 並列セッション機能（スレッドベース設計）

**本ドキュメントの元の位置づけ（執筆当時）：** 現在 Discord 専用であるシステムを、Slack 等の他プラットフォームにも対応できるアーキテクチャに再構成する設計。

---

## 1. 概要

### 1.1 現状の課題

現在のシステムは Discord 専用として動作しており、以下の問題がある。

- `index.ts`（約390行）に Discord 固有のイベントハンドリング、スレッド作成、UI コンポーネント構築が集中している
- `infrastructure/` 層に Discord 固有の実装（`discord-notifier.ts`、`slash-commands.ts`）が混在している
- `claude-process.ts` に Discord 専用のシステムプロンプトがハードコードされている
- Slack 等の他プラットフォームに対応しようとすると、コードの大量複製が必要になる

### 1.2 方針

Ports & Adapters（Hexagonal Architecture）の考え方を採用し、プラットフォーム固有のコードを **Adapter 層** として分離する。

- **App 層**がポート（インターフェース）を定義し、ユースケースを記述する
- **Adapter 層**が各プラットフォーム固有の実装を提供する
- **Domain 層**と**Infrastructure 層**はプラットフォーム非依存のまま維持する

### 1.3 Adapter 層を独立させる理由

Discord/Slack の実装をどの層に配置するかについて、以下の観点から検討した。

**Presentation 層とする案：**

- ユーザーとの接点であり、入出力の「見た目」を扱うという解釈
- Embed、スラッシュコマンド、セレクトメニューは「UI コンポーネント」

**Infrastructure 層とする案：**

- Discord/Slack は SDK・WebSocket・認証を伴う外部システム
- DB ドライバや HTTP クライアントと同様に「技術基盤への依存」
- Clean Architecture の Frameworks & Drivers 層に UI フレームワークも含まれる

**本設計の結論 — Adapter 層として独立：**

このシステムには「自前の UI」が存在しない。Discord/Slack そのものがアプリケーションの外にある UI であり、自分たちのコードは「その外部プラットフォームとどうやり取りするか」を書いている。これは本質的に**外部システムとの通信アダプター**であり、Presentation と Infrastructure の二項対立に収めるより、Ports & Adapters パターンとして明示的に分離する方が自然である。

また、Discord と Slack では UI パラダイムが根本的に異なる部分がある（セレクトメニュー vs モーダル、Embed vs Block Kit など）。無理に共通インターフェースを作ると最小公倍数的な貧弱な抽象になるリスクがあるため、**抽象化は本当に共通な部分だけに限定**し、プラットフォーム固有の部分は各 Adapter 内で自由に実装する。

---

## 2. アーキテクチャ

### 2.1 レイヤー構成

```
┌─────────────────────────────────────────────────────────┐
│  Adapters (プラットフォーム固有)                          │
│  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │ adapters/discord/    │  │ adapters/slack/           │  │
│  │  client.ts           │  │  client.ts                │  │
│  │  notifier.ts         │  │  notifier.ts              │  │
│  │  interaction-ctrl.ts │  │  command-handler.ts        │  │
│  │  message-ctrl.ts     │  │  message-ctrl.ts           │  │
│  │  slash-commands.ts   │  │  ...                       │  │
│  └─────────────────────┘  └──────────────────────────┘  │
└──────────────┬──────────────────────────────────────────┘
               │ 実装する
┌──────────────▼──────────────────────────────────────────┐
│  App (ユースケース + ポート定義)                          │
│  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │ ports/          │  │ use-cases/                    │   │
│  │  notifier.ts    │  │  handle-message.ts            │   │
│  │  bot.ts         │  │  handle-command.ts            │   │
│  └────────────────┘  │  create-session.ts            │   │
│                       └──────────────────────────────┘   │
└──────────────┬──────────────────────────────────────────┘
               │ 依存する
┌──────────────▼──────────────────────────────────────────┐
│  Domain (ビジネスルール)            変更なし              │
│  orchestrator.ts / session.ts / session-manager.ts       │
│  access-control.ts / types.ts                            │
└──────────────┬──────────────────────────────────────────┘
               │ 利用する
┌──────────────▼──────────────────────────────────────────┐
│  Infrastructure (技術基盤)          プラットフォーム非依存 │
│  claude-process.ts / session-store.ts / usage-fetcher.ts │
│  stream-json-parser.ts / attachment-resolver.ts          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 各レイヤーの責務

| レイヤー | 責務 | 依存方向 |
|---------|------|---------|
| **Adapters** | プラットフォーム固有のイベント受付・メッセージ送信・UI構築。App 層のポートを実装する | App のポートに依存 |
| **App** | ユースケースの実行。ポート（インターフェース）の定義。ドメインオブジェクトのオーケストレーション | Domain に依存 |
| **Domain** | ビジネスルール、状態管理、エンティティ | 何にも依存しない |
| **Infrastructure** | 外部 I/O の技術実装（CLI 起動、ファイル読み書き、API 呼び出し） | Domain の型に依存 |

### 2.3 依存性の原則

- 内側のレイヤーは外側のレイヤーを知らない
- App 層がポート（インターフェース）を定義し、Adapter 層がそれを実装する（依存性逆転）
- Domain 層は App 層にも依存しない
- Infrastructure 層のインターフェースは Domain 層で定義済み（`IClaudeProcess`, `ISessionStore`, `IUsageFetcher`）

---

## 3. ポート設計（App 層）

### 3.1 INotifier — 通知ポート

ドメインの `Notification` を受け取り、プラットフォーム固有の形式で送信する。

```typescript
// app/ports/notifier.ts
import type { NotifyFn } from '../../domain/types.js';

/**
 * セッションスレッド（またはチャンネル）への通知送信を抽象化する。
 * Discord では Embed、Slack では Block Kit など、実装は Adapter に委ねる。
 */
export type INotifier = NotifyFn;
```

既に `domain/types.ts` に `NotifyFn` が定義されており、`Notification` 型がプラットフォーム非依存であるため、このポートは薄いエイリアスとなる。現在の `discord-notifier.ts` の `createNotifier` がこのポートの Discord 実装に相当する。

**Notifier 生成のファクトリパターン：**

各 Adapter は、スレッド（またはチャンネル）ごとに `NotifyFn` を生成するファクトリ関数を提供する。このファクトリはプラットフォーム固有の送信先オブジェクトを受け取るため、ポートとしては定義せず、各 Adapter 内に閉じる。

```typescript
// adapters/discord/notifier.ts — ファクトリの例
import type { NotifyFn } from '../../domain/types.js';

export type ThreadSender = { send(options: unknown): Promise<unknown> };

/** Discord スレッドに対する NotifyFn を生成する */
export function createNotifier(thread: ThreadSender): NotifyFn {
  // Embed 形式で通知を送信する実装
}
```

```typescript
// adapters/slack/notifier.ts — ファクトリの例
import type { NotifyFn } from '../../domain/types.js';

/** Slack スレッドに対する NotifyFn を生成する */
export function createNotifier(client: WebClient, channelId: string, threadTs: string): NotifyFn {
  // Block Kit 形式で通知を送信する実装
}
```

ファクトリの呼び出しは各 Adapter の `client.ts` 内（セッション生成時）で行う。Composition Root はファクトリの存在を知る必要がない。

### 3.2 IPlatformClient — Bot クライアントポート

```typescript
// app/ports/bot.ts

export interface IPlatformClient {
  /** Bot を起動し、イベントリスニングを開始する */
  start(): Promise<void>;

  /** Bot を停止する */
  stop(): Promise<void>;
}
```

各プラットフォームの Client 初期化・イベント登録・シャットダウンを抽象化する。`index.ts` はこのインターフェースを通じて Bot を起動するだけになる。

### 3.3 SystemPromptProvider — システムプロンプトポート

```typescript
// app/ports/system-prompt.ts

/**
 * プラットフォームのマークダウン制約を含むシステムプロンプトを返す。
 * プロジェクト内の他のポート（NotifyFn, FetchFn, HandleMessageFn）と同様に関数型で定義する。
 */
export type SystemPromptProvider = () => string;
```

Discord はテーブル・画像禁止、Slack は mrkdwn 形式など、プラットフォームごとにマークダウンの制約が異なる。`ClaudeProcess` がこのポートを受け取り、`--append-system-prompt` に渡す。

### 3.4 ポートにしない判断

以下はプラットフォーム間で UI パラダイムが大きく異なるため、共通ポートを作らず各 Adapter 内で自由に実装する。

| 機能 | Discord | Slack | 共通化しない理由 |
|------|---------|-------|-----------------|
| セッション選択 UI | StringSelectMenu | モーダル or static_select | UI パラダイムが根本的に異なる |
| スレッド作成 | `channel.threads.create()` | メッセージの `thread_ts` | セマンティクスが異なる |
| コマンド定義 | SlashCommandBuilder | App Manifest | 登録方法が完全に異なる |
| 一時的な応答 | Ephemeral reply | `response_type: ephemeral` | API が異なる |

---

## 4. ディレクトリ構成

### 4.1 変更後の構成

```
server/src/
├── index.ts                          ← Composition Root（薄くなる）
│
├── app/
│   ├── ports/
│   │   ├── notifier.ts               ← INotifier（通知ポート）
│   │   ├── bot.ts                    ← IPlatformClient（Bot ポート）
│   │   └── system-prompt.ts          ← SystemPromptProvider
│   └── use-cases/
│       ├── handle-message.ts         ← メッセージ受信ユースケース
│       └── handle-command.ts         ← コマンド処理ユースケース
│
├── adapters/
│   └── discord/
│       ├── client.ts                 ← Discord Client 初期化・イベント登録
│       ├── notifier.ts              ← Embed 形式の通知（現 discord-notifier.ts）
│       ├── message-controller.ts     ← MessageCreate イベント処理
│       ├── interaction-controller.ts ← InteractionCreate イベント処理
│       ├── slash-commands.ts         ← SlashCommandBuilder 定義
│       └── system-prompt.ts          ← Discord 用マークダウン制約
│
├── domain/                           ← 変更なし
│   ├── types.ts
│   ├── orchestrator.ts
│   ├── session.ts
│   ├── session-manager.ts
│   └── access-control.ts
│
└── infrastructure/                   ← プラットフォーム非依存のみ残る
    ├── claude-process.ts             ← システムプロンプトを外部注入に変更
    ├── session-store.ts
    ├── usage-fetcher.ts
    ├── stream-json-parser.ts
    ├── attachment-resolver.ts
    └── config.ts                     ← プラットフォーム別の設定をサポート
```

### 4.2 Slack 追加時の差分

```
server/src/
├── adapters/
│   ├── discord/                      ← 既存、変更なし
│   └── slack/                        ← 新規追加
│       ├── client.ts                 ← Bolt.js 初期化・イベント登録
│       ├── notifier.ts              ← Block Kit 形式の通知
│       ├── message-controller.ts     ← message イベント処理
│       ├── command-handler.ts        ← スラッシュコマンド処理
│       └── system-prompt.ts          ← Slack 用マークダウン制約
```

App 層・Domain 層・Infrastructure 層は一切変更不要。

---

## 5. 各ファイルの変更内容

### 5.1 index.ts — Composition Root

現在約 390 行ある `index.ts` は、以下のみを担当する薄いエントリーポイントになる。

```typescript
// index.ts（変更後のイメージ）
import 'dotenv/config';
import { loadConfig } from './infrastructure/config.js';
import { createDiscordClient } from './adapters/discord/client.js';
// import { createSlackClient } from './adapters/slack/client.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // プラットフォームに応じた Client を生成
  const client = createDiscordClient(config);
  // const client = createSlackClient(config);

  await client.start();
}

main().catch(console.error);
```

### 5.2 adapters/discord/client.ts

現在の `index.ts` から Discord 固有の処理をすべて移動する。

**責務：**
- Discord.js Client の初期化・接続
- スラッシュコマンドの登録
- `MessageCreate` / `InteractionCreate` イベントの購読
- 各 Controller への委譲

**`createSession` ファクトリの配置について：**

現在 `index.ts` にある `createSession` は `ClaudeProcess`・`Orchestrator`・`Notifier` を組み立てる DI のワイヤリング処理であり、Adapter 層と Infrastructure 層の両方に依存する。これは本質的に **Composition Root** の責務であるため、`index.ts` ではなく `adapters/discord/client.ts` 内に配置する。

理由：
- `createSession` は Discord 固有の `Notifier`（Embed 形式）を生成するため、プラットフォーム非依存にはできない
- 各プラットフォームの `client.ts` が自身の Composition Root を兼ねることで、`index.ts` は `createDiscordClient(config)` を呼ぶだけで済む
- Slack 追加時は `adapters/slack/client.ts` 内に Slack 版の `createSession` を持つ

```typescript
// adapters/discord/client.ts 内のイメージ
function createSession(thread: TextChannel, config: Config): SessionContext {
  const notify = createNotifier(thread);              // Discord Adapter
  const systemPrompt = discordSystemPrompt;           // Discord Adapter
  const claudeProcess = new ClaudeProcess(..., systemPrompt); // Infrastructure
  const session = new Session(config.workDir);        // Domain
  const orchestrator = new Orchestrator(...);          // Domain
  return { orchestrator, session, claudeProcess, threadId: thread.id };
}
```

### 5.3 adapters/discord/notifier.ts

現在の `infrastructure/discord-notifier.ts` をそのまま移動する。

**変更点：**
- ファイルパスの変更のみ。ロジックは変更なし。
- `ThreadSender`, `EmbedData`, `SendOptions` もこのファイル内で定義する。

### 5.4 adapters/discord/interaction-controller.ts

現在の `index.ts` 内の `InteractionCreate` ハンドラ（約190行）を抽出する。

**責務：**
- `/cc new` — スレッド作成、セッション登録、ephemeral 応答
- `/cc interrupt` — スレッド内判定、セッション中断
- `/cc resume` — セッション一覧取得、セレクトメニュー構築、セッション再開

### 5.5 adapters/discord/message-controller.ts

現在の `index.ts` 内の `MessageCreate` ハンドラを抽出する。

**責務：**
- スレッド判定（`ChannelType.PublicThread` / `PrivateThread`）
- 親チャンネル ID の取得
- 添付ファイルの解決
- App 層のユースケースへの委譲

### 5.6 adapters/discord/slash-commands.ts

現在の `infrastructure/slash-commands.ts` をそのまま移動する。変更なし。

### 5.7 adapters/discord/system-prompt.ts

現在の `claude-process.ts` 内の `DISCORD_SYSTEM_PROMPT` 定数を移動する。

```typescript
// adapters/discord/system-prompt.ts
import type { SystemPromptProvider } from '../../app/ports/system-prompt.js';

export const discordSystemPrompt: SystemPromptProvider = () =>
  `回答のマークダウンはDiscordで表示されます。Discord互換の構文のみ使用してください。
使用可能: **太字** *斜体* ~~取り消し線~~ ...
使用禁止: テーブル(| |)、画像(![]()), HTMLタグ...
テーブルの代わりにリストやコードブロックで情報を整理してください。`;
```

### 5.8 infrastructure/claude-process.ts

**変更点：**
- `DISCORD_SYSTEM_PROMPT` をハードコードから外部注入に変更
- コンストラクタで `SystemPromptProvider` を受け取る

```typescript
// 変更前
const DISCORD_SYSTEM_PROMPT = `...`;

export class ClaudeProcess implements IClaudeProcess {
  constructor(
    private readonly claudePath: string,
    private readonly onProgress: ...,
    private readonly onProcessEnd: ...,
  ) {}
}

// 変更後
export class ClaudeProcess implements IClaudeProcess {
  constructor(
    private readonly claudePath: string,
    private readonly onProgress: ...,
    private readonly onProcessEnd: ...,
    private readonly systemPromptProvider: SystemPromptProvider,
    private readonly spawnFn: SpawnFn = nodeSpawn,
  ) {}
}
// 使用時: this.systemPromptProvider() で文字列を取得
```

### 5.9 app/use-cases/handle-message.ts

現在の `app/message-handler.ts` を移動・リネームする。

**変更点：**
- `DiscordMessage` → `IncomingMessage`（プラットフォーム非依存な名前に変更）
- ロジック自体は変更なし

```typescript
// app/use-cases/handle-message.ts
import type { AccessControl, MessageContext } from '../../domain/access-control.js';
import type { SessionManager } from '../../domain/session-manager.js';

export interface IncomingMessage extends MessageContext {
  content: string;
  threadId: string | null;
}

export type HandleMessageFn = (message: IncomingMessage) => void;

export function createHandleMessage(
  accessControl: AccessControl,
  sessionManager: SessionManager,
): HandleMessageFn {
  return (message: IncomingMessage): void => {
    if (!accessControl.check(message)) return;
    if (message.threadId === null) return;

    const ctx = sessionManager.get(message.threadId);
    if (ctx === null) return;

    ctx.orchestrator.handleMessage(message.content);
  };
}
```

### 5.10 app/use-cases/handle-command.ts

現在の `app/interaction-handler.ts` の `toCommand` 関数を移動する。

**変更点：**
- `InteractionContext` → `CommandInput`（プラットフォーム非依存な名前に変更）
- `toCommand` のロジックは変更なし

### 5.11 infrastructure/config.ts

**変更点：**
- プラットフォーム切替用の設定を追加
- プラットフォーム共通の設定と個別の設定を分離

```typescript
// 変更後のイメージ
export interface BaseConfig {
  channelId: string;
  allowedUserIds: string[];
  workDir: string;
  claudePath: string;
}

export interface DiscordConfig extends BaseConfig {
  platform: 'discord';
  discordToken: string;
}

export interface SlackConfig extends BaseConfig {
  platform: 'slack';
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
}

export type Config = DiscordConfig | SlackConfig;
```

---

## 6. Domain 層・Infrastructure 層の変更

### 6.1 Domain 層 — 変更なし

以下のファイルはプラットフォームに一切依存していないため、変更不要。

- `domain/types.ts` — `Notification`, `Command`, `NotifyFn` 等すべてプラットフォーム非依存
- `domain/orchestrator.ts` — 純粋な状態機械
- `domain/session.ts` — セッション ID 管理
- `domain/session-manager.ts` — `threadId`（文字列キー）による汎用的なセッション管理
- `domain/access-control.ts` — 汎用的な `MessageContext` による認可

### 6.2 Infrastructure 層 — 最小限の変更

| ファイル | 変更 |
|---------|------|
| `claude-process.ts` | `SystemPromptProvider` を外部注入に変更 |
| `session-store.ts` | 変更なし |
| `usage-fetcher.ts` | 変更なし |
| `stream-json-parser.ts` | 変更なし |
| `attachment-resolver.ts` | 変更なし（後述の注記参照） |
| `config.ts` | プラットフォーム別設定のサポート |

**`attachment-resolver.ts` について：**

現在の実装は独自の `Attachment` インターフェース（`contentType`, `name`, `size`, `url`）を定義しており、Discord.js の型には依存していない。Slack の添付ファイルも同じフィールドにマッピング可能であるため、Infrastructure 層に残して問題ない。各 Adapter の `message-controller.ts` が、プラットフォーム固有の添付ファイルオブジェクトをこのインターフェースに変換する責務を持つ。

---

## 7. Discord と Slack の対応関係

Adapter 実装時の参考として、主要概念の対応を示す。

| 概念 | Discord | Slack |
|------|---------|-------|
| Bot フレームワーク | discord.js | @slack/bolt |
| メッセージ送信 | `channel.send()` | `client.chat.postMessage()` |
| リッチメッセージ | Embed (色, description, footer) | Block Kit (section, context, divider) |
| スレッド | `channel.threads.create()` | `thread_ts` パラメータ |
| コマンド | Slash Commands (InteractionCreate) | Slash Commands (command イベント) |
| 選択 UI | StringSelectMenu | Block Kit の static_select / モーダル |
| 一時応答 | Ephemeral reply | `response_type: ephemeral` |
| 文字数制限 | 2000 (message) / 4096 (embed) | 40000 (message) / 3000 (block text) |
| マークダウン | Discord Markdown | mrkdwn (Slack 独自) |

---

## 8. 実装順序

### Phase 1: Adapter 層の分離（Discord のみ）

既存の動作を維持しつつ、アーキテクチャを再構成する。各ステップの完了時にテストを実行し、リグレッションがないことを確認する。

#### Step 1-1: ポート定義と App 層の整理（低リスク）

影響が小さく、既存コードに変更を加えない準備作業。

1. `app/ports/notifier.ts` — `INotifier` ポートの定義
2. `app/ports/bot.ts` — `IPlatformClient` ポートの定義
3. `app/ports/system-prompt.ts` — `SystemPromptProvider` 型の定義
4. `app/use-cases/handle-message.ts` — 既存 `app/message-handler.ts` を移動・リネーム（`DiscordMessage` → `IncomingMessage`）
5. `app/use-cases/handle-command.ts` — 既存 `app/interaction-handler.ts` を移動・リネーム
6. 既存テストを `app/use-cases/` 配下に移動

**完了条件：** 全テスト通過。既存の `app/message-handler.ts` 等への参照を更新済み。

#### Step 1-2: Infrastructure 層の Discord 非依存化（中リスク）

`infrastructure/` から Discord 固有の要素を除去する。

1. `infrastructure/claude-process.ts` — `DISCORD_SYSTEM_PROMPT` を削除し、`SystemPromptProvider` を外部注入に変更
2. `infrastructure/discord-notifier.ts` → `adapters/discord/notifier.ts` に移動
3. `infrastructure/slash-commands.ts` → `adapters/discord/slash-commands.ts` に移動
4. `infrastructure/config.ts` — プラットフォーム別設定構造に変更
5. 既存テストの修正（`claude-process.test.ts` のシステムプロンプト注入対応、移動したファイルのインポート修正）

**完了条件：** 全テスト通過。`infrastructure/` 内に Discord 固有ファイルが残っていないこと。

#### Step 1-3: index.ts からの Controller 抽出（高リスク・段階的に実施）

`index.ts`（約390行）の分割は最もリスクが高いため、以下の順で1ファイルずつ抽出する。

**Step 1-3a: system-prompt.ts の抽出**
1. `adapters/discord/system-prompt.ts` を作成（`DiscordSystemPrompt` の定義）
2. `index.ts` から `DISCORD_SYSTEM_PROMPT` への参照を削除（Step 1-2 で `claude-process.ts` からは削除済み）

**Step 1-3b: message-controller.ts の抽出**
1. `adapters/discord/message-controller.ts` を作成
2. `index.ts` の `MessageCreate` ハンドラを移動
3. `index.ts` からは `messageController.handle(message)` を呼ぶだけにする
4. テスト実行で動作確認

**Step 1-3c: interaction-controller.ts の抽出**
1. `adapters/discord/interaction-controller.ts` を作成
2. `index.ts` の `InteractionCreate` ハンドラ（約190行）を移動
3. テスト実行で動作確認

**Step 1-3d: client.ts への統合と index.ts の簡素化**
1. `adapters/discord/client.ts` を作成（`IPlatformClient` を実装）
2. `index.ts` に残っている Discord.js Client 初期化・イベント登録・`createSession` ファクトリを `client.ts` に移動
3. `index.ts` を Composition Root（約20行）に簡素化
4. 新規 Adapter 層テストの追加

**Phase 1 完了条件：** 既存のすべてのテストが通り、Discord での動作が変わらないこと。`index.ts` が Composition Root のみになっていること。

### Phase 2: Slack Adapter の追加

1. `adapters/slack/client.ts` — Bolt.js による Bot 初期化
2. `adapters/slack/notifier.ts` — Block Kit 形式の通知
3. `adapters/slack/message-controller.ts` — メッセージイベント処理
4. `adapters/slack/command-handler.ts` — スラッシュコマンド処理
5. `adapters/slack/system-prompt.ts` — Slack 用マークダウン制約
6. `infrastructure/config.ts` — Slack 設定の追加
7. `index.ts` — プラットフォーム切替の追加

---

## 9. テスト方針

### 9.1 現在のテスト資産の整理

現在のテストファイル一覧と、移行後の配置先を示す。

| 現在のパス | 移行先 | 作業 |
|-----------|--------|------|
| `app/message-handler.test.ts` | `app/use-cases/handle-message.test.ts` | 移動・リネーム。`DiscordMessage` → `IncomingMessage` に型名変更 |
| `app/interaction-handler.test.ts` | `app/use-cases/handle-command.test.ts` | 移動・リネーム |
| `infrastructure/discord-notifier.test.ts` | `adapters/discord/notifier.test.ts` | 移動。インポートパス修正のみ |
| `infrastructure/slash-commands.test.ts` | `adapters/discord/slash-commands.test.ts` | 移動。インポートパス修正のみ |
| `infrastructure/claude-process.test.ts` | そのまま | `SystemPromptProvider` の注入に対応する修正が必要 |
| `infrastructure/config.test.ts` | そのまま | プラットフォーム別設定構造に対応する修正が必要 |
| `index.test.ts`（410行） | 分割（後述） | 最も大きな変更が必要 |
| その他 Domain/Infrastructure テスト | そのまま | 変更なし |

### 9.2 index.test.ts の分割

現在の `index.test.ts`（410行）は統合テストとして以下の describe を含む。

- 「メッセージ → ClaudeCode → 結果通知」→ コンポーネント配線のテストとして `adapters/discord/client.test.ts` に移動
- 「途中経過のリアルタイム通知」→ 同上
- 「アクセス制御」→ `domain/access-control.test.ts` に既存テストがあるため、重複確認の上で統合または削除
- 「コマンド処理」→ `adapters/discord/interaction-controller.test.ts` に移動
- 「エラーハンドリング」→ `adapters/discord/client.test.ts` に移動
- 「並列セッション」→ 同上

分割後の `index.test.ts` は削除する（Composition Root は薄いためテスト不要）。

### 9.3 新規作成が必要なテスト

`index.ts` の `InteractionCreate` ハンドラ（約190行）と `MessageCreate` ハンドラは現在ユニットテストが存在しない。Adapter 層への抽出時に以下を新規作成する。

- **`adapters/discord/interaction-controller.test.ts`** — 主要なテストケース：
  - `/cc new` — スレッド作成と SessionContext 登録の検証
  - `/cc interrupt` — スレッド内判定、セッション中断呼び出しの検証
  - `/cc resume` — セッション一覧取得、セレクトメニュー構築の検証
  - 未知のサブコマンドへのエラー応答
  - Ephemeral 応答の検証

- **`adapters/discord/message-controller.test.ts`** — 主要なテストケース：
  - スレッド外メッセージの無視
  - 親チャンネル ID の正しい取得
  - 添付ファイルの `Attachment` インターフェースへの変換
  - App 層 `HandleMessageFn` への正しい委譲

### 9.4 Domain 層・Infrastructure 層のテスト

既存のテストをそのまま維持。以下のみ修正が必要。

- `claude-process.test.ts` — `SystemPromptProvider` の外部注入に対応（テスト内でモック関数を渡す）
- `config.test.ts` — プラットフォーム別設定構造のテスト追加

---

## 10. エッジケース

| ケース | 対処 |
|--------|------|
| 環境変数で不明なプラットフォームが指定された | 起動時にエラーメッセージを出して終了 |
| Discord と Slack を同時に起動したい | 将来的に対応可能だが、初期実装ではどちらか一方のみ |
| Slack の Rate Limit | Adapter 内で Bolt.js の組み込みリトライ機構を利用 |
| プラットフォーム間でセッションを共有したい | セッション ID は ClaudeCode の JSONL に依存するためプラットフォーム非依存。`/cc resume` で別プラットフォームからでも再開可能 |
| 複数チャンネルで運用したい | 現在は `channelId: string`（単一チャンネル）で、1チャンネル内のスレッドでセッションを管理する設計。複数チャンネル対応が必要になった場合は `channelIds: string[]` への変更と `AccessControl.check()` の修正のみで対応可能（局所的な変更）。初期実装では単一チャンネルを維持する |

---

## 11. 変更影響の概要

### 11.1 プロダクションコード

| 区分 | ファイル数 | 内容 |
|------|-----------|------|
| 新規作成 | 8 | `app/ports/` (3), `adapters/discord/` (5: client, notifier, message-ctrl, interaction-ctrl, system-prompt) |
| 移動・リネーム | 4 | `app/` (2: message-handler → use-cases/, interaction-handler → use-cases/), `infrastructure/` (2: discord-notifier → adapters/, slash-commands → adapters/) |
| 修正 | 3 | `claude-process.ts`（システムプロンプト外部注入）, `config.ts`（設定構造整理）, `index.ts`（Composition Root 簡素化） |
| 変更なし | 8 | `domain/` 全体 (5), `session-store.ts`, `usage-fetcher.ts`, `stream-json-parser.ts`, `attachment-resolver.ts` |

### 11.2 テストコード

| 区分 | ファイル数 | 内容 |
|------|-----------|------|
| 新規作成 | 3 | `adapters/discord/` (interaction-controller.test, message-controller.test, client.test) |
| 移動・リネーム | 4 | `app/` (2: message-handler.test → use-cases/, interaction-handler.test → use-cases/), `infrastructure/` (2: discord-notifier.test → adapters/, slash-commands.test → adapters/) |
| 修正 | 2 | `claude-process.test.ts`（SystemPromptProvider 注入対応）, `config.test.ts`（設定構造対応） |
| 分割・削除 | 1 | `index.test.ts`（410行）→ 各 Adapter テストに分割後、削除 |
| 変更なし | 6 | `domain/` 全体 (4: access-control, orchestrator, session, session-manager), `session-store.test.ts`, `attachment-resolver.test.ts` |
