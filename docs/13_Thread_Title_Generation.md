# スレッドタイトル自動生成の設計

**前提ドキュメント:**

- `09_Parallel_Sessions.md` — 並列セッション機能の設計
- `08_Resume_Session.md` — セッション再開機能の設計

**本ドキュメントの位置づけ：** 各スレッドが何をしているかを一目で把握できるよう、Gemini API を用いてスレッドタイトルを自動生成する機能を設計する。

---

## 1. 概要

### 1.1 問題

現在のスレッド名は `Session: <UUID8桁> (model, effort)` という形式で、スレッドの内容が全くわからない。フォーラムチャンネルに複数のスレッドが並んだとき、どのスレッドで何を作業しているのかを判別できない。

### 1.2 対応方針

Claude Code の応答が完了するたびに、セッションの会話履歴全体を Gemini API（Flash モデル）に渡し、スレッドの内容を要約した短いタイトルを生成させる。生成されたタイトルで Discord スレッド名を自動更新する。

---

## 2. ユーザー体験

### 2.1 セッション作成〜タイトル更新の流れ

```
User: /cc new model:opus effort:high
Bot:  スレッド「Session: a1b2c3d4 (opus, high)」を作成

User: "ユーザー認証のバグを修正して"
Bot:  📨 処理を開始します...
      ... (進捗表示) ...
      ✅ 結果 Embed

      → スレッド名が「ユーザー認証のバグ修正」に自動更新
```

### 2.2 会話が進むとタイトルも更新される

```
User: "テストも追加して"
Bot:  ... (処理) ...
      ✅ 結果 Embed

      → スレッド名が「ユーザー認証バグ修正とテスト追加」に更新
```

### 2.3 タイトル生成に失敗した場合

```
Bot:  ✅ 結果 Embed
      (スレッド名は変更されず、前のタイトルが維持される)
```

タイトル生成は付加機能であり、失敗してもセッション本体の動作に影響しない。

---

## 3. 設計

### 3.1 全体フロー

```
ClaudeProcess 終了
  │
  ▼
Orchestrator.onProcessEnd()
  │
  ├─ 結果/エラー通知を送信（既存処理）
  ├─ Usage 通知を送信（既存処理）
  │
  ▼
TitleGenerator.generate(sessionId, workDir)
  │
  ├─ SessionStore からセッション JSONL を読み込み
  ├─ 会話内容を要約用プロンプトに整形
  ├─ Gemini API に送信
  ├─ 応答からタイトル文字列を抽出
  │
  ▼
thread.setName(title)
```

### 3.2 会話データの取得

Claude CLI のセッションファイル（JSONL）を会話データのソースとする。

- **パス:** `~/.claude/projects/<workDir-hash>/<sessionId>.jsonl`
- **読み取り方法:** `SessionStore` の既存のディレクトリ解決ロジック（`projectDir()`）を再利用
- **内容:** ユーザープロンプト、Claude の応答、ツール使用履歴を含む完全な会話記録

### 3.3 JSONL の整形

JSONL にはツール実行の詳細やメタデータなど大量の情報が含まれる。Gemini に渡す前に以下の方針で整形する。

- ユーザーメッセージ（`role: "user"`）と アシスタントメッセージ（`role: "assistant"`）を抽出
- アシスタントメッセージからは `text` タイプのコンテンツのみ抽出（tool_use の詳細は除外）
- ツール使用は名前のみ含める（`tool_use: <tool_name>` の形式で要約）
- 整形後のテキストがトークン上限を超える場合、古い会話から切り詰める

### 3.4 Gemini API 呼び出し

| 項目 | 値 |
|------|-----|
| モデル | `gemini-2.0-flash` （安価・高速） |
| 用途 | タイトル要約（1 リクエスト / セッション応答完了ごと） |
| 入力 | 整形済み会話テキスト |
| 出力 | 30 文字以内の日本語タイトル |
| トークン上限（入力） | 8,000 トークン目安（超過時は末尾を優先して切り詰め） |
| トークン上限（出力） | 64 トークン |
| タイムアウト | 10 秒 |

**プロンプト:**

```
以下はAIコーディングアシスタントとユーザーの会話履歴です。
この会話全体の内容を要約した短いタイトルを1つだけ生成してください。

ルール:
- 30文字以内の日本語
- 何の作業をしているかが一目でわかること
- タイトルのみを出力し、他の説明は不要

会話履歴:
{conversation}
```

### 3.5 スレッド名の更新

- Discord スレッド名の上限は **100 文字**
- Gemini の応答をトリムし、100 文字を超える場合は切り詰める
- `thread.setName()` で更新（discord.js API）
- レート制限: Discord のスレッド名変更は **10 分に 2 回** まで。短時間に連続で応答が完了した場合、最後の更新のみ適用されるよう制御する

### 3.6 コンポーネント構成

```
infrastructure/
  ├─ title-generator.ts    ... Gemini API 呼び出し + タイトル生成
  ├─ session-reader.ts     ... JSONL 読み込み + 整形
  └─ config.ts             ... GEMINI_API_KEY を追加
```

---

## 4. 変更一覧

### 4.1 新規ファイル

#### `infrastructure/title-generator.ts`

Gemini API を呼び出してタイトルを生成するモジュール。

```typescript
export interface ITitleGenerator {
  generate(sessionId: string, workDir: string): Promise<string | null>;
}

export class TitleGenerator implements ITitleGenerator {
  constructor(private apiKey: string);

  async generate(sessionId: string, workDir: string): Promise<string | null>;
}
```

**処理フロー:**

1. `SessionReader` で JSONL を読み込み・整形
2. Gemini API に整形済みテキストを送信
3. 応答からタイトル文字列を抽出（トリム、100 文字制限）
4. エラー時は `null` を返す（ログ出力のみ）

#### `infrastructure/session-reader.ts`

セッション JSONL を読み込み、タイトル生成用に整形するモジュール。

```typescript
export interface ConversationEntry {
  role: 'user' | 'assistant';
  text: string;
}

export async function readSession(
  sessionId: string,
  workDir: string,
): Promise<ConversationEntry[]>;

export function formatForTitleGeneration(
  entries: ConversationEntry[],
  maxLength: number,
): string;
```

### 4.2 変更ファイル

#### `infrastructure/config.ts`

環境変数 `GEMINI_API_KEY` を追加。

```typescript
export interface Config {
  // ... 既存フィールド
  geminiApiKey: string | null; // null の場合タイトル生成を無効化
}
```

#### `index.ts`

ClaudeProcess 終了後のコールバックにタイトル生成・スレッド名更新処理を追加。

```typescript
// ClaudeProcess 終了時（既存の onProcessEnd コールバック付近）
claudeProcess.onClose = async (exitCode, output) => {
  orchestrator.onProcessEnd(exitCode, output);

  // タイトル生成（非同期・失敗しても無視）
  if (titleGenerator && session.sessionId) {
    titleGenerator
      .generate(session.sessionId, config.workDir)
      .then((title) => {
        if (title) thread.setName(title);
      })
      .catch((err) => console.error('Title generation error:', err));
  }
};
```

#### `infrastructure/discord-notifier.ts`

`ThreadSender` インターフェースに `setName` を追加。

```typescript
export interface ThreadSender {
  send(content: string | SendOptions): Promise<unknown>;
  setName(name: string): Promise<unknown>;
}
```

---

## 5. エッジケース

| ケース | 対処 |
|--------|------|
| `GEMINI_API_KEY` が未設定 | タイトル生成をスキップ。既存のスレッド名を維持 |
| Gemini API がタイムアウト（10 秒超） | ログ出力して無視。スレッド名は変更しない |
| Gemini API がエラーレスポンスを返す | ログ出力して無視。スレッド名は変更しない |
| 生成タイトルが空文字 | スレッド名は変更しない |
| 生成タイトルが 100 文字超 | 100 文字で切り詰める |
| JSONL ファイルが存在しない | `null` を返す（セッション開始直後など） |
| JSONL が非常に大きい（長い会話） | 整形時にトークン上限で切り詰め（末尾＝最新の会話を優先） |
| 短時間に連続で応答完了 | Discord レート制限に注意。エラー時はリトライせず無視 |
| 中断（interrupt）で終了した場合 | タイトル生成を実行する（中断前の会話内容でタイトル更新） |
| `/cc new` による再作成で終了した場合 | 新セッション側でタイトル生成される。旧スレッドのタイトルはそのまま |

---

## 6. テスト方針

### `infrastructure/session-reader.test.ts`（新規）

- JSONL からユーザー・アシスタントメッセージを抽出できる
- tool_use の詳細が除外され、ツール名のみ含まれる
- `maxLength` 超過時に古い会話から切り詰められる
- 空の JSONL → 空配列を返す
- 不正な JSON 行がスキップされる

### `infrastructure/title-generator.test.ts`（新規）

- 正常系: Gemini API レスポンスからタイトルを抽出できる
- API キーが `null` → `null` を返す
- API エラー → `null` を返す
- タイムアウト → `null` を返す
- 100 文字超のタイトル → 切り詰められる
- 空レスポンス → `null` を返す

### `index.test.ts`（変更）

- ClaudeProcess 終了後にタイトル生成が呼ばれる
- タイトル生成成功時にスレッド名が更新される
- タイトル生成失敗時にスレッド名が変更されない
- `GEMINI_API_KEY` 未設定時にタイトル生成がスキップされる

---

## 7. 実装順序

1. `infrastructure/session-reader.ts` + テスト — JSONL 読み込み・整形
2. `infrastructure/title-generator.ts` + テスト — Gemini API 呼び出し
3. `infrastructure/config.ts` — `GEMINI_API_KEY` 追加
4. `index.ts` — ClauseProcess 終了時のフックにタイトル生成を組み込み
5. `infrastructure/discord-notifier.ts` — `ThreadSender` に `setName` 追加
