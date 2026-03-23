# ワークスペース管理機能の設計

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `08_Resume_Session.md` — 過去セッション再開機能の設計

**本ドキュメントの位置づけ：** 起動後に作業ディレクトリを柔軟に切り替えられる「ワークスペース管理機能」の設計仕様を定義する。

---

## 1. 概要

### 1.1 背景

現在のシステムでは `.env` の `WORK_DIR` に単一のディレクトリを指定し、全セッションがそのディレクトリで動作する。そのため、複数プロジェクトを並行して開発する場合にはシステムの再起動と `.env` の書き換えが必要になる。

### 1.2 課題

| 問題 | 具体例 |
|------|--------|
| **ディレクトリが固定** | プロジェクト A の作業中にプロジェクト B の緊急バグ修正ができない |
| **毎回パス入力は面倒** | `/cc new --dir /home/user/works/project-b` のような指定は入力ミスのリスクが高い |
| **暗黙のデフォルトは危険** | 事前にワークスペースを切り替えた後 `/cc new` すると、意図しないディレクトリで作業を開始してしまう恐れがある |

### 1.3 対応方針

**事前にワークスペースを登録しておき、`/cc new` 実行時にセレクトメニューで選択する方式** を採用する。

- ワークスペースが 1 つだけの場合は自動選択（現在と同じ体験）
- 複数の場合はセレクトメニューで明示的に選択
- スレッド名にワークスペース名を含め、どのディレクトリで作業しているか常に視認可能にする

---

## 2. ユーザー体験

### 2.1 ワークスペースの登録

```
User: /cc workspace add name:oshibako path:/home/manntera/works/oshibako
Bot (ephemeral):  ワークスペース「oshibako」を登録しました (/home/manntera/works/oshibako)
```

### 2.2 ワークスペースの一覧表示

```
User: /cc workspace list
Bot (ephemeral):
  📁 登録済みワークスペース:
  1. oshibako — /home/manntera/works/oshibako
  2. chat-agent — /home/manntera/works/chat-agent-bridge
```

### 2.3 ワークスペースの削除

```
User: /cc workspace remove name:oshibako
Bot (ephemeral):  ワークスペース「oshibako」を削除しました
```

### 2.4 セッション開始（ワークスペースが複数の場合）

```
User: /cc new

Bot (ephemeral):
  作業ディレクトリを選択してください:
  ┌────────────────────────────────────────┐
  │ ▼ ワークスペースを選択してください     │
  │  ・oshibako                            │
  │  ・chat-agent                          │
  └────────────────────────────────────────┘

User: (ドロップダウンから「oshibako」を選択)

Bot (スレッドを作成):
  セッションを開始しました [`a1b2c3d4`] — 📁 oshibako

Bot (ephemeral を更新):
  セッションを作成しました → #[oshibako] Session: a1b2c3d4
```

### 2.5 セッション開始（ワークスペースが 1 つの場合）

```
User: /cc new
Bot: (現在と同じ挙動。セレクトメニューは表示されず即座にセッション作成)
```

### 2.6 セッション開始（ワークスペースが 0 件の場合）

```
User: /cc new
Bot (ephemeral):  ワークスペースが登録されていません。`/cc workspace add` で登録してください。
```

### 2.7 セッション再開（/cc resume）

```
User: /cc resume

Bot (ephemeral):
  再開するセッションを選択してください:
  ┌────────────────────────────────────────────┐
  │ ▼ セッションを選択してください             │
  │  ・[oshibako] テスト追加して (3/19)        │
  │  ・[chat-agent] リファクタリング... (3/18) │
  └────────────────────────────────────────────┘
```

- 全ワークスペースのセッションを横断的に表示し、ワークスペース名をプレフィックスとして付与する
- ユーザーがセッションを選択すると、そのセッションの元のワークスペースで自動的に再開される

### 2.8 日報生成（/cc report）

- 全ワークスペースのセッションを横断的に集約して日報を生成する
- 日報内のセッション一覧にワークスペース名を含める

---

## 3. ワークスペース永続化

### 3.1 保存先

ワークスペース情報はプロジェクトルートの `workspaces.json` に保存する。

```json
{
  "workspaces": [
    { "name": "oshibako", "path": "/home/manntera/works/oshibako" },
    { "name": "chat-agent", "path": "/home/manntera/works/chat-agent-bridge" }
  ]
}
```

### 3.2 設計判断

| 案 | 評価 |
|----|------|
| `.env` に複数パスを列挙 | パースが面倒。名前を付けられない |
| データベース（SQLite 等） | 過剰。ワークスペースは数件程度 |
| **JSON ファイル** | シンプル。人間が直接編集可能。名前とパスの対を自然に表現できる |

### 3.3 マイグレーション（既存環境との互換性）

既存の `.env` の `WORK_DIR` からの移行を円滑に行う。

1. **起動時**: `workspaces.json` が存在しなければ、`WORK_DIR` の値から自動生成する
   - ワークスペース名はパスの末尾ディレクトリ名（例: `/home/user/works/oshibako` → `oshibako`）
2. **`WORK_DIR` の扱い**: `workspaces.json` 存在時は無視される（廃止予定として警告ログを出力）
3. **将来**: `WORK_DIR` 環境変数を削除

---

## 4. 設計

### 4.1 `/cc new` のフロー変更

```
/cc new [--model] [--effort]
  │
  ▼
AccessControl.check()
  │ 許可
  ▼
WorkspaceStore.list()
  │
  ├─ 0 件 → 「ワークスペースが未登録です」(ephemeral)
  │
  ├─ 1 件 → そのワークスペースを自動選択
  │    │
  │    ▼
  │  セッション作成（現在と同じフロー）
  │  スレッド名: [oshibako] Session: a1b2c3d4 (sonnet, high)
  │
  └─ 2 件以上 → StringSelectMenu でワークスペース選択
       │
       ▼
     interaction.deferReply({ ephemeral: true })
       │
       ▼
     StringSelectMenu を表示
       │
       ▼
     ユーザーがワークスペースを選択
       │
       ▼
     セッション作成
     スレッド名: [oshibako] Session: a1b2c3d4 (sonnet, high)
```

### 4.2 Session へのワークスペース情報の保持

`Session` クラスの `workDir` を動的に設定可能にする。

```typescript
// Before: workDir はコンストラクタで固定
export class Session {
  readonly workDir: string;
  constructor(workDir: string) { ... }
}

// After: workDir に加え workspaceName も保持
export class Session {
  private _workDir: string;
  private _workspaceName: string;

  constructor(workDir: string, workspaceName: string) { ... }

  get workDir(): string { return this._workDir; }
  get workspaceName(): string { return this._workspaceName; }
}
```

### 4.3 createSession() の変更

```typescript
// Before: config.workDir 固定
function createSession(threadId: string, thread: ThreadSender): SessionContext {
  const session = new Session(config.workDir);
  // ...
}

// After: ワークスペース情報を引数で受け取る
function createSession(
  threadId: string,
  thread: ThreadSender,
  workspace: Workspace,
): SessionContext {
  const session = new Session(workspace.path, workspace.name);
  // ...
}
```

### 4.4 /cc resume の変更

セッション一覧を全ワークスペースから取得するように変更する。

```
/cc resume
  │
  ▼
WorkspaceStore.list()
  │
  ▼
全ワークスペースの workDir に対して SessionStore.listSessions() を呼び出し
  │
  ▼
結果をマージ・lastModified 降順でソート
  │
  ▼
StringSelectMenu に表示（ラベルに [ワークスペース名] をプレフィックス付与）
  │
  ▼
ユーザーが選択 → 該当ワークスペースの workDir でセッション再開
```

### 4.5 /cc report の変更

全ワークスペースのセッションを横断的に集約する。

```
/cc report [date]
  │
  ▼
WorkspaceStore.list()
  │
  ▼
全ワークスペースの workDir に対して SessionStore.listSessionsByDateRange() を呼び出し
  │
  ▼
DailySession に workspaceName を追加
  │
  ▼
ReportGenerator に渡し、ワークスペース横断の日報を生成
```

### 4.6 コンポーネント構成

```
infrastructure/
  ├─ workspace-store.ts       ... 新規: ワークスペースの CRUD + JSON 永続化
  ├─ slash-commands.ts        ... 変更: /cc workspace サブコマンドグループ追加
  ├─ config.ts                ... 変更: WORK_DIR を optional に
  ├─ session-store.ts         ... 変更: 全ワークスペース横断の一覧取得
  └─ discord-notifier.ts      ... 変更なし

domain/
  ├─ session.ts               ... 変更: workspaceName を保持
  └─ types.ts                 ... 変更: Workspace 型追加

index.ts                      ... 変更: /cc new のフロー変更、workspace サブコマンド処理
```

---

## 5. 変更一覧

### 5.1 新規ファイル

#### `infrastructure/workspace-store.ts`

ワークスペースの CRUD と永続化を担当する。

```typescript
export interface Workspace {
  name: string;
  path: string;
}

export interface IWorkspaceStore {
  list(): Workspace[];
  add(workspace: Workspace): void;
  remove(name: string): boolean;
  findByName(name: string): Workspace | undefined;
}

export class WorkspaceStore implements IWorkspaceStore {
  private workspaces: Workspace[] = [];
  private readonly filePath: string;

  constructor(filePath: string);

  /** JSON ファイルから読み込み。ファイルが存在しなければ空 */
  load(): void;

  /** JSON ファイルに書き込み */
  private save(): void;

  list(): Workspace[];
  add(workspace: Workspace): void;
  remove(name: string): boolean;
  findByName(name: string): Workspace | undefined;
}
```

### 5.2 変更ファイル

#### `domain/types.ts`

`Workspace` 型を追加。

```typescript
export interface Workspace {
  name: string;
  path: string;
}
```

#### `domain/session.ts`

`workspaceName` を保持するように変更。

```typescript
export class Session {
  private _workDir: string;
  private _workspaceName: string;
  // ...

  constructor(workDir: string, workspaceName: string) {
    this._workDir = workDir;
    this._workspaceName = workspaceName;
  }

  get workDir(): string { return this._workDir; }
  get workspaceName(): string { return this._workspaceName; }
}
```

#### `infrastructure/config.ts`

`WORK_DIR` を optional に変更。

```typescript
export interface Config {
  discordToken: string;
  channelId: string;
  allowedUserIds: string[];
  workDir: string | null;       // optional に変更
  claudePath: string;
  geminiApiKey: string | null;
  workspacesFile: string;       // 追加: workspaces.json のパス
}
```

#### `infrastructure/slash-commands.ts`

`/cc workspace` サブコマンドグループを追加。

```typescript
.addSubcommandGroup((group) =>
  group
    .setName('workspace')
    .setDescription('ワークスペースを管理します')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('ワークスペースを登録します')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('ワークスペース名').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('path').setDescription('作業ディレクトリの絶対パス').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('ワークスペースを削除します')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('ワークスペース名').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('ワークスペース一覧を表示します'),
    ),
)
```

#### `index.ts`

主な変更点:

1. **起動時**: `WorkspaceStore` をインスタンス化し、マイグレーション処理を実行
2. **`/cc new`**: ワークスペース数に応じてフロー分岐
3. **ワークスペース選択イベント**: `cc_workspace_select` の `StringSelectMenu` イベントを処理
4. **`/cc workspace add|remove|list`**: ワークスペース管理コマンドの処理
5. **`/cc resume`**: 全ワークスペース横断でセッション一覧を取得
6. **`/cc report`**: 全ワークスペース横断でセッションを集約
7. **`createSession`**: ワークスペース情報を引数で受け取るように変更
8. **スレッド名**: `[ワークスペース名] Session: ...` のフォーマットに変更

---

## 6. エッジケース

| ケース | 対処 |
|--------|------|
| ワークスペースが 0 件で `/cc new` | 「ワークスペースが未登録です」と案内 |
| 同じ名前のワークスペースを登録しようとした | エラー「既に登録されています」 |
| 存在しないパスを登録しようとした | エラー「ディレクトリが見つかりません」 |
| パスが絶対パスでない | エラー「絶対パスを指定してください」 |
| ワークスペース名に使えない文字 | 英数字・ハイフン・アンダースコアのみ許可 |
| `workspaces.json` が壊れている | ログに警告を出し、空のリストとして扱う |
| `workspaces.json` のパーミッションエラー | 起動時にエラーメッセージを出力 |
| 登録済みワークスペースのパスが後から削除された | セッション作成時にディレクトリ存在チェックを行いエラーを返す |
| `/cc resume` 時にワークスペースが削除されていた場合 | セッションは表示するが、選択時にエラーを返す |
| ワークスペース選択メニューが 15 分で期限切れ | Discord が自動処理 |
| マイグレーション時に `WORK_DIR` のディレクトリ名が重複 | 末尾に数字を付与（例: `oshibako-2`） |
| ワークスペースが 25 件を超える | Discord の SelectMenu の制限のため先頭 25 件のみ表示 |

---

## 7. テスト方針

### 7.1 `infrastructure/workspace-store.test.ts`（新規）

- `add()` でワークスペースが追加され、`list()` で取得できる
- `add()` で JSON ファイルに永続化される
- `remove()` でワークスペースが削除される
- 同名のワークスペースを追加するとエラー
- `findByName()` で名前からワークスペースを検索できる
- `load()` で JSON ファイルから復元される
- JSON ファイルが存在しない場合は空リスト
- JSON ファイルが壊れている場合は空リスト + 警告

### 7.2 `domain/session.test.ts`（変更）

- コンストラクタで `workspaceName` が正しく保持される
- `workDir` が正しく保持される

### 7.3 `index.ts` 結合テスト

- `/cc new` でワークスペースが 1 件の場合、セレクトメニューなしでセッション作成
- `/cc new` でワークスペースが複数の場合、セレクトメニューが表示される
- `/cc workspace add` でワークスペースが追加される
- `/cc workspace remove` でワークスペースが削除される
- `/cc workspace list` でワークスペース一覧が表示される
- `/cc resume` で全ワークスペースのセッションが表示される

---

## 8. 実装順序

1. `infrastructure/workspace-store.ts` — ワークスペースの CRUD + JSON 永続化 + テスト
2. `domain/types.ts` — `Workspace` 型追加
3. `domain/session.ts` — `workspaceName` 保持 + テスト修正
4. `infrastructure/config.ts` — `WORK_DIR` を optional に + `workspacesFile` 追加
5. `infrastructure/slash-commands.ts` — `/cc workspace` サブコマンドグループ追加
6. `index.ts` — マイグレーション処理 + `/cc workspace` コマンド処理
7. `index.ts` — `/cc new` のフロー変更（セレクトメニュー対応）
8. `index.ts` — `/cc resume` の全ワークスペース横断対応
9. `index.ts` — `/cc report` の全ワークスペース横断対応
