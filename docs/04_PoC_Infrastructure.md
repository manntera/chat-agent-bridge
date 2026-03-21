> **注意**: このドキュメントは PoC 設計時に作成されたものです。テキストコマンド（`!new` 等）はスラッシュコマンド（`/cc new` 等）に置き換えられるなど、現在の実装とは異なる部分があります。最新の使い方は [README.md](../README.md) を参照してください。

# インフラストラクチャ層の設計：chat-agent-bridge PoC

**スコープ: PoC（概念実証）範囲のみ**

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計（背景・目標・技術決定）
- `02_PoC_Plan.md` — PoC の範囲と完了条件
- `03_PoC_DomainModel.md` — ドメインモデルの詳細仕様

**本ドキュメントの位置づけ：** ドメインモデル（`03_PoC_DomainModel.md`）で定義されたインターフェースと責務境界に基づき、外部システム（Discord API、claude CLI プロセス）との接続を担うインフラストラクチャ層の設計方針を定める。

---

## 1. インフラストラクチャ層の役割

### 1.1 ドメイン層との関係

本プロジェクトは **ドメイン層** と **インフラストラクチャ層** の 2 層で構成される。

| 層 | 責務 | 具体例 |
|----|------|--------|
| **ドメイン層** | ビジネスロジック。状態遷移・コマンド解釈・アクセス制御の判定ルール | Orchestrator, Session, AccessControl, Command |
| **インフラストラクチャ層** | 外部システムとの通信。ドメインが定義したインターフェースの実装 | Discord メッセージ送受信、claude CLI サブプロセス管理、環境変数読み込み |

ドメイン層はインフラストラクチャ層に依存しない。代わりに **インターフェース（ポート）** を定義し、インフラストラクチャ層がその実装を提供する。これにより、ドメインロジックのテストを外部システムなしで実行できる。

### 1.2 ドメイン層が定義するインターフェース

ドメイン層は以下の 2 つのインターフェースをインフラストラクチャ層に対して公開している（`src/domain/types.ts`）。

**IClaudeProcess — claude CLI プロセスの抽象化：**

```typescript
export interface IClaudeProcess {
  readonly isRunning: boolean;
  spawn(prompt: string, sessionId: string, workDir: string): void;
  interrupt(): void;
}
```

- `isRunning`: プロセスが実行中かどうか。Orchestrator の状態導出に使用される
- `spawn()`: 新しい claude CLI プロセスを起動する
- `interrupt()`: 実行中のプロセスを中断する

**NotifyFn — ドメインイベントの通知先：**

```typescript
export type NotifyFn = (notification: Notification) => void;
```

Orchestrator が外部に通知を送る際のコールバック関数。ドメイン層は「通知する」という行為だけを知っており、通知先が Discord であることは知らない。

**Notification — 通知の種別：**

```typescript
export type Notification =
  | { type: 'info'; message: string }                      // 情報メッセージ（「処理中です」等）
  | { type: 'result'; text: string }                       // ClaudeCode の応答結果
  | { type: 'error'; message: string; exitCode: number }   // エラー情報
  | { type: 'progress'; event: ProgressEvent };            // 途中経過
```

**ProgressEvent — 途中経過の種別：**

```typescript
export type ProgressEvent =
  | { kind: 'tool_use'; toolName: string; target: string }  // ツール使用
  | { kind: 'thinking'; text: string };                      // 拡張思考
```

### 1.3 インフラストラクチャ層が埋める責務

ドメインモデル（`03_PoC_DomainModel.md` Section 6）で「インフラストラクチャ層の関心事」として列挙された以下の責務を実装する。

| 責務 | 対応するコンポーネント |
|------|------------------------|
| `IClaudeProcess` の実装（サブプロセス管理） | `ClaudeProcess` |
| stream-json のパース（stdout の解析） | `StreamJsonParser` |
| 応答フォーマッティング（ドメインイベント → Discord メッセージ） | `DiscordNotifier` |
| メッセージ分割（2000文字制限） | `DiscordNotifier` |
| 環境変数の読み込み・バリデーション | `Config` |
| 全コンポーネントの配線（コンポジションルート） | `index.ts` |

---

## 2. ファイル構成

```
server/src/
├── domain/                               # ドメイン層（既存・変更なし）
│   ├── types.ts                          #   型定義（IClaudeProcess, Notification 等）
│   ├── command.ts                        #   コマンド解析
│   ├── session.ts                        #   セッション管理
│   ├── access-control.ts                 #   アクセス制御
│   ├── orchestrator.ts                   #   メッセージ処理の調整者
│   └── *.test.ts                         #   各ドメインオブジェクトのテスト
│
├── infrastructure/                       # インフラストラクチャ層（新規作成）
│   ├── config.ts                         #   環境変数の読み込み・バリデーション
│   ├── config.test.ts                    #   Config のユニットテスト
│   ├── stream-json-parser.ts             #   claude CLI の stream-json 出力パーサー
│   ├── stream-json-parser.test.ts        #   パーサーのユニットテスト
│   ├── claude-process.ts                 #   IClaudeProcess 実装（child_process）
│   ├── claude-process.test.ts            #   ClaudeProcess のユニットテスト
│   ├── discord-notifier.ts              #   NotifyFn 実装（Discord 送信 + 2000文字分割）
│   └── discord-notifier.test.ts         #   DiscordNotifier のユニットテスト
│
└── index.ts                              # コンポジションルート（書き換え）
```

**設計方針：** ドメイン層と同様にフラットな構成とする。各ファイルは 1 つの明確な責務を持ち、サブディレクトリは設けない。

---

## 3. 各コンポーネントの設計

### 3.1 Config — 環境変数の読み込み

**ファイル:** `src/infrastructure/config.ts`

**責務：** `.env` ファイルから環境変数を読み込み、型付きの設定オブジェクトとして返す。必須項目が欠落している場合は即座にエラーで停止する（fail-fast）。

**公開インターフェース：**

```typescript
export interface Config {
  discordToken: string;      // Discord Bot の認証トークン
  channelId: string;         // Bot が動作するテキストチャンネル ID
  allowedUserIds: string[];  // 操作を許可するユーザー ID の配列
  workDir: string;           // ClaudeCode の作業ディレクトリ
  claudePath: string;        // claude CLI のパス（デフォルト: 'claude'）
}

export function loadConfig(): Config;
```

**設計判断：**

| 項目 | 判断 | 理由 |
|------|------|------|
| 環境変数ライブラリ | `dotenv` を使用 | Node.js バージョンに依存しない確実な方法。PoC では依存関係の最小化よりも確実な動作を優先する |
| `ALLOWED_USER_IDS` のパース | カンマ区切りで split し、各値を trim | `.env` に `ALLOWED_USER_IDS=123,456,789` の形式で記述する |
| `WORK_DIR` の存在確認 | 行わない | claude CLI 自身がディレクトリの妥当性を検証するため、二重チェックは不要 |
| `CLAUDE_PATH` のデフォルト値 | `'claude'` | PATH が通っている環境ではコマンド名だけで十分 |

---

### 3.2 StreamJsonParser — stream-json 出力のパース

**ファイル:** `src/infrastructure/stream-json-parser.ts`

**責務：** claude CLI の `--output-format stream-json` が stdout に出力する 1 行の JSON を受け取り、ドメインの `ProgressEvent` 型または結果テキストに変換する。

#### 3.2.1 stream-json 形式について

claude CLI に `--output-format stream-json` オプションを付けて実行すると、stdout に改行区切りの JSON オブジェクト（NDJSON）が出力される。主なイベントは以下の通り。

**システム初期化：**

```json
{"type":"system","subtype":"init","session_id":"...","tools":["..."]}
```

**ツール使用の検知：**

```json
{"type":"assistant","subtype":"tool_use","tool":{"name":"Edit","input":{"file_path":"src/index.ts","old_string":"...","new_string":"..."}}}
```

**拡張思考：**

```json
{"type":"assistant","subtype":"thinking","content":[{"type":"thinking","thinking":"Let me analyze the code..."}]}
```

**最終結果：**

```json
{"type":"result","subtype":"success","result":"回答テキスト","session_id":"...","is_error":false}
```

> **注意：** stream-json の形式は claude CLI のバージョンにより変更される可能性がある。パーサーは未知のイベントを安全に無視する設計とし、形式変更への耐性を確保する。

#### 3.2.2 パーサーの公開インターフェース

```typescript
import type { ProgressEvent } from '../domain/types.js';

export type ParsedEvent =
  | { kind: 'progress'; event: ProgressEvent }
  | { kind: 'result'; text: string }
  | { kind: 'ignored' };

export function parseStreamJsonLine(line: string): ParsedEvent;
```

**戻り値の分類：**

| ParsedEvent の kind | 発生条件 | 用途 |
|---------------------|----------|------|
| `'progress'` | ツール使用または拡張思考を検知 | Orchestrator.onProgress() に渡す |
| `'result'` | 最終結果を検知 | Orchestrator.onProcessEnd() に渡す結果テキストとして保持 |
| `'ignored'` | 未知のイベント、システムイベント、パース失敗 | 何もしない |

#### 3.2.3 ツール使用イベントの target 抽出ルール

ツール使用イベントでは、ツール名に応じて `target`（操作対象の概要）を抽出する。ユーザーが「今何をしているか」を直感的に把握できるようにするための処理である。

| ツール名 | target の抽出元 | 表示例 |
|----------|----------------|--------|
| Edit, Read, Write | `input.file_path` | `🔧 Edit: src/index.ts` |
| Bash | `input.command`（100文字で切り詰め） | `🔧 Bash: npm test` |
| Glob, Grep | `input.pattern` | `🔧 Grep: TODO` |
| その他 | ツール名をそのまま使用 | `🔧 Agent: (unknown)` |

#### 3.2.4 テスト方針

`parseStreamJsonLine()` は副作用のない純粋関数であり、ユニットテストに最適である。インフラストラクチャ層で唯一のテスト対象ファイルとする。

**テストケース：**

| テストケース | 入力 | 期待される出力 |
|-------------|------|---------------|
| Edit ツール使用 | `{"type":"assistant","subtype":"tool_use","tool":{"name":"Edit","input":{"file_path":"src/index.ts"}}}` | `{ kind: 'progress', event: { kind: 'tool_use', toolName: 'Edit', target: 'src/index.ts' } }` |
| Bash ツール使用 | `{"type":"assistant","subtype":"tool_use","tool":{"name":"Bash","input":{"command":"npm test"}}}` | `{ kind: 'progress', event: { kind: 'tool_use', toolName: 'Bash', target: 'npm test' } }` |
| 拡張思考 | `{"type":"assistant","subtype":"thinking","content":[{"type":"thinking","thinking":"分析中..."}]}` | `{ kind: 'progress', event: { kind: 'thinking', text: '分析中...' } }` |
| 最終結果 | `{"type":"result","result":"回答テキスト"}` | `{ kind: 'result', text: '回答テキスト' }` |
| システムイベント | `{"type":"system","subtype":"init"}` | `{ kind: 'ignored' }` |
| 不正な JSON | `not a json` | `{ kind: 'ignored' }` |
| 空文字列 | `""` | `{ kind: 'ignored' }` |

> **設計判断：** stream-json の形式は公式に文書化されていない部分があるため、テストフィクスチャが「期待する形式の仕様書」としても機能する。CLI バージョン更新時はテストフィクスチャを更新することで対応する。

---

### 3.3 ClaudeProcess — IClaudeProcess の実装

**ファイル:** `src/infrastructure/claude-process.ts`

**責務：** ドメイン層が定義する `IClaudeProcess` インターフェースを実装し、Node.js の `child_process.spawn()` を使って claude CLI サブプロセスのライフサイクルを管理する。

#### 3.3.1 クラス設計

```typescript
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { IClaudeProcess, ProgressEvent } from '../domain/types.js';
import { parseStreamJsonLine } from './stream-json-parser.js';

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export class ClaudeProcess implements IClaudeProcess {
  private process: ChildProcess | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly claudePath: string,
    private readonly onProgress: (event: ProgressEvent) => void,
    private readonly onProcessEnd: (exitCode: number, output: string) => void,
    private readonly spawnFn: SpawnFn = nodeSpawn,
  ) {}

  get isRunning(): boolean {
    return this.process !== null;
  }

  spawn(prompt: string, sessionId: string, workDir: string): void { ... }
  interrupt(): void { ... }
}
```

**テスタビリティのための設計判断：** `spawnFn` をコンストラクタの最終引数として注入可能にし、デフォルト値に `node:child_process` の `spawn` を設定する。本番コードは引数を省略してそのまま使い、テストコードではモック関数を注入することで、実際のプロセスを起動せずにライフサイクル管理ロジックを検証できる。

#### 3.3.2 spawn() の処理フロー

```
spawn(prompt, sessionId, workDir)
    │
    ├─ [ガード] this.process !== null → return（二重起動防止）
    │
    ├─ child_process.spawn() で claude CLI を起動
    │    コマンド: claude -p <prompt>
    │    引数: --session-id <sessionId>
    │          --output-format stream-json
    │          --dangerously-skip-permissions
    │    オプション: { cwd: workDir }
    │
    ├─ stdout の 'data' イベントを監視
    │    │
    │    ├─ 受信データをバッファに追加
    │    ├─ 改行で分割し、完全な行のみ処理
    │    └─ 各行を parseStreamJsonLine() でパース
    │         ├─ kind === 'progress' → this.onProgress(event)
    │         ├─ kind === 'result'   → 結果テキストを保持
    │         └─ kind === 'ignored'  → スキップ
    │
    ├─ 'close' イベント
    │    ├─ this.process = null
    │    ├─ killTimer をクリア
    │    └─ this.onProcessEnd(exitCode, resultText) を呼び出し
    │
    └─ 'error' イベント（起動失敗）
         ├─ this.process = null
         └─ this.onProcessEnd(1, errorMessage) を呼び出し
```

#### 3.3.3 stdout の行バッファリング

`child_process` の stdout は `Buffer` チャンクを任意のタイミングで発行する。チャンクの境界は行の境界と一致しない場合があるため、不完全な行を次のチャンクまで保持するバッファリングが必要である。

```typescript
let buffer = '';
this.process.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';  // 最後の要素は不完全な行（または空文字列）
  for (const line of lines) {
    if (line.trim() === '') continue;
    const parsed = parseStreamJsonLine(line);
    // parsed に応じた処理...
  }
});
```

#### 3.3.4 interrupt() の処理フロー

```
interrupt()
    │
    ├─ [ガード] this.process === null → return
    │
    ├─ SIGINT を送信（graceful shutdown を試みる）
    │    this.process.kill('SIGINT')
    │
    └─ 10秒タイマーを設定
         │
         └─ タイムアウト時: SIGKILL を送信（強制終了）
              this.process.kill('SIGKILL')
```

- タイマーは `close` イベントハンドラ内でクリアされる
- `SIGINT` → `SIGKILL` の 2 段階方式により、claude CLI に後処理の猶予を与えつつ、ハングアップを防止する

#### 3.3.5 コールバックの設計

`ClaudeProcess` は 2 つのコールバック（`onProgress`, `onProcessEnd`）をコンストラクタで受け取る。これらは Orchestrator のメソッドに接続される（配線方法は Section 4 で説明）。

```
ClaudeProcess                          Orchestrator
┌──────────────────┐                   ┌──────────────────┐
│                  │  onProgress()     │                  │
│  stdout パース   │ ─────────────────→│  onProgress()    │
│                  │                   │                  │
│  close イベント  │  onProcessEnd()   │                  │
│                  │ ─────────────────→│  onProcessEnd()  │
│                  │                   │                  │
│  spawn()     ◄───│──────────────────│  handleMessage() │
│  interrupt() ◄───│──────────────────│  handleMessage() │
└──────────────────┘                   └──────────────────┘
```

**`IClaudeProcess` インターフェースにコールバックを含めない理由：**

`IClaudeProcess` はドメイン層で定義されたインターフェースであり、「プロセスの起動と中断」という最小限の操作のみを規定する。コールバックの注入方法はインフラストラクチャ層の実装詳細であり、ドメイン層が知るべきではない。Orchestrator はコールバックの存在を前提とせず、`onProgress()` と `onProcessEnd()` を公開メソッドとして提供するだけである。

---

### 3.4 DiscordNotifier — NotifyFn の実装

**ファイル:** `src/infrastructure/discord-notifier.ts`

**責務：** ドメインの `Notification` 型を受け取り、Discord メッセージとしてフォーマット・分割・送信する。

#### 3.4.1 公開インターフェース

```typescript
import type { NotifyFn } from '../domain/types.js';

export interface MessageSender {
  send(content: string): Promise<unknown>;
}

export function createNotifier(sender: MessageSender): NotifyFn;
```

クラスではなくファクトリ関数で実装する。`NotifyFn` 型（`(notification: Notification) => void`）は単一の関数シグネチャであり、クラスにする必要がない。

**テスタビリティのための設計判断：** discord.js の `TextChannel` に直接依存せず、`send()` メソッドのみを持つ最小インターフェース `MessageSender` を定義する。discord.js の `TextChannel` はこのインターフェースを構造的に満たすため、本番コードではそのまま渡せる。テストコードでは `{ send: vi.fn() }` のようなシンプルなモックで検証できる。

#### 3.4.2 通知フォーマット

ドメインから受け取る `Notification` の各型を、Discord メッセージの文字列に変換する。

| Notification の型 | フォーマット | 例 |
|-------------------|-------------|-----|
| `{ type: 'info', message }` | メッセージをそのまま送信 | `処理中です` |
| `{ type: 'result', text }` | テキストをそのまま送信（2000文字分割） | `（ClaudeCode の応答本文）` |
| `{ type: 'error', message, exitCode }` | エラー接頭辞付き | `エラー (exit 1): spawn failed` |
| `{ type: 'progress', event: { kind: 'tool_use' } }` | 🔧 + ツール名 + 対象 | `🔧 Edit: src/index.ts` |
| `{ type: 'progress', event: { kind: 'thinking' } }` | 💭 + 思考テキスト | `💭 コードの構造を分析中...` |

#### 3.4.3 メッセージ分割

Discord のメッセージ上限は **2000文字** である。この上限を超える通知は、複数メッセージに分割して送信する。

```typescript
function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}
```

**設計判断：**

| 項目 | 判断 | 理由 |
|------|------|------|
| 分割位置 | 文字数境界 | PoC では単純な実装を優先。行境界での分割は本格実装で検討 |
| 分割対象 | `result` 型のみ | `info`・`error`・`progress` は 2000文字を超えることが実質的にない |

#### 3.4.4 非同期送信の取り扱い

`NotifyFn` の型は `(notification: Notification) => void` であり、戻り値は `void`（`Promise<void>` ではない）。一方、discord.js の `channel.send()` は `Promise` を返す。

```typescript
sender.send(chunk).catch((err) => console.error('Discord send error:', err));
```

`sender.send()` の Promise は await せず、エラーのみ `.catch()` でログ出力する fire-and-forget パターンを採用する。

**この設計の理由：**

- `NotifyFn` はドメイン層で定義された型であり、非同期化するとドメイン層に `async/await` の概念を持ち込むことになる
- PoC では送信の失敗をリトライする必要はなく、ログ出力で十分

> **本格実装への移行時の考慮点：** `NotifyFn` を `Promise<void>` を返す型に変更し、送信失敗時のリトライやバックプレッシャー制御を追加することを推奨する。

---

### 3.5 コンポジションルート — index.ts

**ファイル:** `src/index.ts`

**責務：** すべてのコンポーネントをインスタンス化し、相互に接続する。アプリケーションのエントリーポイント。

#### 3.5.1 初期化フロー

```
main()
    │
    ├─ 1. dotenv/config をインポート（.env を読み込み）
    │
    ├─ 2. loadConfig() で設定を取得
    │
    ├─ 3. Discord クライアントを作成
    │      intents: Guilds, GuildMessages, MessageContent
    │
    ├─ 4. client.login() で Discord に接続
    │
    ├─ 5. チャンネルを取得・検証（TextChannel であること）
    │
    ├─ 6. ドメインオブジェクトを生成
    │      ├─ Session(config.workDir)
    │      └─ AccessControl({ allowedUserIds, channelId })
    │
    ├─ 7. インフラオブジェクトを生成・配線（後述）
    │      ├─ createNotifier(channel) → NotifyFn  // TextChannel は MessageSender を満たす
    │      ├─ ClaudeProcess(claudePath, onProgress, onProcessEnd)  // spawnFn はデフォルト値
    │      └─ Orchestrator(session, claudeProcess, notify)
    │
    └─ 8. MessageCreate イベントハンドラを登録
           │
           └─ message 受信
                ├─ AccessControl.check() → false → 無視
                └─ AccessControl.check() → true
                     → Orchestrator.handleMessage(message.content)
```

#### 3.5.2 循環依存の解決パターン

Orchestrator と ClaudeProcess の間には循環的な依存関係がある。

```
Orchestrator は ClaudeProcess を呼び出す（spawn, interrupt）
ClaudeProcess は Orchestrator を呼び出す（onProgress, onProcessEnd）
```

ただし、これはモジュール間の循環依存ではなく、**インスタンス間の相互参照** である。以下のクロージャパターンで解決する。

```typescript
// Step 1: 可変変数でコールバックの「穴」を作る
let onProgress: (event: ProgressEvent) => void = () => {};
let onProcessEnd: (exitCode: number, output: string) => void = () => {};

// Step 2: ClaudeProcess を生成（コールバックはクロージャ経由）
const claudeProcess = new ClaudeProcess(
  config.claudePath,
  (event) => onProgress(event),      // クロージャが onProgress 変数を参照
  (exitCode, output) => onProcessEnd(exitCode, output),
);

// Step 3: Orchestrator を生成
const orchestrator = new Orchestrator(session, claudeProcess, notify);

// Step 4: コールバックの「穴」を埋める
onProgress = (event) => orchestrator.onProgress(event);
onProcessEnd = (exitCode, output) => orchestrator.onProcessEnd(exitCode, output);
```

**このパターンが安全な理由：**

1. `ClaudeProcess` のコンストラクタに渡されるのはアロー関数であり、そのアロー関数は `let` 変数 `onProgress` / `onProcessEnd` をクロージャで参照する
2. `spawn()` が呼ばれるのはユーザーがメッセージを送信した時（非同期イベント）であり、コンストラクタ実行中ではない
3. Step 4 が完了した後にしかメッセージイベントは発生しないため、コールバックが `() => {}` のまま呼ばれることはない

#### 3.5.3 Discord クライアントの設定

discord.js クライアントには以下の **Intents**（受信するイベントの種類）を設定する。

| Intent | 必要な理由 |
|--------|-----------|
| `GatewayIntentBits.Guilds` | サーバー（ギルド）情報の取得に必要 |
| `GatewayIntentBits.GuildMessages` | サーバー内のメッセージ受信に必要 |
| `GatewayIntentBits.MessageContent` | メッセージ本文の取得に必要（**Privileged Intent**） |

> **セットアップ要件：** `MessageContent` は **Privileged Intent** であり、Discord Developer Portal で Bot の設定画面から明示的に有効化する必要がある。有効化しないと、受信したメッセージの `content` フィールドが空文字列になる。

---

## 4. データフロー全体像

### 4.1 ユーザーメッセージ → ClaudeCode 応答

```
[スマートフォン]                [Discord Bot (Node.js)]               [claude CLI]
     │                              │                                    │
     │  Discord メッセージ送信       │                                    │
     │ ──────────────────────────→  │                                    │
     │                              │                                    │
     │                    MessageCreate イベント                         │
     │                              │                                    │
     │                    AccessControl.check()                          │
     │                              │ OK                                 │
     │                    Orchestrator.handleMessage()                    │
     │                              │                                    │
     │                    Session.ensure()                                │
     │                              │                                    │
     │                    ClaudeProcess.spawn()                           │
     │                              │  child_process.spawn()             │
     │                              │ ─────────────────────────────────→ │
     │                              │                                    │
     │                              │  stdout: stream-json (NDJSON)      │
     │                              │ ←───────────────────────────────── │
     │                              │                                    │
     │                    parseStreamJsonLine()                          │
     │                              │                                    │
     │                    [tool_use] → onProgress()                      │
     │  🔧 Edit: src/index.ts       │                                    │
     │ ←──────────────────────────  │                                    │
     │                              │                                    │
     │                    [thinking] → onProgress()                      │
     │  💭 コードを分析中...         │                                    │
     │ ←──────────────────────────  │                                    │
     │                              │                                    │
     │                              │  プロセス終了 (close イベント)      │
     │                              │ ←───────────────────────────────── │
     │                              │                                    │
     │                    onProcessEnd(exitCode, resultText)             │
     │                    Orchestrator → NotifyFn                        │
     │                    splitMessage() → channel.send()                │
     │  応答テキスト                 │                                    │
     │ ←──────────────────────────  │                                    │
```

### 4.2 中断フロー

```
[スマートフォン]                [Discord Bot]                         [claude CLI]
     │                              │                                    │
     │  "!interrupt"                │                        (処理中)    │
     │ ──────────────────────────→  │                                    │
     │                              │                                    │
     │                    Orchestrator.handleMessage("!interrupt")        │
     │                    interruptReason = 'interrupt'                   │
     │                    ClaudeProcess.interrupt()                       │
     │                              │  SIGINT                            │
     │                              │ ─────────────────────────────────→ │
     │                              │                                    │
     │                              │        (10秒以内に終了しない場合)   │
     │                              │  SIGKILL                           │
     │                              │ ─────────────────────────────────→ │
     │                              │                                    │
     │                              │  プロセス終了                       │
     │                              │ ←───────────────────────────────── │
     │                              │                                    │
     │                    onProcessEnd()                                  │
     │                    interruptReason === 'interrupt'                 │
     │  "中断しました"              │                                    │
     │ ←──────────────────────────  │                                    │
```

---

## 5. 依存関係

### 5.1 追加する外部ライブラリ

| ライブラリ | 用途 | 種別 |
|-----------|------|------|
| `discord.js` | Discord API クライアント。メッセージの受信と送信 | 本番依存（dependencies） |
| `dotenv` | `.env` ファイルの環境変数読み込み | 本番依存（dependencies） |

```bash
pnpm add discord.js dotenv
```

### 5.2 使用する Node.js 標準モジュール

| モジュール | 使用箇所 | 用途 |
|-----------|----------|------|
| `node:child_process` | `claude-process.ts` | claude CLI のサブプロセス起動・シグナル送信 |
| `node:crypto` | `session.ts`（既存） | UUID 生成 |

---

## 6. テスト方針

### 6.1 テスト対象の選定

| コンポーネント | テスト | テスト手法 |
|---------------|--------|-----------|
| `stream-json-parser.ts` | ユニットテストあり | 純粋関数への入出力テスト |
| `config.ts` | ユニットテストあり | テスト前後で `process.env` を操作して検証 |
| `claude-process.ts` | ユニットテストあり | `SpawnFn` にモック関数を注入し、プロセスライフサイクルを検証 |
| `discord-notifier.ts` | ユニットテストあり | `MessageSender` にモックを注入し、フォーマット・分割ロジックを検証 |
| `index.ts` | テストなし | コンポジションルート。手動 E2E テストで検証 |

> **設計判断：** インフラストラクチャ層の各コンポーネントは、外部依存（`child_process.spawn()`、`TextChannel`）を注入可能なインターフェースに置き換えることで、実際の外部システムなしにユニットテストできる設計とした。`index.ts`（コンポジションルート）のみ手動 E2E テストで検証する。

### 6.2 E2E テスト手順

PoC 完了条件に基づき、以下の手順で手動検証を行う。

1. `pnpm dev` で Bot を起動し、Discord に正常接続されることを確認
2. スマートフォンから Discord にテキストを送信し、ClaudeCode の応答が返ることを確認
3. 続けてテキストを送信し、前の会話の続きとして応答されることを確認
4. コード変更指示を送信し、実際にファイルが編集されることを確認
5. 処理中にツール使用（🔧）と拡張思考（💭）が表示されることを確認
6. 長い応答が 2000文字で分割されることを確認
7. 処理中にテキストを送信し、「処理中です」と返されることを確認
8. `!interrupt` で処理が中断されることを確認
9. `!new` で新しいセッションが開始されることを確認
