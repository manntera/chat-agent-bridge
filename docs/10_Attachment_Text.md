# テキスト添付ファイル対応の設計

**前提ドキュメント:**

- `09_Parallel_Sessions.md` — 並列セッション機能の設計

**本ドキュメントの位置づけ：** Discord の長文メッセージがテキストファイルに自動変換される問題への対応を設計する。

---

## 1. 概要

### 1.1 問題

Discord はメッセージが約 2000 文字を超えると、テキストをファイル（`.txt`）に自動変換して添付する。この場合 `msg.content` は空文字列になり、プロンプトとして何も送信されない。

### 1.2 対応方針

メッセージにテキストファイルが添付されている場合、そのファイルをダウンロードしてプロンプトとして使用する。

---

## 2. ユーザー体験

### 2.1 長文メッセージの送信

```
User: (2000文字超のテキストを入力 → Discord がファイルに自動変換)
      message.txt が添付された空メッセージとして送信される

Bot: (添付ファイルをダウンロード → テキストをプロンプトとして処理)
     📨 受信しました。処理を開始します...
     ...
```

ユーザーから見ると、長いメッセージでも通常のメッセージと同じように処理される。

### 2.2 テキスト + 添付の組み合わせ

```
User: "このファイルの内容で実装して" + message.txt を添付

Bot: テキストと添付ファイルの内容を結合してプロンプトとして処理
     "このファイルの内容で実装して\n\n<添付ファイルの内容>"
```

---

## 3. 設計

### 3.1 プロンプト解決ロジック

```
メッセージ受信
  │
  ├─ content が空でなく、添付なし → content をそのままプロンプトとして使用
  │
  ├─ content が空で、テキスト添付あり → 添付ファイルをダウンロードしてプロンプトとして使用
  │
  ├─ content があり、テキスト添付もあり → content + "\n\n" + 添付内容 を結合
  │
  └─ content が空で、添付なし（or 非テキスト添付のみ） → 無視
```

### 3.2 テキスト添付の判定条件

以下のいずれかを満たす添付ファイルをテキストとして扱う:

- `contentType` が `text/` で始まる（`text/plain`, `text/markdown` 等）
- ファイル名が `.txt` で終わる（`contentType` がない場合のフォールバック）

### 3.3 サイズ制限

悪意のある巨大ファイルへの対策として、添付ファイルのサイズ上限を設ける。

- 上限: **100KB**（十分な長文を許容しつつ、メモリを保護）
- 上限を超える場合: 「添付ファイルが大きすぎます（最大 100KB）」と通知して無視

### 3.4 複数添付ファイル

テキスト添付が複数ある場合は、最初の 1 つのみを使用する。

---

## 4. 変更一覧

### 4.1 新規ファイル

#### `infrastructure/attachment-resolver.ts`

添付ファイルからテキストを抽出するユーティリティ。

```typescript
export interface Attachment {
  contentType: string | null;
  name: string | null;
  size: number;
  url: string;
}

const MAX_ATTACHMENT_SIZE = 100 * 1024; // 100KB

export async function resolvePrompt(
  content: string,
  attachments: Attachment[],
): Promise<string | null>;
```

**処理フロー:**

1. `attachments` からテキストファイルを検索
2. 見つからなければ `content` をそのまま返す（空なら `null`）
3. サイズチェック（`MAX_ATTACHMENT_SIZE` 超なら `null` + エラー情報）
4. `fetch(attachment.url)` でダウンロード
5. `content` と結合して返す

### 4.2 変更ファイル

#### `index.ts`

メッセージイベントハンドラーで `resolvePrompt` を呼び出し、解決されたテキストをプロンプトとして使用する。

```typescript
// 変更前
handleMessage({
  ...
  content: msg.content,
});

// 変更後
const attachments = [...msg.attachments.values()].map(a => ({
  contentType: a.contentType,
  name: a.name,
  size: a.size,
  url: a.url,
}));
const prompt = await resolvePrompt(msg.content, attachments);
if (prompt === null) return;

handleMessage({
  ...
  content: prompt,
});
```

#### `app/message-handler.ts`

変更なし。`content` として解決済みのテキストが渡されるため、既存のロジックがそのまま動作する。

---

## 5. エッジケース

| ケース | 対処 |
|--------|------|
| 添付ファイルが 100KB 超 | 「添付ファイルが大きすぎます」と通知、プロンプトとして処理しない |
| 添付ファイルのダウンロード失敗 | エラーログ出力、`content` のみで処理を継続 |
| 画像や PDF などの非テキスト添付 | 無視（テキスト判定に合致しないため） |
| テキスト添付が複数 | 最初の 1 つのみ使用 |
| `content` あり + テキスト添付あり | 結合して 1 つのプロンプトにする |
| 空 `content` + 空テキストファイル | 空プロンプトとして扱う（Orchestrator が処理） |

---

## 6. テスト方針

### `attachment-resolver.test.ts`（新規）

- テキスト添付なし + content あり → content をそのまま返す
- テキスト添付なし + content 空 → null を返す
- テキスト添付あり + content 空 → 添付テキストを返す
- テキスト添付あり + content あり → 結合して返す
- `contentType: text/plain` で判定される
- `.txt` ファイル名で判定される（contentType なし）
- 非テキスト添付は無視される
- 100KB 超の添付 → null とエラー情報を返す
- 複数テキスト添付 → 最初の 1 つのみ使用
- ダウンロード失敗 → content のみで処理

---

## 7. 実装順序

1. `infrastructure/attachment-resolver.ts` + テスト
2. `index.ts` のメッセージハンドラーに `resolvePrompt` を組み込み
