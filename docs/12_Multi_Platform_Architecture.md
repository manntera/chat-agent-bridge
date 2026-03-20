# マルチプラットフォーム対応アーキテクチャ設計

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `09_Parallel_Sessions.md` — 並列セッション機能（スレッドベース設計）

**本ドキュメントの位置づけ：** 現在 Discord 専用であるシステムを、Slack 等の他プラットフォームにも対応できるアーキテクチャに再構成する設計。

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

### 3.3 ISystemPromptProvider — システムプロンプトポート

```typescript
// app/ports/system-prompt.ts

export interface ISystemPromptProvider {
  /** プラットフォームのマークダウン制約を含むシステムプロンプトを返す */
  getSystemPrompt(): string;
}
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
│   │   └── system-prompt.ts          ← ISystemPromptProvider
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
- セッションファクトリ（`createSession`）の構築
- 各 Controller への委譲

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
import type { ISystemPromptProvider } from '../../app/ports/system-prompt.js';

export class DiscordSystemPrompt implements ISystemPromptProvider {
  getSystemPrompt(): string {
    return `回答のマークダウンはDiscordで表示されます。Discord互換の構文のみ使用してください。
使用可能: **太字** *斜体* ~~取り消し線~~ ...
使用禁止: テーブル(| |)、画像(![]()), HTMLタグ...
テーブルの代わりにリストやコードブロックで情報を整理してください。`;
  }
}
```

### 5.8 infrastructure/claude-process.ts

**変更点：**
- `DISCORD_SYSTEM_PROMPT` をハードコードから外部注入に変更
- コンストラクタで `ISystemPromptProvider` を受け取る

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
    private readonly systemPromptProvider: ISystemPromptProvider,
    private readonly spawnFn: SpawnFn = nodeSpawn,
  ) {}
}
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
| `claude-process.ts` | `ISystemPromptProvider` を外部注入に変更 |
| `session-store.ts` | 変更なし |
| `usage-fetcher.ts` | 変更なし |
| `stream-json-parser.ts` | 変更なし |
| `attachment-resolver.ts` | 変更なし |
| `config.ts` | プラットフォーム別設定のサポート |

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

既存の動作を維持しつつ、アーキテクチャを再構成する。

1. `app/ports/` — ポートインターフェースの定義
2. `app/use-cases/` — 既存の `app/` ファイルを移動・リネーム
3. `adapters/discord/` — `index.ts` と `infrastructure/` から Discord 固有コードを移動
4. `infrastructure/claude-process.ts` — システムプロンプトの外部注入化
5. `infrastructure/config.ts` — 設定構造の整理
6. `index.ts` — Composition Root の簡素化
7. テストの移動・修正

**Phase 1 完了時の確認：** 既存のすべてのテストが通り、Discord での動作が変わらないこと。

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

### 9.1 Adapter 層のテスト

各プラットフォーム Adapter は、プラットフォーム SDK のモックを使ってテストする。

- `adapters/discord/notifier.test.ts` — ThreadSender モックで Embed 形式を検証（現在の `discord-notifier.test.ts` を移動）
- `adapters/discord/interaction-controller.test.ts` — Interaction モックでコマンド処理を検証
- `adapters/discord/message-controller.test.ts` — Message モックでルーティングを検証

### 9.2 App 層のテスト

ユースケースはプラットフォーム非依存のため、シンプルなユニットテストで検証する。

- `app/use-cases/handle-message.test.ts` — 現在の `message-handler.test.ts` を移動
- `app/use-cases/handle-command.test.ts` — 現在の `interaction-handler.test.ts` を移動

### 9.3 Domain 層・Infrastructure 層のテスト

既存のテストをそのまま維持。変更なし（`claude-process.test.ts` のみシステムプロンプト注入の変更に対応）。

---

## 10. エッジケース

| ケース | 対処 |
|--------|------|
| 環境変数で不明なプラットフォームが指定された | 起動時にエラーメッセージを出して終了 |
| Discord と Slack を同時に起動したい | 将来的に対応可能だが、初期実装ではどちらか一方のみ |
| Slack の Rate Limit | Adapter 内で Bolt.js の組み込みリトライ機構を利用 |
| プラットフォーム間でセッションを共有したい | セッション ID は ClaudeCode の JSONL に依存するためプラットフォーム非依存。`/cc resume` で別プラットフォームからでも再開可能 |

---

## 11. 変更影響の概要

| 区分 | ファイル数 | 内容 |
|------|-----------|------|
| 新規作成 | 8 | `app/ports/` (3), `adapters/discord/` (5: client, notifier, message-ctrl, interaction-ctrl, system-prompt) |
| 移動・リネーム | 4 | `app/` (2: message-handler → use-cases/, interaction-handler → use-cases/), `infrastructure/` (2: discord-notifier → adapters/, slash-commands → adapters/) |
| 修正 | 3 | `claude-process.ts`（システムプロンプト外部注入）, `config.ts`（設定構造整理）, `index.ts`（Composition Root 簡素化） |
| 変更なし | 8 | `domain/` 全体 (5), `session-store.ts`, `usage-fetcher.ts`, `stream-json-parser.ts`, `attachment-resolver.ts` |
