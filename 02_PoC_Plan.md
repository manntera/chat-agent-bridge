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

ドメインモデルは以下の 2 つの中核オブジェクトで構成される。

| オブジェクト | 責務 |
|-------------|------|
| **Session** | 会話の同一性を管理する（sessionId, workDir）。プロセスには関与しない |
| **ClaudeProcess** | `claude -p` 子プロセスのライフサイクルを管理する。会話の同一性には関与しない |

### 5.2 状態遷移

状態は ClaudeProcess のプロセスの有無で決まる。

```
Idle（プロセスなし）◄────────┐
    │                          │
    │  PromptInput             │  プロセス終了（正常/異常）
    │  → Session.ensure()      │
    │  → ClaudeProcess.spawn() │
    ▼                          │
Busy（プロセスあり）──────────┘
    │
    │  !interrupt → ClaudeProcess.interrupt() → プロセス終了
    ▼
Idle（プロセスなし）
```

初回のユーザー入力時に Session.ensure() でセッション ID が自動生成され、以降は同じセッション ID で会話が継続する。

### 5.3 コマンド

| コマンド | 操作内容 |
|----------|----------|
| `!new` | セッション ID をリセットし、新しい会話を開始（Busy 時は中断→待機→リセット） |
| `!interrupt` | 実行中のプロセスを中断（SIGINT 送信） |
| （上記以外のテキスト） | ClaudeCode への入力として転送 |

### 5.4 メッセージ処理フロー

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
[Command 分類]
    │
    ├─ NewCommand ──────→ sessionId なし: 無視
    │                     Idle: Session.reset()
    │                     Busy: ClaudeProcess.interrupt() → 終了待機 → Session.reset()
    ├─ InterruptCommand → Busy なら中断 / Idle なら無視
    └─ PromptInput ────→ Idle なら Session.ensure() → ClaudeProcess.spawn()
                          Busy なら「処理中です」応答
```

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
