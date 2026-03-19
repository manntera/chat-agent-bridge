# 過去セッション再開機能の設計

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `07_PoC_Improvements.md` — PoC ブラッシュアップ記録

**本ドキュメントの位置づけ：** `/cc resume` サブコマンドによる過去セッション再開機能の設計仕様を定義する。

---

## 1. 概要

### 1.1 目的

現在のシステムでは `/cc new` でセッションを開始するたびに新しい UUID が生成され、過去のセッションを継続する手段がない。本機能により、過去に作成したセッションを一覧から選択し、会話を再開できるようにする。

### 1.2 ユーザー体験

```
User: /cc resume

Bot (ephemeral):
  再開するセッションを選択してください:
  ┌────────────────────────────────────────┐
  │ ▼ セッションを選択してください         │
  │  ・テスト追加して        (2026-03-19)  │
  │  ・リファクタリングお... (2026-03-18)  │
  │  ・バグ修正: ログイン... (2026-03-17)  │
  └────────────────────────────────────────┘

User: (ドロップダウンからセッションを選択)

Bot (ephemeral を更新):
  セッション `0351e524...` を再開しました。メッセージを送信してください。

User: 前回の続きで、エラーハンドリングも追加して

Bot: (ClaudeCode が過去の会話コンテキストを引き継いで応答)
```

---

## 2. 技術的背景

### 2.1 Claude CLI のセッション管理

Claude CLI はセッション履歴を以下のパスに JSONL 形式で保存する。

```
~/.claude/projects/<project-path>/<session-id>.jsonl
```

- `<project-path>`: 作業ディレクトリのパスを `/` → `-` に置換したもの
  - 例: `/home/manntera/works/claude-discord-bridge/server` → `-home-manntera-works-claude-discord-bridge-server`
- `<session-id>`: UUID 形式のセッション識別子

### 2.2 JSONL ファイルの構造

各行は JSON オブジェクト。主要なフィールド:

```jsonc
// ユーザーメッセージの例
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "テスト追加して"
  },
  "timestamp": "2026-03-19T05:43:46.377Z",
  "sessionId": "0351e524-f748-480c-b602-8f40c6f9fe54"
}
```

### 2.3 既存の resume 機構

`ClaudeProcess.spawn()` は既に `resume: boolean` パラメータを持ち、`--resume <sessionId>` での起動をサポートしている。本機能はこの仕組みをそのまま活用する。

---

## 3. 設計

### 3.1 コマンドフロー

```
/cc resume (スラッシュコマンド)
    │
    ▼
AccessControl.check()
    │ 許可
    ▼
Orchestrator.state を確認
    │ busy / interrupting → 「処理中です」(ephemeral)
    │ initial / idle
    ▼
interaction.deferReply({ ephemeral: true })
    │
    ▼
SessionStore.listSessions(workDir)
    │ 空 → 「再開できるセッションがありません」
    │ 1件以上
    ▼
StringSelectMenu を組み立て
    │
    ▼
interaction.editReply({ content, components: [row] })
    │
    ▼
ユーザーがドロップダウンから選択
    │
    ▼
Events.InteractionCreate (isStringSelectMenu)
    │
    ▼
Orchestrator.state を再確認（選択中に状態変化した場合のガード）
    │ busy / interrupting → 「処理中のため再開できませんでした」
    │ initial / idle
    ▼
orchestrator.handleCommand({ type: 'resume', sessionId })
    │
    ▼
Session.restore(sessionId) → 状態: idle
    │
    ▼
interaction.update({ content: '再開しました', components: [] })
```

### 3.2 Discord インタラクション

Discord の StringSelectMenu を使用する。

- 最大 25 件のセッションを表示（Discord の制限）
- ラベル: 最初のユーザーメッセージ（最大 100 文字で切り詰め）
- 説明文: 最終更新日（`ja-JP` ロケール）
- 値: セッション ID
- メニューの `customId`: `cc_resume_select`
- 応答はすべて ephemeral（操作者にのみ表示）

### 3.3 状態遷移

`Orchestrator.handleCommand` に `resume` コマンドを追加:

| 現在の状態 | 入力 | 動作 |
|-----------|------|------|
| **Initial** | `resume` | `Session.reset()` → `Session.restore(sessionId)` → Idle |
| **Idle** | `resume` | `Session.reset()` → `Session.restore(sessionId)` → Idle |
| **Busy** | `resume` | 「処理中です」（※ スラッシュコマンド応答時点で拒否するため到達しない） |
| **Interrupting** | `resume` | 「処理中です」（同上） |

resume 後の状態は `idle`。次にユーザーがテキストメッセージを送信すると `--resume <sessionId>` で ClaudeCode が起動する。

---

## 4. 変更一覧

### 4.1 ドメイン層

#### `domain/types.ts`

新しい型の追加:

```typescript
export interface SessionSummary {
  sessionId: string;
  firstUserMessage: string;
  lastModified: Date;
}

export interface ISessionStore {
  listSessions(workDir: string): Promise<SessionSummary[]>;
}
```

`Command` 型に `resume` バリアントを追加:

```typescript
export type Command =
  | { type: 'new'; options: SessionOptions }
  | { type: 'interrupt' }
  | { type: 'prompt'; text: string }
  | { type: 'resume'; sessionId: string };
```

#### `domain/session.ts`

`restore()` メソッドを追加:

```typescript
restore(sessionId: string): void {
  this._sessionId = sessionId;
  this._isNew = false;
  this._options = {};
}
```

- `_isNew = false`: 次の `spawn()` で `--resume <sessionId>` を使用する
- `_options = {}`: 既存セッションのオプションは Claude CLI 側が管理するため空にする

#### `domain/orchestrator.ts`

`handleCommand` の switch に `resume` ケースを追加:

```typescript
case 'resume':
  if (state === 'initial' || state === 'idle') {
    this.session.reset();
    this.session.restore(command.sessionId);
    this.notify({ type: 'info', message: 'セッションを再開しました' });
  }
  break;
```

busy / interrupting の場合は `/cc resume` のスラッシュコマンド応答時点で拒否するため、Orchestrator には到達しない設計。

### 4.2 インフラストラクチャ層

#### `infrastructure/session-store.ts`（新規）

JSONL ファイルからセッション一覧を読み取るクラス。

```typescript
export class SessionStore implements ISessionStore {
  async listSessions(workDir: string): Promise<SessionSummary[]>;
}
```

**実装のポイント:**

- プロジェクトパス算出: `path.join(homedir(), '.claude', 'projects', workDir.replaceAll('/', '-'))`
- `*.jsonl` ファイルを列挙し、各ファイルから:
  - ファイル名から session ID を抽出
  - `fs.stat()` で最終更新日を取得
  - ファイルを行単位で読み、最初の `"type":"user"` 行からメッセージを抽出
- 最終更新日の降順でソート
- 先頭 25 件を返却
- ファイルが大きい（500KB+）ため、`readline` で逐次読み取りし、最初の user メッセージ発見時に中断する

#### `infrastructure/slash-commands.ts`

`resume` サブコマンドを追加:

```typescript
.addSubcommand((sub) =>
  sub.setName('resume').setDescription('過去のセッションを再開します'),
)
```

### 4.3 App 層

#### `app/interaction-handler.ts`

`toCommand` 関数の変更は不要。`resume` のインタラクションフローは 2 段階（スラッシュコマンド → セレクトメニュー）であり、非同期処理を含むため `index.ts` で直接ハンドリングする。

`toCommand` で `'resume'` は `null` を返し、`index.ts` 側で処理される。

### 4.4 エントリーポイント

#### `index.ts`

1. `SessionStore` をインスタンス化
2. `/cc resume` スラッシュコマンドの処理:
   - `deferReply({ ephemeral: true })` で応答を遅延
   - `sessionStore.listSessions(config.workDir)` でセッション一覧を取得
   - `StringSelectMenuBuilder` + `ActionRowBuilder` でドロップダウンを構築
   - `editReply` で送信
3. `StringSelectMenu` の選択イベント処理:
   - `isStringSelectMenu()` + `customId === 'cc_resume_select'` でフィルタ
   - `orchestrator.handleCommand({ type: 'resume', sessionId })` を呼び出し
   - `interaction.update()` でメニューを更新

---

## 5. エッジケース

| ケース | 対処 |
|--------|------|
| セッションが 0 件 | 「再開できるセッションがありません」(ephemeral) |
| JSONL ファイルが壊れている | その行をスキップ、ファイル全体が読めない場合はそのセッションをスキップ |
| user メッセージが無い JSONL | ラベルに「(メッセージなし)」と表示 |
| 26 件以上のセッション | 最新 25 件のみ表示（Discord の制限） |
| メニュー表示中に状態が busy に変化 | 選択時に `orchestrator.state` を再確認し拒否 |
| メニューが 15 分で期限切れ | Discord が自動処理（「This interaction failed」） |
| 最初のユーザーメッセージが 100 文字超 | 97 文字 + `...` に切り詰め |
| ディレクトリが存在しない | 空配列を返却（エラーにしない） |

---

## 6. テスト方針

### 6.1 ドメイン層

**`session.test.ts`:**
- `restore()` で指定した session ID がセットされる
- `restore()` 後の `isNew` は `false`
- `restore()` 後の `options` は空

**`orchestrator.test.ts`:**
- Initial + resume → Idle（session ID がセットされ、通知が送られる）
- Idle + resume → Idle（session が切り替わる）
- resume 後の prompt で `resume: true` で spawn される

### 6.2 インフラストラクチャ層

**`session-store.test.ts`:**
- JSONL ファイルから正しくセッション一覧を取得
- 最終更新日の降順でソート
- 最大 25 件に制限
- 空ディレクトリ → 空配列
- 存在しないディレクトリ → 空配列
- 壊れた JSONL 行をスキップ

**`slash-commands.test.ts`:**
- `resume` サブコマンドが定義されている

### 6.3 App 層 / 結合

**`interaction-handler.test.ts`:**
- `toCommand` で `'resume'` は `null` を返す

---

## 7. 実装順序

1. `domain/types.ts` — 型追加（他すべての基盤）
2. `domain/session.ts` + テスト — `restore()` メソッド
3. `domain/orchestrator.ts` + テスト — `resume` コマンド処理
4. `infrastructure/session-store.ts` + テスト — 新規ファイル
5. `infrastructure/slash-commands.ts` + テスト — サブコマンド追加
6. `app/interaction-handler.ts` + テスト — `resume` が null を返すことの確認
7. `index.ts` — 配線（StringSelectMenu の構築と選択イベント処理）
