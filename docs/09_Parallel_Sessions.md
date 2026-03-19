# 並列セッション機能の設計

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計（Forum ベースの並列セッションを構想）
- `07_PoC_Improvements.md` — PoC ブラッシュアップ記録
- `08_Resume_Session.md` — 過去セッション再開機能

**本ドキュメントの位置づけ：** PoC の単一セッション・TextChannel 構成から、スレッドベースの並列セッション構成への移行を設計する。

---

## 1. 概要

### 1.1 現状の課題

現在のシステムは単一の `Orchestrator` インスタンスで 1 セッションのみを管理しており、`busy` 状態では新しいプロンプトを「処理中です」と拒否する。複数の作業を並行して進めることができない。

### 1.2 方針

Discord のスレッドをセッションの入れ物として使い、各スレッドに独立した `Orchestrator / Session / ClaudeProcess` を割り当てることで並列実行を実現する。

結果メッセージには **Embed** を使用し、途中経過（プレーンテキスト）と最終結果（Embed）を視覚的に区別する。

### 1.3 スレッドベースを選択する理由

`01_SystemDesign.md` では Forum チャンネルが構想されているが、以下の理由から現段階ではスレッドベースで実装する。

- 現在の TextChannel 構成からの変更が最小限
- コアの設計（`Map<threadId, Orchestrator>`）は Forum でも同一であり、後から Forum への移行が容易
- Forum 固有の UX（タグ、ソート、ピン留め）は並列化の本質ではなく、後から追加できる

---

## 2. ユーザー体験

### 2.1 セッション開始

```
User: /cc new [model] [effort]

Bot: （チャンネルに）スレッド「Session: abc12345 (opus, max)」を作成
     スレッド内に初期メッセージを投稿:
     「セッションを開始しました [abc12345] (model: opus, effort: max)」
```

### 2.2 プロンプト送信（スレッド内）

```
User: (スレッド内で) テスト追加して

Bot: (スレッド内・プレーンテキスト)
     📨 受信しました。処理を開始します...
     🔧 Read: src/index.ts
     💭 テストケースを検討中...
     🔧 Write: src/index.test.ts

Bot: (スレッド内・Embed)
     ┌─ 🟢 ──────────────────────────────────┐
     │ テストファイルを作成しました。          │
     │ 3 件のテストケースを追加し、すべて...   │
     │                                        │
     │ 📊 5h 45% | 7d 30%                     │
     └────────────────────────────────────────┘
```

### 2.3 会話の継続（同一スレッド内）

```
User: (同じスレッド内で) エラーハンドリングも追加して

Bot: (スレッド内・プレーンテキスト)
     📨 受信しました。処理を開始します...
     ...

Bot: (スレッド内・Embed)
     ┌─ 🟢 ──────────────────────────────────┐
     │ エラーハンドリングを追加しました。      │
     └────────────────────────────────────────┘
```

### 2.4 並列作業

```
スレッド A: Session abc12345 — busy（テスト追加中）
スレッド B: Session def67890 — idle ← ユーザーはこちらにメッセージ送信可能
スレッド C: Session ghi11111 — busy（リファクタリング中）
```

ユーザーは Discord のスレッド一覧から任意のスレッドに移動し、独立して操作できる。

### 2.5 中断

```
User: (スレッド内で) /cc interrupt

Bot: (そのスレッドのセッションを中断)
     中断しました
```

`/cc interrupt` はスレッド内で実行した場合、そのスレッドのセッションのみを中断する。

### 2.6 過去セッション再開

```
User: /cc resume

Bot: (ephemeral) セッション選択ドロップダウンを表示

User: セッションを選択

Bot: チャンネルにスレッドを作成（新規セッション開始と同様）
     スレッド内: 「セッションを再開しました [abc12345]」
```

---

## 3. 設計

### 3.1 セッションマネージャ（新規）

スレッド ID をキーとしてセッションコンテキストを管理する。

```typescript
interface SessionContext {
  orchestrator: Orchestrator;
  session: Session;
  claudeProcess: ClaudeProcess;
  threadId: string;
}

class SessionManager {
  private sessions = new Map<string, SessionContext>();

  /** スレッドに紐づくセッションを取得（なければ null） */
  get(threadId: string): SessionContext | null;

  /** 新しいセッションを作成しスレッドに紐づける */
  create(threadId: string, workDir: string, options: SessionOptions): SessionContext;

  /** 過去セッションを復元しスレッドに紐づける */
  restore(threadId: string, workDir: string, sessionId: string): SessionContext;

  /** セッションを削除（リソース解放） */
  remove(threadId: string): void;
}
```

### 3.2 通知の変更

現在の通知先:

| 通知種別 | 現在の送信先 | 変更後の送信先 |
|---------|------------|--------------|
| `progress` | スレッド（途中経過用） | セッションスレッド（プレーンテキスト） |
| `result` | チャンネル直接 | セッションスレッド（**Embed**） |
| `error` | チャンネル直接 | セッションスレッド（**Embed、赤色**） |
| `info` | チャンネル直接 | セッションスレッド（プレーンテキスト） |
| `usage` | スレッド | セッションスレッド（Embed のフッターに統合） |

すべての通知がセッションスレッド内に送信されるようになる。結果と途中経過の区別は Embed の視覚的な違いで実現する。

### 3.3 Embed フォーマット

```typescript
import { EmbedBuilder } from 'discord.js';

// 成功結果
new EmbedBuilder()
  .setColor(0x00c853)  // 緑
  .setDescription(resultText)
  .setFooter({ text: '📊 5h 45% | 7d 30%' });

// エラー結果
new EmbedBuilder()
  .setColor(0xff1744)  // 赤
  .setTitle(`エラー (exit ${exitCode})`)
  .setDescription(errorMessage);
```

### 3.4 Notifier の変更

現在の `createNotifier` はチャンネルに送信し、途中経過のみスレッドに送る。変更後はスレッドを直接受け取り、すべてスレッド内に送信する。

```typescript
// 変更前
function createNotifier(channel: ChannelSender): NotifyFn & { setThreadOrigin(...) };

// 変更後
function createNotifier(thread: ThreadSender): NotifyFn;
```

`setThreadOrigin` / `ensureThread` / `archiveThread` のスレッド管理ロジックは不要になる。セッションスレッドは `SessionManager` が作成・管理するため、Notifier は渡されたスレッドに送信するだけのシンプルな関数になる。

### 3.5 メッセージルーティング

メッセージの送信元がスレッドかチャンネルかでルーティングが変わる。

```
メッセージ受信
  │
  ├─ チャンネル直接 → 無視（セッションスレッド内でのみ操作可能）
  │
  └─ スレッド内
       │
       ├─ SessionManager に登録済み → そのセッションの orchestrator.handleMessage()
       │
       └─ 未登録 → 無視（Bot が作成したスレッドではない）
```

### 3.6 スラッシュコマンドの変更

| コマンド | 変更内容 |
|---------|---------|
| `/cc new` | スレッドを作成し、SessionManager に登録。ephemeral で「スレッドを作成しました」と応答 |
| `/cc interrupt` | スレッド内で実行: そのスレッドのセッションを中断。チャンネルで実行: 「スレッド内で実行してください」 |
| `/cc resume` | セッション選択後、スレッドを作成して SessionManager に登録 |

### 3.7 状態遷移の変更

Orchestrator 自体の状態遷移は変更なし。各スレッドが独立した Orchestrator を持つため、あるスレッドが `busy` でも他のスレッドには影響しない。

`initial` 状態は不要になる可能性がある。SessionManager がスレッド作成時に `Session.ensure()` まで完了させるため、Orchestrator は常に `idle` から開始する。

---

## 4. 変更一覧

### 4.1 新規ファイル

#### `domain/session-manager.ts`

`Map<threadId, SessionContext>` の管理。セッションの作成・取得・削除。

### 4.2 変更ファイル

#### `domain/types.ts`

- `Notification` の `result` と `error` に Embed 情報を含める（または Notifier 側で判断）

#### `infrastructure/discord-notifier.ts`

- `createNotifier(thread: ThreadSender)` に簡略化
- `result` → Embed で送信
- `error` → 赤色 Embed で送信
- `usage` → 結果 Embed のフッターに統合
- `setThreadOrigin` / `ensureThread` / `archiveThread` を削除

#### `infrastructure/discord-notifier.ts` のインターフェース変更

```typescript
// 変更前
export interface ThreadSender {
  send(content: string): Promise<unknown>;
  setArchived(archived: boolean): Promise<unknown>;
}

// 変更後
export interface ThreadSender {
  send(content: string): Promise<unknown>;
  send(options: { embeds: EmbedLike[] }): Promise<unknown>;
}
```

#### `index.ts`

- 単一 `Orchestrator` → `SessionManager` に置き換え
- `MessageCreate` イベント: スレッド判定 → SessionManager からセッション取得 → orchestrator.handleMessage()
- `InteractionCreate` イベント: `/cc new` でスレッド作成、`/cc interrupt` でスレッド内判定
- チャンネル直接のメッセージは無視

#### `app/message-handler.ts`

- チャンネル ID の代わりにスレッド ID で AccessControl を行う（または AccessControl の対象をスレッドの親チャンネルに変更）

### 4.3 削除される概念

- `setThreadOrigin`: スレッドの動的作成が不要に
- `archiveThread`: セッションスレッドは残し続ける（ユーザーが会話を続けられるようにする）
- チャンネル直接への `result` / `error` / `info` 送信

---

## 5. Embed の 2000 文字制限への対応

Discord の Embed の `description` フィールドも 4096 文字が上限。ただし、Claude の出力が長い場合を考慮して:

- 4096 文字以内: 1 つの Embed に収める
- 4096 文字超: 本文をプレーンテキストで分割送信し、最後に結果 Embed（フッターに利用状況のみ）を付与

---

## 6. リソース管理

### 6.1 同時実行数

claude CLI プロセスの同時実行数に制限を設けるか検討が必要。

- 案 A: 制限なし（マシンリソース次第）
- 案 B: 最大 N セッション（`busy` 状態のセッション数で制限）

初期実装は制限なし（案 A）とし、問題が発生した場合に制限を追加する。

### 6.2 セッションの後片付け

`SessionManager` は Map でセッションを保持するため、メモリリークに注意が必要。

- プロセス終了後もセッションは `idle` として残す（会話継続のため）
- Bot 再起動時は Map がクリアされる（再開は `/cc resume` で可能）
- 将来的に: 一定時間 `idle` のセッションを自動削除する TTL 機能

---

## 7. エッジケース

| ケース | 対処 |
|--------|------|
| Bot が作成していないスレッドでのメッセージ | 無視（SessionManager に登録がないため） |
| チャンネル直接でのテキストメッセージ | 無視 |
| `/cc interrupt` をチャンネルで実行 | 「スレッド内で実行してください」 |
| スレッド内で `/cc new` を実行 | 新しいスレッドを作成（現在のスレッドのセッションには影響しない） |
| 同時に多数のプロセスを起動 | 初期は制限なし。リソース不足時はプロセス起動失敗として通知 |
| Bot 再起動後にスレッドにメッセージ | SessionManager に登録がないため無視。`/cc resume` で再開可能 |

---

## 8. テスト方針

### 8.1 ドメイン層

**`session-manager.test.ts`（新規）:**

- `create()` でセッションコンテキストが作成される
- `get()` で threadId に紐づくコンテキストが取得できる
- 存在しない threadId では `null` が返る
- `remove()` でセッションが削除される
- `restore()` で過去セッションが復元される

### 8.2 インフラストラクチャ層

**`discord-notifier.test.ts`（変更）:**

- `result` 通知で Embed が送信される
- `error` 通知で赤色 Embed が送信される
- `usage` が結果 Embed のフッターに含まれる
- `progress` はプレーンテキストで送信される
- 4096 文字超の結果で分割送信される

### 8.3 統合

**`index.test.ts`（変更）:**

- `/cc new` でスレッドが作成され、SessionManager に登録される
- スレッド内メッセージが正しいセッションにルーティングされる
- チャンネル直接メッセージが無視される
- 複数スレッドで並列にプロンプトを処理できる

---

## 9. 実装順序

1. `domain/session-manager.ts` + テスト — セッションの Map 管理
2. `infrastructure/discord-notifier.ts` + テスト — Embed 対応、スレッド直接送信に簡略化
3. `index.ts` — SessionManager の導入、メッセージルーティング変更
4. `app/message-handler.ts` — スレッドベースのルーティング対応
5. スラッシュコマンドの動作変更（`/cc new` でスレッド作成、`/cc interrupt` のスレッド内制限）
6. `/cc resume` のスレッド作成対応

---

## 10. Forum への将来的な移行

本設計のコア（`Map<threadId, SessionContext>`）は Forum チャンネルでもそのまま使える。Forum への移行時の変更は:

- TextChannel → ForumChannel に変更
- `/cc new` でスレッド作成 → Forum 投稿作成に変更
- Forum 固有の機能（タグ、ソート）の追加

並列セッションの実装とは独立した変更であり、別ドキュメントで設計する。
