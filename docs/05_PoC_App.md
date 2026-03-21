> **注意**: このドキュメントは PoC 設計時に作成されたものです。テキストコマンド（`!new` 等）はスラッシュコマンド（`/cc new` 等）に置き換えられるなど、現在の実装とは異なる部分があります。最新の使い方は [README.md](../README.md) を参照してください。

# App層の設計：claude-discord-bridge PoC

**スコープ: PoC（概念実証）範囲のみ**

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計（背景・目標・技術決定）
- `02_PoC_Plan.md` — PoC の範囲と完了条件
- `03_PoC_DomainModel.md` — ドメインモデルの詳細仕様
- `04_PoC_Infrastructure.md` — インフラストラクチャ層の設計

**本ドキュメントの位置づけ：** ドメイン層とインフラストラクチャ層の間に位置する App 層を定義する。Discord のメッセージイベントからドメイン層の Orchestrator へのルーティングを、テスト可能な形で分離する。

---

## 1. App層の役割

### 1.1 3層構成における位置づけ

本プロジェクトは **ドメイン層**・**インフラストラクチャ層** に加え、**App 層** の 3 層で構成される。

| 層 | 責務 | 具体例 |
|----|------|--------|
| **ドメイン層** | ビジネスロジック。状態遷移・コマンド解釈・アクセス制御の判定ルール | Orchestrator, Session, AccessControl, Command |
| **App 層** | メッセージルーティング。外部イベントをドメイン層に橋渡しする | MessageHandler |
| **インフラストラクチャ層** | 外部システムとの通信。ドメインが定義したインターフェースの実装 | ClaudeProcess, DiscordNotifier, StreamJsonParser, Config |

**依存関係：**

```
index.ts（コンポジションルート）
  └─ imports: App 層, ドメイン層, インフラストラクチャ層

App 層
  └─ imports: ドメイン層のみ（AccessControl, Orchestrator）

インフラストラクチャ層
  └─ imports: ドメイン層のみ（IClaudeProcess, Notification 等）

ドメイン層
  └─ imports: なし（外部依存なし）
```

App 層はドメイン層にのみ依存し、インフラストラクチャ層には依存しない。Discord.js などの外部ライブラリへの直接依存も持たない。

### 1.2 なぜ App 層が必要か

`04_PoC_Infrastructure.md` Section 3.5 では、メッセージルーティングのロジック（Bot 判定 → アクセス制御 → Orchestrator 委譲）を `index.ts`（コンポジションルート）内に直接記述する設計としていた。しかし、コンポジションルートは配線のみに専念すべきであり、ルーティングロジックを分離することで以下の利点が得られる。

| 観点 | コンポジションルート内に記述 | App 層に分離 |
|------|---------------------------|-------------|
| テスト可能性 | Discord.js の Client が必要（テスト困難） | Discord.js 不要（モックなしでテスト可能） |
| 責務の明確化 | 配線 + ルーティングが混在 | 配線はコンポジションルート、ルーティングは App 層 |
| 変更の影響範囲 | ルーティング変更時に `index.ts` を編集 | `message-handler.ts` のみの変更で済む |

### 1.3 App 層が埋める責務

`03_PoC_DomainModel.md` Section 5.1 で定義された handleMessage() フローの最初の 2 ステップを担う。

```
Discord メッセージ受信
    │
    ▼
[Bot 判定] ── Bot のメッセージ → 無視        ← App 層が担当
    │ 人間のメッセージ
    ▼
[AccessControl] ── 拒否 → 無視（応答なし）   ← App 層が担当
    │ 許可
    ▼
[Orchestrator.handleMessage(text)]           ← ドメイン層に委譲
```

> **補足：** `AccessControl.check()` は Bot 判定（`authorBot` チェック）を内包しているため（`src/domain/access-control.ts`）、App 層は `AccessControl.check()` を 1 回呼ぶだけで Bot 判定とアクセス制御の両方を完了できる。

---

## 2. ファイル構成

```
server/src/
├── domain/                               # ドメイン層（変更なし）
│   ├── types.ts
│   ├── command.ts
│   ├── session.ts
│   ├── access-control.ts
│   ├── orchestrator.ts
│   └── *.test.ts
│
├── app/                                  # App 層（新規作成）
│   ├── message-handler.ts               #   メッセージルーティング
│   └── message-handler.test.ts          #   ユニットテスト
│
├── infrastructure/                       # インフラストラクチャ層（変更なし）
│   ├── config.ts
│   ├── stream-json-parser.ts
│   ├── claude-process.ts
│   ├── discord-notifier.ts
│   └── *.test.ts
│
└── index.ts                              # コンポジションルート（別タスクで実装）
```

---

## 3. MessageHandler の設計

### 3.1 公開インターフェース

```typescript
import type { MessageContext } from '../domain/access-control.js';
import type { AccessControl } from '../domain/access-control.js';
import type { Orchestrator } from '../domain/orchestrator.js';

export interface DiscordMessage extends MessageContext {
  content: string;
}

export type MessageHandlerFn = (message: DiscordMessage) => void;

export function createMessageHandler(
  accessControl: AccessControl,
  orchestrator: Orchestrator,
): MessageHandlerFn;
```

**DiscordMessage：**

ドメイン層で定義済みの `MessageContext`（`src/domain/access-control.ts`）を拡張し、メッセージ本文 `content` を追加したインターフェース。

| フィールド | 型 | 由来 |
|-----------|-----|------|
| `authorBot` | `boolean` | `MessageContext` から継承 |
| `authorId` | `string` | `MessageContext` から継承 |
| `channelId` | `string` | `MessageContext` から継承 |
| `content` | `string` | `DiscordMessage` で追加 |

**createMessageHandler：**

`AccessControl` と `Orchestrator` を受け取り、メッセージルーティング関数を返すファクトリ関数。

### 3.2 実装

```typescript
export function createMessageHandler(
  accessControl: AccessControl,
  orchestrator: Orchestrator,
): MessageHandlerFn {
  return (message: DiscordMessage): void => {
    if (!accessControl.check(message)) {
      return;
    }
    orchestrator.handleMessage(message.content);
  };
}
```

### 3.3 設計判断

| 項目 | 判断 | 理由 |
|------|------|------|
| 構造 | クラスではなくファクトリ関数 | ステートレスなルーティングのみ。`createNotifier`（`infrastructure/discord-notifier.ts`）と同パターン |
| `DiscordMessage` の設計 | `MessageContext` を `extends` で拡張 | `AccessControl.check()` に直接渡せる（構造的部分型により `DiscordMessage` は `MessageContext` を満たす） |
| Discord.js への依存 | なし | `DiscordMessage` は最小インターフェース。Discord.js `Message` → `DiscordMessage` の変換はコンポジションルートが担う |
| Bot 判定の実装 | 個別の判定なし | `AccessControl.check()` が `authorBot` チェックを内包しているため、重複した判定は不要 |
| 拒否時の振る舞い | 応答なし（`return`） | `03_PoC_DomainModel.md` Section 3.3 の仕様通り。許可されないメッセージは一切の応答なく無視する |

### 3.4 メッセージ処理フロー

```
[Discord messageCreate イベント]
    │
    │  コンポジションルート（index.ts）が
    │  Discord.js Message → DiscordMessage に変換
    ▼
[MessageHandlerFn(message)]
    │
    ├─ accessControl.check(message)
    │      ├─ false（Bot / 未許可ユーザー / 別チャンネル）→ return（無視）
    │      └─ true
    │
    ▼
[orchestrator.handleMessage(message.content)]
    │
    └─ 以降はドメイン層の処理フロー
       （03_PoC_DomainModel.md Section 5.1 参照）
```

### 3.5 コンポジションルートでの使用イメージ

App 層自体は Discord.js に依存しないが、コンポジションルートで以下のように接続される。

```typescript
import { createMessageHandler } from './app/message-handler.js';

// ... コンポーネント生成後 ...

const handleMessage = createMessageHandler(accessControl, orchestrator);

client.on('messageCreate', (msg) => {
  handleMessage({
    authorBot: msg.author.bot,
    authorId: msg.author.id,
    channelId: msg.channelId,
    content: msg.content,
  });
});
```

Discord.js の `Message` オブジェクトから `DiscordMessage` への変換はコンポジションルート内のアロー関数が担い、App 層は変換済みのデータのみを受け取る。

---

## 4. テスト方針

### 4.1 テスト構成

App 層のテストでは、ドメイン層のオブジェクトを**実オブジェクト**として使用する。外部依存を持つのは `IClaudeProcess` のみであり、これだけをモックする。

```
テストコード
  ├─ AccessControl        ← 実オブジェクト（軽量・副作用なし）
  ├─ Orchestrator          ← 実オブジェクト
  │      ├─ Session        ← 実オブジェクト
  │      ├─ IClaudeProcess ← モック（spawn/interrupt の呼び出しを記録）
  │      └─ NotifyFn       ← 通知を配列に記録するスパイ
  └─ createMessageHandler  ← テスト対象
```

この構成により、メッセージルーティングからドメインロジックまでを統合的に検証でき、かつ外部プロセスへの依存を排除できる。

### 4.2 テストケース

| テストケース | 入力 | 期待される結果 |
|-------------|------|---------------|
| Bot のメッセージは無視される | `authorBot: true`, 有効なユーザー・チャンネル | `spawn` が呼ばれない、通知なし |
| 許可されていないユーザーは無視される | `authorBot: false`, `authorId: 'unknown'` | `spawn` が呼ばれない、通知なし |
| 異なるチャンネルは無視される | `authorBot: false`, `channelId: 'wrong'` | `spawn` が呼ばれない、通知なし |
| 許可されたメッセージは Orchestrator に渡される | 有効なユーザー・チャンネル、`content: 'hello'` | `spawn` が呼ばれ、prompt が `'hello'` |
| コマンドも正しく委譲される | 有効なメッセージ、`content: '!interrupt'` | `interrupt()` が呼ばれる |
| 複数メッセージが順番に処理される | 2つの有効なメッセージを送信（間にプロセス終了） | `spawn` が 2 回呼ばれる |
