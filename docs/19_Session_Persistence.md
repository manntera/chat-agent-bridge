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

| 問題 | 具体例 |
|------|--------|
| **サーバー再起動でスレッドが無効化** | デプロイや障害復旧のたびに全スレッドが使えなくなる |
| **`/cc resume` での回避は手間** | 新しいスレッドが作られるため、会話の流れが分断される |
| **既存スレッドへのメッセージが無視される** | `sessionManager.get()` が `null` を返し、メッセージハンドラが何もしない |

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
```

- **ディスク**: マッピングの情報源。サーバー再起動に耐える
- **インメモリ**: アクティブなセッションのランタイム状態を管理。Orchestrator の状態遷移（idle/busy/interrupting）や ClaudeProcess の子プロセス管理はインメモリでのみ可能

### 3.2 マッピングファイルの形式

プロジェクトルートに `thread-sessions.json` として保存する。

```json
{
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
```

### 3.3 保存タイミング

マッピングの保存は、セッション ID が確定したタイミングで行う。

| 操作 | タイミング | 動作 |
|------|-----------|------|
| `/cc new` | `session.ensure()` 後 | マッピングを追加して保存 |
| `/cc resume` | `session.restore()` 後 | マッピングを追加して保存 |
| セッション削除 | 将来的な `/cc close` 等 | マッピングを削除して保存 |

### 3.4 遅延復元フロー

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
    threadMappingStore.get(threadId)
      │
      ├─ なし → 無視（マッピング自体が存在しないスレッド）
      │
      └─ あり → { sessionId, workDir, workspaceName }
          │
          ▼
        workDir のディレクトリ存在チェック
          │
          ├─ 存在しない → エラーメッセージをスレッドに送信
          │
          └─ 存在する
              │
              ▼
            createSession(threadId, thread, { name: workspaceName, path: workDir })
              │
              ▼
            ctx.session.restore(sessionId)
              │
              ▼
            通常のメッセージ処理を続行
```

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

  /** ファイルから読み込み。存在しなければ空 */
  private load(): Map<string, ThreadMapping>;

  /** ファイルに書き込み */
  private save(): void;

  get(threadId: string): ThreadMapping | null;

  set(threadId: string, mapping: ThreadMapping): void;

  remove(threadId: string): void;
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

1. **起動時**: `ThreadMappingStore` をインスタンス化
2. **`/cc new` のセッション作成後**: `threadMappingStore.set(threadId, { sessionId, workDir, workspaceName })` を呼び出し
3. **`/cc resume` のセッション再開後**: 同上
4. **`MessageCreate` ハンドラ**: `sessionManager.get()` が `null` の場合に遅延復元を試行

```typescript
// MessageCreate ハンドラの変更（概要）
const ctx = sessionManager.get(msg.channelId);

if (!ctx) {
  // 遅延復元を試行
  const mapping = threadMappingStore.get(msg.channelId);
  if (mapping) {
    // セッションを復元して処理を続行
    const restoredCtx = createSession(msg.channelId, msg.channel, {
      name: mapping.workspaceName,
      path: mapping.workDir,
    });
    restoredCtx.session.restore(mapping.sessionId);
    // メッセージ処理を続行...
  }
}
```

---

## 5. エッジケース

| ケース | 対処 |
|--------|------|
| `thread-sessions.json` が存在しない | 空の Map として扱う（新規起動時） |
| `thread-sessions.json` が壊れている | 警告ログを出力し、空の Map として扱う |
| マッピング先の `workDir` が削除されている | エラーメッセージをスレッドに送信し、マッピングを削除 |
| 同じスレッド ID で複数回 `set` が呼ばれる | 上書き（最新のセッション情報が正） |
| Discord でスレッドが削除されている | メッセージが到達しないため問題なし。マッピングは残るが実害なし |
| ファイル書き込み中にクラッシュ | 次回起動時に壊れた JSON として検出し、空として扱う |
| マッピングが際限なく増える | スレッドは Discord 側で自動アーカイブされるため、実用上は問題にならない。将来必要に応じて古いエントリの定期削除を検討 |

---

## 6. テスト方針

### 6.1 `infrastructure/thread-mapping-store.test.ts`（新規）

- `set()` でマッピングが追加され、`get()` で取得できる
- `set()` で JSON ファイルに永続化される
- `remove()` でマッピングが削除される
- 同じ threadId に対して `set()` を再度呼ぶと上書き
- ファイルが存在しない場合は空 Map
- ファイルが壊れている場合は空 Map + 警告

### 6.2 `index.ts` 結合

- メッセージ受信時にインメモリにセッションがなく、マッピングが存在する場合に自動復元される
- 復元後のメッセージが正常に処理される
- マッピングの `workDir` が存在しない場合にエラーメッセージが送信される

---

## 7. 実装順序

1. `infrastructure/thread-mapping-store.ts` + テスト — 永続化クラスの実装
2. `infrastructure/config.ts` — `threadSessionsFile` の追加
3. `index.ts` — `ThreadMappingStore` のインスタンス化とマッピング保存の組み込み
4. `index.ts` — `MessageCreate` ハンドラへの遅延復元ロジックの追加
