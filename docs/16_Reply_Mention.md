# AI 回答時のメンション機能

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `07_PoC_Improvements.md` — PoC ブラッシュアップ記録（通知機能の現状）

**本ドキュメントの位置づけ：** AI の回答をスレッドに送信する際、質問者へのメンションを付与する機能の設計。

---

## 1. 概要

### 1.1 現状

現在、AI の回答（`result` 通知）はスレッドにプレーンテキストまたは Embed として送信されるが、誰に対する回答なのかが明示されない。

スレッドに複数人が参加している場合、回答がどのメッセージに対するものか分かりにくい。

### 1.2 ゴール

AI の回答送信時に、質問した Discord ユーザーへのメンション（`<@userId>`）を含めることで、回答の宛先を明確にする。

---

## 2. 現在のメッセージフロー

```
Discord MessageCreate (msg.author.id を含む)
  ↓
index.ts → handleMessage({ authorId, content, ... })
  ↓
message-handler.ts → ctx.orchestrator.handleMessage(content)  ※ authorId は渡されない
  ↓
orchestrator.ts → notify({ type: 'result', text })
  ↓
discord-notifier.ts → thread.send(embed)  ※ メンションなし
```

**問題点：** `msg.author.id` は `index.ts` の `MessageCreate` ハンドラ内で取得できるが、`Orchestrator` や `createNotifier` には渡されていない。

---

## 3. 設計

### 3.1 方針

Notifier に「現在の質問者」を設定する仕組みを追加する。result / error の送信時にメンションを先頭に付与する。

Domain 層（`Orchestrator`, `types.ts`）は変更しない。メンションは Discord 固有の表現であり、Infrastructure 層（`discord-notifier.ts`）と接続部分（`index.ts`）の変更に閉じる。

### 3.2 `createNotifier` の変更

`createNotifier` の戻り値を、通知関数と `setAuthorId` メソッドを持つオブジェクトに変更する。

```typescript
// 変更前
export function createNotifier(thread: ThreadSender): NotifyFn { ... }

// 変更後
export interface Notifier {
  notify: NotifyFn;
  setAuthorId(authorId: string): void;
}

export function createNotifier(thread: ThreadSender): Notifier { ... }
```

内部状態として `currentAuthorId: string | null` を保持する。

### 3.3 メンションの付与タイミング

| 通知種別 | メンション | 理由 |
|---------|-----------|------|
| `progress` (started / tool_use / thinking) | なし | 途中経過は情報提供のみ。メンションすると通知が煩雑 |
| `info` | なし | システムメッセージ（セッション開始等）であり、特定ユーザーへの返答ではない |
| `result` | あり | AI の回答本文。質問者へ通知が必要 |
| `error` | あり | エラーも質問者に伝える必要がある |

### 3.4 メンション文字列の挿入位置

- **Embed 送信**（`result` / `error`）: Embed と同時に `content` フィールドでメンションを送信

```typescript
// Embed + メンション
thread.send({
  content: `<@${currentAuthorId}>`,
  embeds: [embed],
});
```

Embed の `description` 内にメンションを埋め込む方式もあるが、`content` として送る方が Discord の通知（プッシュ通知・未読バッジ）を確実にトリガーできる。

### 3.5 `SendOptions` の拡張

現在の `SendOptions` は `embeds` のみだが、`content` フィールドを追加する。

```typescript
// 変更前
export interface SendOptions {
  embeds: EmbedData[];
}

// 変更後
export interface SendOptions {
  content?: string;
  embeds: EmbedData[];
}
```

### 3.6 `index.ts` の変更

`MessageCreate` ハンドラ内で、メッセージ受信時に `notifier.setAuthorId(msg.author.id)` を呼ぶ。

```typescript
// メッセージ受信時
const ctx = sessionManager.get(msg.channelId);
if (ctx) {
  ctx.notifier.setAuthorId(msg.author.id);
}
handleMessage({ ... });
```

`SessionContext` に `notifier` への参照を追加する必要がある。

---

## 4. 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `infrastructure/discord-notifier.ts` | `Notifier` インターフェース追加、`setAuthorId` / メンション付与ロジック実装、`SendOptions` に `content` 追加 |
| `domain/session-manager.ts` | `SessionContext` に `notifier` フィールドを追加（型: `{ setAuthorId(id: string): void }`） |
| `index.ts` | `createSession` 内で notifier を `SessionContext` に保持、`MessageCreate` ハンドラで `setAuthorId` を呼び出し |

**変更しないファイル:**

| ファイル | 理由 |
|---------|------|
| `domain/types.ts` | メンションは Discord 固有の概念。Domain 層の `Notification` 型に `authorId` を持たせない |
| `domain/orchestrator.ts` | プラットフォーム非依存を維持 |
| `app/message-handler.ts` | メンション設定は `index.ts` で直接行うため、App 層は変更不要 |

---

## 5. 長文結果の分割送信時の挙動

現在、結果テキストが `EMBED_MAX_LENGTH`（4096文字）を超える場合、複数メッセージに分割して送信される。

メンションは **最初のメッセージにのみ** 付与する。複数回メンションすると通知が重複して煩雑になるため。

```typescript
// 長文分割時
const chunks = splitMessage(result.text);
for (let i = 0; i < chunks.length; i++) {
  if (i === 0 && currentAuthorId) {
    sendText(`<@${currentAuthorId}> ${chunks[i]}`);
  } else {
    sendText(chunks[i]);
  }
}
```
