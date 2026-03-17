# ドメインモデル：claude-discord-bridge PoC

**スコープ: PoC（概念実証）範囲のみ**

**本 PoC は技術検証を目的とした捨てるプロトタイプである。開発体験の検証は別途行う。**

---

## 1. 用語定義

| 用語 | 定義 |
|------|------|
| **セッション（Session）** | ClaudeCode との一連の会話。`--session-id` によって一意に識別される。本実装では Discord フォーラムスレッドと 1:1 対応するが、PoC では単一テキストチャンネル内に 1 つだけ存在する |
| **プロンプト** | ユーザーが ClaudeCode に送る指示テキスト |
| **コマンド** | `!` で始まるシステム制御用の入力（`!new`, `!interrupt`） |

---

## 2. PoC で実現すること / しないこと

### 2.1 実現すること

- Discord のテキストチャンネルを通じて、ClaudeCode と対話する
- メッセージを送るだけで自動的にセッションが開始・継続される
- 処理の中断やセッションのリセットをコマンドで制御する
- 許可されたユーザーのみが操作できる
- ClaudeCode の出力を Discord の制約に合わせて分割・送信する

### 2.2 実現しないこと

- フォーラムチャンネル / スレッド管理
- 複数セッション / 並列実行
- 会話フォーク（`!history` / `!fork`）
- フォルダ選択 UI（ドリルダウン）
- 過去セッションの呼び出し（`!resume` / `!sessions`）

---

## 3. ドメインオブジェクト

### 3.1 Session（会話の同一性）

ClaudeCode との会話の同一性を管理する。**プロセスのライフサイクルには関与しない。**

**属性：**

| 属性 | 型 | 説明 |
|------|----|------|
| sessionId | string \| null | `--session-id` に渡す識別子。null = セッション未開始 |
| workDir | string | ClaudeCode の作業ディレクトリ（`.env` の `WORK_DIR` で固定） |

**操作：**

| 操作 | 説明 |
|------|------|
| ensure() | sessionId が null なら新規生成して返す。既にあればそのまま返す |
| reset() | sessionId を null に戻す（次回の ensure() で新しい ID が生成される） |

**PoC での制約：** システム全体で 1 つだけ存在する。

### 3.2 ClaudeProcess（プロセスライフサイクル）

`claude -p` 子プロセスの起動・終了・中断を管理する。**会話の同一性には関与しない。**

**属性：**

| 属性 | 型 | 説明 |
|------|----|------|
| process | ChildProcess \| null | 実行中の子プロセスへの参照。null = プロセスなし |

**状態：** process の有無で決まる。明示的な状態変数は持たない。

- `process === null` → **Idle**（待機中）
- `process !== null` → **Busy**（処理中）

**操作：**

| 操作 | 前提条件 | 説明 |
|------|----------|------|
| spawn(prompt, sessionId, workDir) | Idle であること | `claude -p` を起動する。終了時にコールバックで結果を返す |
| interrupt() | Busy であること | SIGINT を送信し、プロセス終了を待機する。Promise を返す |

**不変条件：** 同時に存在するプロセスは最大 1 つ。

### 3.3 AccessControl（アクセス制御）

メッセージ処理の最初の関門。すべてのメッセージに対し、以下の条件を判定する。

| 条件 | 説明 |
|------|------|
| ユーザー ID | `.env` の `ALLOWED_USER_IDS` に含まれるか |
| チャンネル ID | `.env` の `CHANNEL_ID` と一致するか |

条件を満たさないメッセージは、一切の応答なく無視する。

### 3.4 Command（メッセージ分類）

Discord から届いたテキストを以下のいずれかに分類する。

| 種別 | トリガー | 説明 |
|------|----------|------|
| NewCommand | `!new` | セッションをリセットし、新しい会話を開始する |
| InterruptCommand | `!interrupt` | 実行中のプロセスを中断する |
| PromptInput | 上記以外のテキスト | ClaudeCode への入力として転送する |

---

## 4. ドメインルール

### 4.1 セッションの自動開始

ユーザーが初めてメッセージ（PromptInput）を送信した時点で、Session.ensure() により sessionId が自動生成される。明示的な開始コマンドは不要。

### 4.2 処理中の入力拒否

ClaudeProcess が Busy のとき、PromptInput は拒否する。`!interrupt` と `!new` は受け付ける。

### 4.3 `!new` の振る舞い

`!new` は Session と ClaudeProcess の状態の組み合わせにより振る舞いが異なる。

| sessionId | ClaudeProcess | 振る舞い |
|-----------|---------------|----------|
| null | Idle | 何もしない。「セッションがありません」と応答 |
| あり | Idle | Session.reset() → 「新しいセッションを開始しました」と応答 |
| あり | Busy | ClaudeProcess.interrupt() → **終了を待機** → Session.reset() → 応答 |

**重要：** Busy 時の `!new` は非同期の 2 段階処理である。interrupt() が返す Promise の解決を待ってから reset() を実行する。

### 4.4 `!interrupt` の振る舞い

| ClaudeProcess | 振る舞い |
|---------------|----------|
| Idle | 何もしない（応答なし） |
| Busy | ClaudeProcess.interrupt() → 「中断しました」と応答 |

### 4.5 アクセス制御の優先

アクセス制御の判定は、コマンド解析やセッション状態の確認よりも先に行う。許可されないユーザーからのメッセージは、コマンドの種別に関わらず無視する。

### 4.6 プロセス異常終了時の挙動

`claude -p` プロセスが異常終了（非ゼロの exit code）した場合：

1. エラー情報を Discord に送信する
2. ClaudeProcess は自動的に Idle に戻る（process = null）
3. Session の sessionId は維持される（次のメッセージで会話を継続可能）

---

## 5. メッセージ処理フロー

```
Discord メッセージ受信
    │
    ▼
[AccessControl] ── 拒否 → 無視（応答なし）
    │ 許可
    ▼
[Command 分類]
    │
    ├─ NewCommand
    │      ├─ sessionId == null         → 「セッションがありません」応答
    │      ├─ sessionId あり & Idle     → Session.reset() → 確認応答
    │      └─ sessionId あり & Busy     → ClaudeProcess.interrupt()
    │                                        → 終了待機
    │                                        → Session.reset() → 確認応答
    │
    ├─ InterruptCommand
    │      ├─ Idle → 無視
    │      └─ Busy → ClaudeProcess.interrupt() → 「中断しました」応答
    │
    └─ PromptInput
           ├─ Busy → 「処理中です」応答
           └─ Idle → Session.ensure()
                       → ClaudeProcess.spawn(prompt, sessionId, workDir)
                       → 正常終了: 結果を Discord に送信
                       → 異常終了: エラーを Discord に送信
```

---

## 6. インフラストラクチャ層の関心事

以下はドメインモデルの外側の責務として扱う。PoC では密結合になっても構わないが、関心事の区別は意識する。

### 6.1 応答フォーマッティング

ドメインイベントを Discord メッセージに変換する責務。

| 変換元 | Discord への出力 |
|--------|------------------|
| ClaudeProcess の正常完了 | ClaudeCode の応答テキスト |
| ClaudeProcess の異常終了 | エラー通知メッセージ |
| Session.reset() の実行 | 「新しいセッションを開始しました」 |
| Busy 時の PromptInput | 「処理中です」 |
| sessionId == null 時の `!new` | 「セッションがありません」 |

### 6.2 メッセージ分割

Discord のメッセージ上限（2000文字）を超える場合、複数メッセージに分割して送信する。分割ロジックはドメインの関心事ではなく、Discord 連携層が担う。

### 6.3 stream-json のパース

`--output-format stream-json` の出力をパースしてテキストを抽出する処理。ClaudeProcess と Discord 連携層の間に位置する。

---

## 7. 環境変数（PoC）

| 環境変数 | 説明 |
|----------|------|
| `DISCORD_TOKEN` | Discord Bot の認証トークン |
| `CHANNEL_ID` | Bot が動作するテキストチャンネルの ID |
| `ALLOWED_USER_IDS` | 操作を許可する Discord ユーザー ID（カンマ区切り） |
| `WORK_DIR` | ClaudeCode の作業ディレクトリ（固定値） |
