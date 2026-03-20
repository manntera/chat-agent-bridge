# 設計ドキュメントと実装の差分記録

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `07_PoC_Improvements.md` — PoC ブラッシュアップ記録
- `08_Resume_Session.md` — 過去セッション再開機能
- `09_Parallel_Sessions.md` — 並列セッション機能
- `10_Attachment_Text.md` — テキスト添付ファイル対応

**本ドキュメントの位置づけ：** docs/10 までのドキュメント作成後に行われた実装変更のうち、ドキュメントに反映されていない差分をまとめる。設計判断の変更理由と現在の実装状態を記録する。

---

## 1. 設計から実装へのフィードバック概要

全体として、docs/07〜10 の設計は忠実に実装されている。差分は主に以下の 2 種類に分類される。

- **設計の改善**: 実装時に設計よりも良い方法が見つかり、改善した箇所
- **未実装の設計**: docs/01 で構想されたが、PoC 以降の実装で方針転換した機能

---

## 2. 設計の改善（実装が設計を上回った箇所）

### 2.1 通知アーキテクチャの変更（docs/07 → docs/09 → 実装）

**docs/07 の設計:**

| 通知種別 | 送信先 |
|---------|--------|
| `progress` | ユーザーメッセージへのスレッド |
| `result` / `error` / `info` | チャンネル直接 |

**docs/09 の設計:**

すべての通知をセッションスレッド内に送信する。

**現在の実装:**

docs/09 に従い、すべての通知がセッションスレッド内に送信される。docs/07 に記載されていたスレッド管理機構（`setThreadOrigin`, `ensureThread`, `archiveThread`, `Threadable` インターフェース）は docs/09 の設計により完全に不要になり、削除されている。

現在の `discord-notifier.ts` は `ThreadSender` を受け取るだけのシンプルな実装になっている。

```typescript
// docs/07 時点の設計（削除済み）
interface Threadable {
  startThread(options: { name: string }): Promise<ThreadSender>;
}
function createNotifier(channel: ChannelSender): NotifyFn & { setThreadOrigin(message: Threadable): void };

// 現在の実装
interface ThreadSender {
  send(content: string | SendOptions): Promise<unknown>;
}
function createNotifier(thread: ThreadSender): NotifyFn;
```

### 2.2 添付ファイル解決の戻り値改善（docs/10 → 実装）

**docs/10 の設計:**

```typescript
async function resolvePrompt(content: string, attachments: Attachment[]): Promise<string | null>;
```

**現在の実装:**

```typescript
interface ResolveResult {
  prompt: string | null;
  error: string | null;
}
async function resolvePrompt(content: string, attachments: Attachment[]): Promise<ResolveResult>;
```

`error` フィールドを追加し、サイズ超過時にエラーメッセージを返せるようにした。これにより、呼び出し側（`index.ts`）でエラーをユーザーに通知しつつ、`content` がある場合はそちらだけで処理を継続できる。

### 2.3 セッション一覧の slug 表示（docs/08 → 実装）

**docs/08 の設計:**

`SessionSummary` は `sessionId`, `firstUserMessage`, `lastModified` の 3 フィールド。セレクトメニューのラベルは最初のユーザーメッセージのみ。

**現在の実装:**

`slug` フィールドを追加:

```typescript
export interface SessionSummary {
  sessionId: string;
  firstUserMessage: string;
  slug: string | null;       // 追加
  lastModified: Date;
}
```

Claude CLI の JSONL ファイルにはセッションの `slug`（タイトル）が含まれる場合がある。セレクトメニューのラベルに `slug` を優先表示し、ない場合は `firstUserMessage` にフォールバックする。

```
slug あり → ラベル: slug, 説明: firstUserMessage
slug なし → ラベル: firstUserMessage, 説明: 相対日時
```

### 2.4 セッション再開時のスレッド作成（docs/08 → 実装）

**docs/08 の設計:**

`/cc resume` → セレクトメニューで選択 → 現在のスレッド内で `orchestrator.handleCommand({ type: 'resume', sessionId })` を呼び出し。

**現在の実装:**

`/cc resume` → セレクトメニューで選択 → **新しいスレッドを作成**し、そこにセッションを紐づける。docs/09 の並列セッション設計（1 スレッド = 1 セッション）に合わせた形。

```typescript
// index.ts（resume 選択時）
const thread = await channel.threads.create({
  name: `Session: ${selectedSessionId.slice(0, 8)}... (再開)`,
});
const ctx = createSession(thread.id, thread);
ctx.session.restore(selectedSessionId);
```

### 2.5 resume 時の Orchestrator 状態チェック省略（docs/08 → 実装）

**docs/08 の設計:**

セレクトメニュー選択時に `orchestrator.state` を再確認し、`busy` / `interrupting` なら拒否する。

**現在の実装:**

新しいスレッドに新しいセッションを作成するため、既存セッションの状態チェックは不要。各スレッドが独立した `Orchestrator` を持つ docs/09 の設計により、この問題自体が消滅した。

### 2.6 セッション開始メッセージにセッション ID を表示（docs/07 → 実装）

**docs/07 の設計:**

`/cc new` → 「新しいセッションを開始しました (model: opus, effort: max)」

**現在の実装:**

セッション ID の先頭 8 文字を含める:

```
新しいセッションを開始しました [abc12345] (model: opus, effort: max)
```

`Orchestrator.formatNewSessionMessage()` と `Orchestrator.formatSessionId()` メソッドで実装。

---

## 3. 未実装の設計（docs/01 の構想で方針転換した機能）

docs/01（`SystemDesign.md`）で構想された以下の機能は、PoC 以降の設計判断により未実装のまま保留されている。

### 3.1 Forum チャンネルアーキテクチャ

**docs/01 の構想:**

Discord の Forum チャンネルをセッション管理に使用する。

| Discord の概念 | ClaudeCode での意味 |
|----------------|---------------------|
| フォーラムの投稿（スレッド） | 1 つのセッション |

**現在の実装:**

TextChannel + Threads 方式を採用（docs/09 Section 1.3 で方針転換を記載）。コアの設計（`Map<threadId, SessionContext>`）は Forum でも同一であり、後から Forum への移行が可能な状態で保留。

### 3.2 作業ディレクトリ選択 UI

**docs/01 の構想:**

スレッド作成時にインタラクティブなフォルダ選択 UI でディレクトリを指定する。番号入力で階層を深くしていく対話的フロー。

```
Bot: 📁 作業ディレクトリを選択してください
/home/user/projects/
 1. webapp
 2. api-server
 3. mobile-app
 0: ✅ ここに決定 | ..: ⬆️ 戻る
```

**現在の実装:**

`.env` の `WORK_DIR` 環境変数で固定。選択 UI は未実装。現状では単一プロジェクト運用のため問題はないが、複数プロジェクトを扱う場合は対応が必要。

### 3.3 会話フォーク機能

**docs/01 の構想:**

`!history` コマンドで会話履歴を番号付き表示し、`!fork <番号> [タイトル]` で指定時点から分岐した新セッションを作成する。Git のブランチに相当する概念。

**現在の実装:**

未実装。JSONL ファイルの操作基盤（`SessionStore`）は存在するため、技術的には実現可能だが、優先度が低い。

### 3.4 追加コマンド群

**docs/01 の構想:**

| コマンド | 操作内容 |
|----------|----------|
| `!stop` | セッションを停止（履歴は保持） |
| `!sessions` | 全セッションの一覧と起動状態を表示 |
| `!status` | 現在のセッションの状態を確認 |

**現在の実装:**

未実装。これらはスラッシュコマンド体系への移行（docs/07）により、将来的に `/cc stop`, `/cc sessions`, `/cc status` として実装される可能性がある。

---

## 4. スレッドアーカイブの変遷

**docs/07 の設計:**

`result` または `error` の送信後にスレッドをアーカイブ（`setArchived(true)`）する。

**docs/09 の設計:**

「削除される概念」として `archiveThread` を明記。セッションスレッドは残し続ける方針。

**実装履歴:**

git log によると、`c45f59a` でスレッドアーカイブ機能が一度実装されたが、`b31b8ff`（Refactor Discord notifier and session management）で docs/09 の設計に合わせて削除された。現在のコードにアーカイブ処理は存在しない。

---

## 5. index.ts の肥大化

docs/09（並列セッション）の実装に伴い、`index.ts` が約 390 行に肥大化している。以下の責務が集中している状態:

| 責務 | 行数（概算） |
|------|-------------|
| Discord Client 初期化・接続 | ~20行 |
| ドメインオブジェクト・セッションファクトリ | ~40行 |
| ユーティリティ関数（log, formatRelativeDate, logNotification） | ~50行 |
| MessageCreate イベントハンドラ | ~50行 |
| InteractionCreate イベントハンドラ | ~190行 |

特に `InteractionCreate` ハンドラ内に `/cc new`（スレッド作成含む）、`/cc interrupt`（スレッド内判定）、`/cc resume`（セレクトメニュー構築・選択処理）が直書きされており、app 層の `interaction-handler.ts` はコマンドのパースのみを担当する薄い関数にとどまっている。

この問題への対応は `12_Multi_Platform_Architecture.md` で設計する。

---

## 6. 差分一覧

| 区分 | 内容 | 関連ドキュメント |
|------|------|----------------|
| 改善 | 通知先を全てセッションスレッドに統一、スレッド管理機構を削除 | docs/07 → docs/09 |
| 改善 | `resolvePrompt` の戻り値に `error` フィールドを追加 | docs/10 |
| 改善 | セッション一覧に `slug` フィールドを追加 | docs/08 |
| 改善 | `/cc resume` 時に新スレッドを作成 | docs/08 → docs/09 |
| 改善 | resume 選択時の状態チェック不要化 | docs/08 → docs/09 |
| 改善 | セッション開始メッセージにセッション ID を表示 | docs/07 |
| 未実装 | Forum チャンネルアーキテクチャ | docs/01 |
| 未実装 | 作業ディレクトリ選択 UI | docs/01 |
| 未実装 | 会話フォーク機能（`!fork`, `!history`） | docs/01 |
| 未実装 | 追加コマンド（`!stop`, `!sessions`, `!status`） | docs/01 |
| 変遷 | スレッドアーカイブ: 実装 → 削除 | docs/07 → docs/09 |
| 課題 | index.ts の肥大化（約 390 行） | docs/09 → 12_Multi_Platform_Architecture.md |
