# PoC（概念実証）計画：claude-discord-bridge

**プロジェクト名: `claude-discord-bridge`**

**本ドキュメントは PoC 範囲の計画を定義する。システム全体の設計は `01_SystemDesign.md` を参照。**

---

## 1. PoC の目的

本格実装に先立ち、システムの核心的な価値を最小構成で検証する。

> **PoC のゴール**
> スマートフォンの Discord から ClaudeCode に指示を送り、ClaudeCode が実際にコードを編集し、その結果が Discord に返ってくるという一連の体験が動作することを確認する。

---

## 2. PoC の範囲

複雑な機能をすべて削ぎ落とし、価値検証に必要な最小限の構成のみを実装する。

| PoC に含める | PoC では対応しない（本実装で対応） |
|-------------|----------------------------------|
| 通常のテキストチャンネルを使用 | フォーラムチャンネル + スレッド管理 |
| 単一セッション（1つの会話を継続） | 複数セッション / 並列実行 |
| テキスト送受信 + 2000文字分割 | フォルダ選択 UI（ドリルダウン） |
| 固定の作業ディレクトリ（`.env` で指定） | 会話フォーク（`!history` / `!fork`） |
| ユーザー ID 制限 + チャンネル ID 制限 + Bot 自身の無視 | 過去セッションの呼び出し（`!resume` / `!sessions`） |
| `!new` / `!interrupt` | Tailscale |
| 処理中の入力拒否 | |
| セッションの自動開始・自動継続 | |
| 途中経過のリアルタイム表示（ツール使用・拡張思考） | |
| 中断時のタイムアウト（SIGINT → SIGKILL フォールバック） | |

---

## 3. システム構成

システム全体設計と同じ 3 層だが、各層を最小構成に絞る。

| 層 | PoC での構成 |
|----|-------------|
| **① スマートフォン** | Discord アプリ（そのまま利用） |
| **② Discord Bot** | Node.js + discord.js + child_process。通常テキストチャンネルで動作 |
| **③ ClaudeCode** | `claude -p --session-id <ID> --output-format stream-json --dangerously-skip-permissions` をサブプロセスとして起動 |

---

## 4. 環境変数

PoC では以下の環境変数のみを使用する。

| 環境変数 | 説明 |
|----------|------|
| `DISCORD_TOKEN` | Discord Bot の認証トークン |
| `CHANNEL_ID` | Bot が動作するテキストチャンネルの ID |
| `ALLOWED_USER_IDS` | 操作を許可する Discord ユーザー ID（カンマ区切り） |
| `WORK_DIR` | ClaudeCode の作業ディレクトリ（固定値） |

---

## 5. ドメインモデル

詳細は `03_PoC_DomainModel.md` を参照。ここでは概要のみ示す。

### 5.1 中核オブジェクト

ドメインモデルは以下の 3 つの中核オブジェクトで構成される。

| オブジェクト | 責務 |
|-------------|------|
| **Session** | 会話の同一性を管理する（sessionId, workDir）。プロセスには関与しない |
| **ClaudeProcess** | `claude -p` 子プロセスのライフサイクルを管理する。会話の同一性には関与しない |
| **Orchestrator** | Session と ClaudeProcess を協調させる調整者。状態遷移の管理と中断待機中の排他制御を担う |

### 5.2 状態遷移

状態は Orchestrator が Session と ClaudeProcess の組み合わせから導出する。

```
Initial（セッション未開始）
    │
    │  PromptInput → Session.ensure() → ClaudeProcess.spawn()
    ▼
Busy（処理中）◄──────────────────┐
    │                              │
    │  プロセス正常/異常終了        │  PromptInput
    ▼                              │  → ClaudeProcess.spawn()
Idle（入力待ち）───────────────────┘
    │
    │  !new → Session.reset()
    ▼
Initial（セッション未開始）

Busy から中断する場合：

Busy ──!new/!interrupt──→ Interrupting ──プロセス終了──→ Idle or Initial
                           （中断待機中）                  （reason による）
```

Interrupting 状態は、interrupt() からプロセス終了までの排他区間として機能し、競合状態を構造的に防止する。

### 5.3 コマンド

| コマンド | 操作内容 |
|----------|----------|
| `!new` | セッション ID をリセットし、新しい会話を開始（Busy 時は Interrupting を経由） |
| `!interrupt` | 実行中のプロセスを中断（SIGINT 送信。Busy 時は Interrupting を経由） |
| （上記以外のテキスト） | ClaudeCode への入力として転送 |

### 5.4 メッセージ処理フロー

```
Discord メッセージ受信
    │
    ▼
[Bot 判定] ── Bot のメッセージ → 無視
    │
    ▼
[AccessControl] ── 拒否 → 無視
    │ 許可
    ▼
[Orchestrator.handleMessage(text)]
    ├─ コマンド分類 → 状態判定 → 操作実行
    └─ 結果をインフラストラクチャ層に通知

プロセス終了時：
[Orchestrator.onProcessEnd(exitCode)]
    └─ interruptReason に応じた後処理 → 結果を通知
```

詳細な状態遷移表とフロー図は `03_PoC_DomainModel.md` Section 3.5 / 5 を参照。

---

## 6. 完了条件

以下のシナリオがスマートフォンから動作することをもって PoC 完了とする。

1. Discord でテキストを送信すると、セッションが自動的に開始され ClaudeCode が応答を返す
2. 続けてテキストを送信すると、前の会話の続きとして ClaudeCode が応答する
3. 「このファイルにテスト追加して」のような指示で、実際にコードが編集される
4. 処理中にツール使用や拡張思考の途中経過が Discord にリアルタイムで表示される
5. 長い応答が 2000 文字ごとに分割されて送信される
6. 処理中に入力すると「処理中です」と返される
7. `!interrupt` で処理中のタスクが中断される
8. 処理中に `!new` を送ると、実行中の処理が中断され新しいセッションが開始される
9. `!new` で新しいセッションが開始され、以前の会話とは独立した会話になる
