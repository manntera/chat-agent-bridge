# セッション永続化機能の設計

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `08_Resume_Session.md` — 過去セッション再開機能の設計
- `15_Workspace_Management.md` — ワークスペース管理機能の設計

**本ドキュメントの位置づけ：** サーバー再起動後も既存の Discord スレッドで会話を継続できるよう、スレッドとセッションのマッピングを永続化する機能の設計仕様を定義する。

---

## 1. 概要

### 1.1 背景

現在のシステムでは `SessionManager` がスレッド ID とセッションコンテキストの対応をインメモリの `Map` で管理している。そのため、サーバーが再起動すると全てのマッピングが失われ、既存のスレッドで会話を続行できなくなる。

ユーザーは `/cc resume` で新しいスレッドを作成して過去セッションを再開できるが、元のスレッドの文脈が途切れるため不便である。

### 1.2 課題

- **サーバー再起動でスレッドが無効化** — デプロイや障害復旧のたびに全スレッドが使えなくなる
- **`/cc resume` での回避は手間** — 新しいスレッドが作られるため、会話の流れが分断される
- **既存スレッドへのメッセージが無視される** — `sessionManager.get()` が `null` を返し、メッセージハンドラが何もしない

### 1.3 対応方針

**スレッド→セッションのマッピングを JSON ファイルに永続化し、サーバー再起動後にメッセージを受信した時点で自動復元する（遅延復元方式）。**

- マッピングデータ（threadId, sessionId, workDir, workspaceName）をディスクに保存
- インメモリの `SessionManager` はランタイム状態（Orchestrator, ClaudeProcess）の管理に引き続き使用
- メッセージ受信時にインメモリにセッションがなければ、ディスクのマッピングから自動復元

---

## 2. ユーザー体験

### 2.1 サーバー再起動後の会話継続（変更後）

```
User: バグ修正して (既存スレッドで送信)

(サーバーが再起動していた場合)
Bot: (自動的にセッションを復元し、ClaudeCode が応答)
```

ユーザーから見ると、サーバー再起動の影響を意識することなく会話を続行できる。

### 2.2 復元不可能なケース

```
User: バグ修正して (既存スレッドで送信)

(ワークスペースが削除されている、またはセッションファイルが消失している場合)
Bot: セッションの復元に失敗しました。`/cc resume` で再開するか、`/cc new` で新しいセッションを開始してください。
```

---

## 3. 設計

### 3.1 二層構成

```
ディスク（永続層）                    インメモリ（ランタイム層）
┌─────────────────────────┐       ┌──────────────────────────┐
│ ThreadMappingStore      │       │ SessionManager           │
│                         │       │                          │
│ threadId → {            │──復元→│ threadId → {             │
│   sessionId,            │       │   orchestrator (状態機械),│
│   workDir,              │       │   session,               │
│   workspaceName         │       │   claudeProcess,         │
│ }                       │       │   ...                    │
│                         │       │ }                        │
│ JSON ファイル            │       │ Map<string, Context>     │
└─────────────────────────┘       └──────────────────────────┘
         ▲                                 ▲
         │                                 │
    SessionRestorer が復元時に両者を橋渡し
```

- **ディスク**: マッピングの情報源。サーバー再起動に耐える
- **インメモリ**: アクティブなセッションのランタイム状態を管理。Orchestrator の状態遷移（idle/busy/interrupting）や ClaudeProcess の子プロセス管理はインメモリでのみ可能

### 3.2 マッピングファイルの形式

プロジェクトルートに `thread-sessions.json` として保存する。

```json
{
  "mappings": {
    "1234567890123456789": {
      "sessionId": "0351e524-f748-480c-b602-8f40c6f9fe54",
      "workDir": "/home/user/works/oshibako",
      "workspaceName": "oshibako"
    },
    "9876543210987654321": {
      "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "workDir": "/home/user/works/chat-agent-bridge",
      "workspaceName": "chat-agent"
    }
  }
}
```

書き込みは temp ファイル + `rename` によるアトミック更新で行い、書き込み途中のクラッシュによる JSON 破損を防止する。複数の書き込みが並行した場合は直列化して競合を防ぐ。

### 3.3 保存タイミング

マッピングの保存は、セッション ID が確定したタイミングで `persistMapping()` ヘルパーを通じて行う。

- `/cc new` — `session.ensure()` 後にマッピングを追加して保存
- `/cc resume` — `session.restore()` 後にマッピングを追加して保存
- セッション削除 — 将来的な `/cc close` 等でマッピングを削除して保存

### 3.4 遅延復元フロー

`SessionRestorer` クラスが復元ロジックと排他制御を担う。

```
MessageCreate イベント
  │
  ▼
sessionManager.get(threadId)
  │
  ├─ あり → 通常のメッセージ処理
  │
  └─ なし
      │
      ▼
    sessionRestorer.tryRestore(threadId, thread)
      │
      ├─ 別メッセージが復元中 → その完了を待って同じ結果を返す（排他制御）
      │
      ├─ マッピングなし → null（マッピング自体が存在しないスレッド）
      │
      └─ マッピングあり → { sessionId, workDir, workspaceName }
          │
          ▼
        workDir のディレクトリ存在チェック
          │
          ├─ 存在しない → エラーメッセージをスレッドに送信、マッピング削除
          │
          └─ 存在する
              │
              ▼
            createSession(threadId, thread, { name, path })
              │
              ▼
            ctx.session.restore(sessionId)
              │
              ▼
            通常のメッセージ処理を続行
```

同一スレッドへの並行メッセージによる二重復元は `pendingRestorations` マップで排他制御する。2番目の呼び出し元は最初の復元結果を共有するが、オーケストレータが既に busy 状態のため「処理中」として弾かれる（想定動作）。

### 3.5 `/cc resume` との関係

`/cc resume` は引き続き「新しいスレッドで過去セッションを再開する」用途で使える。永続化機能はこれを置き換えるものではなく、「サーバー再起動時に既存スレッドが使えなくなる」問題の解決に特化している。

`/cc resume` でセッションを再開した場合も、新しいスレッドのマッピングがディスクに保存される。

---

## 4. 変更一覧

### 4.1 新規ファイル

#### `infrastructure/thread-mapping-store.ts`

スレッド→セッションのマッピングを JSON ファイルで永続化するクラス。

```typescript
export interface ThreadMapping {
  sessionId: string;
  workDir: string;
  workspaceName: string;
}

export class ThreadMappingStore {
  private mappings: Map<string, ThreadMapping>;
  private readonly filePath: string;

  constructor(filePath: string);

  /** ファイルから同期読み込み。存在しなければ空 */
  private load(): void;

  /** ファイルに非同期書き込み（temp+rename、直列化で競合防止） */
  private save(): Promise<void>;

  get(threadId: string): ThreadMapping | null;

  /** マッピングを追加してディスクに保存 */
  set(threadId: string, mapping: ThreadMapping): Promise<void>;

  /** マッピングを削除してディスクに保存 */
  remove(threadId: string): Promise<void>;
}
```

#### `infrastructure/session-restorer.ts`

ディスクのマッピングからセッションを遅延復元するクラス。依存を注入可能にし、テスト容易性を確保する。

```typescript
export interface SessionRestorerDeps {
  threadMappingStore: Pick<ThreadMappingStore, 'get' | 'remove'>;
  sessionManager: { remove(threadId: string): void };
  createSession: (threadId: string, thread: ThreadSender, workspace: { name: string; path: string }) => SessionContext;
  log: (msg: string) => void;
}

export class SessionRestorer {
  constructor(deps: SessionRestorerDeps);

  /**
   * ディスクのマッピングからセッションを遅延復元する。
   * 並行メッセージによる二重復元を排他制御する。
   */
  tryRestore(threadId: string, thread: ThreadSender): Promise<SessionContext | null>;
}
```

### 4.2 変更ファイル

#### `infrastructure/config.ts`

`threadSessionsFile` を追加。

```typescript
export interface Config {
  // ... 既存フィールド
  threadSessionsFile: string;  // 追加: thread-sessions.json のパス
}
```

デフォルト値: `path.join(process.cwd(), 'thread-sessions.json')`

#### `index.ts`

主な変更点:

1. **起動時**: `ThreadMappingStore` と `SessionRestorer` をインスタンス化
2. **`persistMapping` ヘルパー**: `threadMappingStore.set()` の呼び出しを集約し DRY 化
3. **`/cc new` のセッション作成後**: `await persistMapping(threadId, sessionId, workspace)`
4. **`/cc resume` のセッション再開後**: 同上
5. **`MessageCreate` ハンドラ**: `sessionManager.get()` が `null` の場合に `sessionRestorer.tryRestore()` で遅延復元を試行

```typescript
// MessageCreate ハンドラの変更（概要）
let ctx = sessionManager.get(msg.channelId);

if (!ctx) {
  ctx = await sessionRestorer.tryRestore(msg.channelId, msg.channel as ThreadSender);
}
```

---

## 5. エッジケース

- **`thread-sessions.json` が存在しない** — 空の Map として扱う（新規起動時）
- **`thread-sessions.json` が壊れている** — 警告ログを出力し、空の Map として扱う
- **マッピング先の `workDir` が削除されている** — エラーメッセージをスレッドに送信し、マッピングを削除
- **`workDir` がファイル（ディレクトリではない）** — 同上（`isDirectory()` チェックで検出）
- **同じスレッド ID で複数回 `set` が呼ばれる** — 上書き（最新のセッション情報が正）
- **同一スレッドへの並行メッセージ** — `pendingRestorations` で排他制御し、二重復元を防止
- **Discord でスレッドが削除されている** — メッセージが到達しないため問題なし。マッピングは残るが実害なし
- **ファイル書き込み中にクラッシュ** — temp+rename のアトミック書き込みにより、前回の正常なファイルが保持される
- **`createSession()` / `session.restore()` が失敗** — セッションとマッピングをクリーンアップし、エラーメッセージを送信
- **マッピングが際限なく増える** — スレッドは Discord 側で自動アーカイブされるため、実用上は問題にならない。将来必要に応じて古いエントリの定期削除を検討

---

## 6. テスト方針

### 6.1 `infrastructure/thread-mapping-store.test.ts`（新規）

- `set()` でマッピングが追加され、`get()` で取得できる
- `set()` で JSON ファイルに永続化される
- `remove()` でマッピングが削除される
- 同じ threadId に対して `set()` を再度呼ぶと上書き
- ファイルが存在しない場合は空 Map
- ファイルが壊れている場合は空 Map + 警告
- 前回の save が失敗しても次回の save が正常に動作する

### 6.2 `infrastructure/session-restorer.test.ts`（新規）

- マッピングが存在しない場合は null を返す
- workDir が存在しない / ファイルの場合はエラーメッセージを送信し null を返す
- 正常にセッションを復元できる
- `session.restore()` / `createSession()` が失敗した場合はクリーンアップしてエラーメッセージを返す
- 並行復元時は最初の結果を共有し createSession は1回だけ呼ばれる
- `threadMappingStore.remove()` や `thread.send()` が失敗しても正常に処理される
