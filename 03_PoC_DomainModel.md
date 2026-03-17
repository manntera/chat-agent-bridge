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
| spawn(prompt, sessionId, workDir) | Idle であること | `claude -p` を起動する。イベント駆動で途中経過・完了を通知する（下記参照） |
| interrupt() | Busy であること | SIGINT を送信し、プロセス終了を待機する。タイムアウト（10秒）後は SIGKILL で強制終了する。Promise を返す |

**spawn() の通知メカニズム：**

Node.js の `child_process.spawn()` が返す ChildProcess は EventEmitter である。この特性を利用し、以下のイベントで上位に通知する。

| イベント | ソース | 用途 |
|----------|--------|------|
| stdout `'data'` | プロセスの標準出力 | stream-json の各行をパースし、途中経過（ツール使用・拡張思考）を Discord に送信 |
| `'close'` | プロセス終了 | 最終結果の送信、状態を Idle に戻す |
| `'error'` | プロセス起動失敗 | エラー通知、状態を Idle に戻す |

**不変条件：** 同時に存在するプロセスは最大 1 つ。

### 3.3 AccessControl（アクセス制御）

メッセージ処理の最初の関門。すべてのメッセージに対し、以下の条件を判定する。

| 条件 | 説明 |
|------|------|
| Bot 自身 | `message.author.bot` が true なら無視（無限ループ防止） |
| ユーザー ID | `.env` の `ALLOWED_USER_IDS` に含まれるか |
| チャンネル ID | `.env` の `CHANNEL_ID` と一致するか |

判定は上から順に行い、条件を満たさないメッセージは一切の応答なく無視する。

### 3.4 Command（メッセージ分類）

Discord から届いたテキストを以下のいずれかに分類する。

| 種別 | トリガー | 説明 |
|------|----------|------|
| NewCommand | `!new` | セッションをリセットし、新しい会話を開始する |
| InterruptCommand | `!interrupt` | 実行中のプロセスを中断する |
| PromptInput | 上記以外のテキスト | ClaudeCode への入力として転送する |

### 3.5 Orchestrator（メッセージ処理の調整者）

Session と ClaudeProcess を協調させ、メッセージ処理の一貫性を保証する中核オブジェクト。AccessControl 通過後のメッセージを受け取り、**コマンド分類 → 状態判定 → 操作実行 → 結果通知**の一連の流れを制御する。

**責務の境界：**

- **やること：** Session と ClaudeProcess の協調、状態遷移の管理、中断待機中の排他制御
- **やらないこと：** Discord との通信、メッセージ分割、stream-json のパース（これらはインフラストラクチャ層）

**属性：**

| 属性 | 型 | 説明 |
|------|----|------|
| session | Session | 会話の同一性を管理するオブジェクト |
| claudeProcess | ClaudeProcess | プロセスライフサイクルを管理するオブジェクト |
| interruptReason | `'new'` \| `'interrupt'` \| null | 中断の理由。Interrupting 状態でのみ非 null |

**導出状態：** Orchestrator 自身は明示的な状態変数を持たない。Session と ClaudeProcess の組み合わせから状態が導出される。

| 状態 | 条件 | 意味 |
|------|------|------|
| **Initial** | sessionId == null かつ process == null | セッション未開始 |
| **Idle** | sessionId != null かつ process == null | 入力待ち |
| **Busy** | process != null かつ interruptReason == null | ClaudeCode 処理中 |
| **Interrupting** | process != null かつ interruptReason != null | 中断待機中（遷移途中の状態） |

**操作：**

| 操作 | 説明 |
|------|------|
| handleMessage(text) | AccessControl 通過後のメッセージを受け取り、コマンド分類・状態判定・操作実行を行う |
| onProcessEnd(exitCode) | ClaudeProcess 終了時のコールバック。interruptReason に応じた後処理を行う |

**状態遷移表：**

ユーザー入力による遷移：

| 現在の状態 | 入力 | アクション | 遷移先 | 通知 |
|-----------|------|-----------|--------|------|
| Initial | PromptInput | Session.ensure() → ClaudeProcess.spawn() | Busy | — |
| Initial | NewCommand | — | Initial | 「セッションがありません」 |
| Initial | InterruptCommand | — | Initial | （なし） |
| Idle | PromptInput | ClaudeProcess.spawn() | Busy | — |
| Idle | NewCommand | Session.reset() | Initial | 「新しいセッションを開始しました」 |
| Idle | InterruptCommand | — | Idle | （なし） |
| Busy | PromptInput | — | Busy | 「処理中です」 |
| Busy | NewCommand | interruptReason='new', ClaudeProcess.interrupt() | Interrupting | — |
| Busy | InterruptCommand | interruptReason='interrupt', ClaudeProcess.interrupt() | Interrupting | — |
| Interrupting | PromptInput | — | Interrupting | 「処理中です」 |
| Interrupting | NewCommand | — | Interrupting | （なし。既に中断処理中） |
| Interrupting | InterruptCommand | — | Interrupting | （なし。既に中断処理中） |

プロセス終了による遷移：

| 現在の状態 | イベント | アクション | 遷移先 | 通知 |
|-----------|---------|-----------|--------|------|
| Busy | プロセス正常終了 | — | Idle | 結果テキスト |
| Busy | プロセス異常終了 | — | Idle | エラー情報 |
| Interrupting | プロセス終了（reason='new'） | Session.reset(), interruptReason=null | Initial | 「新しいセッションを開始しました」 |
| Interrupting | プロセス終了（reason='interrupt'） | interruptReason=null | Idle | 「中断しました」 |

**補足：** Busy 状態中の途中経過イベント（ツール使用・拡張思考）は状態遷移を起こさず、そのままインフラストラクチャ層に通知される。Interrupting 状態中に到着した途中経過も同様に通知する（プロセスが終了するまで出力は継続しうるため）。

**不変条件：**

- Orchestrator はシステム全体で 1 つだけ存在する（Session と同様）
- interruptReason が非 null のとき、ClaudeProcess は必ず Busy である

---

## 4. ドメインルール

### 4.1 セッションの自動開始

ユーザーが初めてメッセージ（PromptInput）を送信した時点で、Session.ensure() により sessionId が自動生成される。明示的な開始コマンドは不要。

### 4.2 処理中の入力拒否

Orchestrator が Busy または Interrupting のとき、PromptInput は拒否する。`!interrupt` と `!new` は Busy のときのみ受け付ける（Interrupting 中は無視する）。

### 4.3 `!new` の振る舞い

Orchestrator の状態により振る舞いが異なる。

| 状態 | 振る舞い |
|------|----------|
| Initial | 何もしない。「セッションがありません」と応答 |
| Idle | Session.reset() → 「新しいセッションを開始しました」と応答 |
| Busy | interruptReason='new' を設定 → ClaudeProcess.interrupt() → **Interrupting に遷移** |
| Interrupting | 無視（既に中断処理中） |

**重要：** Busy → Interrupting は即座に遷移するが、Session.reset() は**プロセス終了後**に Orchestrator.onProcessEnd() 内で実行される。この 2 段階処理により、プロセスの正常なクリーンアップが保証される。

### 4.4 `!interrupt` の振る舞い

| 状態 | 振る舞い |
|------|----------|
| Initial / Idle | 何もしない（応答なし） |
| Busy | interruptReason='interrupt' を設定 → ClaudeProcess.interrupt() → **Interrupting に遷移** |
| Interrupting | 無視（既に中断処理中） |

### 4.5 アクセス制御の優先

アクセス制御の判定は、コマンド解析やセッション状態の確認よりも先に行う。許可されないユーザーからのメッセージは、コマンドの種別に関わらず無視する。

### 4.6 プロセス終了時の挙動（Orchestrator.onProcessEnd）

プロセス終了時の挙動は Orchestrator の状態と interruptReason の組み合わせで決まる。

| 終了時の状態 | interruptReason | 挙動 |
|-------------|-----------------|------|
| Busy | null（自然終了） | 正常終了: 結果を通知。異常終了: エラーを通知。sessionId は維持 |
| Interrupting | 'interrupt' | 「中断しました」を通知。sessionId は維持 |
| Interrupting | 'new' | Session.reset() を実行 →「新しいセッションを開始しました」を通知 |

いずれの場合も、ClaudeProcess は Idle に戻り、interruptReason は null にリセットされる。

### 4.7 Interrupting 状態による競合状態の防止

Interrupting 状態は、interrupt() 呼び出しからプロセス終了までの間に到着するメッセージを安全に処理するための排他区間として機能する。

- PromptInput → 「処理中です」で拒否
- NewCommand / InterruptCommand → 無視（既に中断処理中）

これにより、「interrupt 待機中に spawn が走る」「reset 前に新しい入力が処理される」といった競合が構造的に排除される。

**PoC での方針：** Interrupting 状態のチェックは同期的なフラグ判定で実装する。Node.js のシングルスレッドモデルにより、handleMessage() の実行中にプロセス終了コールバックが割り込むことはないため、ロック機構は不要である。

---

## 5. メッセージ処理フロー

メッセージ処理は 2 つのフローで構成される。Orchestrator.handleMessage()（同期的な入力処理）と Orchestrator.onProcessEnd()（非同期なプロセス終了処理）である。

### 5.1 handleMessage() フロー

```
Discord メッセージ受信
    │
    ▼
[Bot 判定] ── Bot のメッセージ → 無視（無限ループ防止）
    │ 人間のメッセージ
    ▼
[AccessControl] ── 拒否 → 無視（応答なし）
    │ 許可
    ▼
[Orchestrator.handleMessage(text)]
    │
    ├─ [Command 分類]
    │
    ├─ NewCommand
    │      ├─ Initial       → 「セッションがありません」通知
    │      ├─ Idle          → Session.reset() → 「新しいセッションを開始しました」通知
    │      ├─ Busy          → interruptReason='new'
    │      │                    → ClaudeProcess.interrupt()
    │      │                    → 状態: Interrupting（後続は onProcessEnd で処理）
    │      └─ Interrupting  → 無視
    │
    ├─ InterruptCommand
    │      ├─ Initial/Idle  → 無視
    │      ├─ Busy          → interruptReason='interrupt'
    │      │                    → ClaudeProcess.interrupt()
    │      │                    → 状態: Interrupting（後続は onProcessEnd で処理）
    │      └─ Interrupting  → 無視
    │
    └─ PromptInput
           ├─ Busy/Interrupting → 「処理中です」通知
           └─ Initial/Idle      → Session.ensure()
                                    → ClaudeProcess.spawn(prompt, sessionId, workDir)
                                    → 状態: Busy（後続は onProcessEnd で処理）
```

### 5.2 onProcessEnd() フロー

```
ClaudeProcess 終了（close イベント）
    │
    ▼
[Orchestrator.onProcessEnd(exitCode)]
    │
    ├─ interruptReason == null（自然終了）
    │      ├─ 正常終了 → 結果テキストを通知
    │      └─ 異常終了 → エラー情報を通知
    │      → 状態: Idle
    │
    ├─ interruptReason == 'interrupt'
    │      → 「中断しました」通知
    │      → interruptReason = null
    │      → 状態: Idle
    │
    └─ interruptReason == 'new'
           → Session.reset()
           → 「新しいセッションを開始しました」通知
           → interruptReason = null
           → 状態: Initial
```

**補足：** Busy 状態中、ClaudeProcess の stdout から到着する途中経過（ツール使用・拡張思考）は、Orchestrator を経由してインフラストラクチャ層に通知される。これは状態遷移を伴わない。

---

## 6. インフラストラクチャ層の関心事

以下はドメインモデルの外側の責務として扱う。PoC では密結合になっても構わないが、関心事の区別は意識する。

### 6.1 応答フォーマッティング

ドメインイベントを Discord メッセージに変換する責務。

| 変換元 | Discord への出力 |
|--------|------------------|
| ツール呼び出し検知 | ツール名＋対象（例: `🔧 Edit: src/index.ts`） |
| 拡張思考検知 | 思考内容テキスト |
| ClaudeProcess の正常完了 | ClaudeCode の応答テキスト |
| ClaudeProcess の異常終了 | エラー通知メッセージ |
| Session.reset() の実行 | 「新しいセッションを開始しました」 |
| Busy 時の PromptInput | 「処理中です」 |
| sessionId == null 時の `!new` | 「セッションがありません」 |

### 6.2 メッセージ分割

Discord のメッセージ上限（2000文字）を超える場合、複数メッセージに分割して送信する。分割ロジックはドメインの関心事ではなく、Discord 連携層が担う。

### 6.3 stream-json のパースと出力方針

`--output-format stream-json` の出力をパースし、Discord に送信する内容を決定する処理。ClaudeProcess と Discord 連携層の間に位置する。

**出力の分類：**

| 出力種別 | 内容 | 表示タイミング | Discord への送信方法 |
|----------|------|---------------|---------------------|
| **途中経過（ツール使用）** | ツール名＋対象（例: `🔧 Edit: src/index.ts`、`🔧 Bash: npm test`） | ツール呼び出し検知時にリアルタイム | 新規メッセージとして追記 |
| **途中経過（拡張思考）** | ClaudeCode の思考内容（thinking） | 思考ブロック検知時にリアルタイム | 新規メッセージとして追記 |
| **最終結果** | ClaudeCode の回答テキスト | プロセス完了時 | 新規メッセージとして追記（2000文字分割） |

**方針：** 途中経過は処理中にリアルタイムで Discord に追記送信する。メッセージの編集（上書き更新）は行わない。

---

## 7. 環境変数（PoC）

| 環境変数 | 説明 |
|----------|------|
| `DISCORD_TOKEN` | Discord Bot の認証トークン |
| `CHANNEL_ID` | Bot が動作するテキストチャンネルの ID |
| `ALLOWED_USER_IDS` | 操作を許可する Discord ユーザー ID（カンマ区切り） |
| `WORK_DIR` | ClaudeCode の作業ディレクトリ（固定値） |
