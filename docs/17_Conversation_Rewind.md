# 会話巻き戻し機能の設計

**前提ドキュメント:**

- `01_SystemDesign.md` — システム全体設計
- `08_Resume_Session.md` — セッション再開機能（JSONL 構造・resume 機構）
- `16_Reply_Mention.md` — Notifier のメッセージ送信フロー

**本ドキュメントの位置づけ：** Discord のリプライ操作で会話を任意の時点まで巻き戻し、そこからやり直す機能の設計。

---

## 1. 概要

### 1.1 現状の課題

現在のシステムでは、一度送信したプロンプトを訂正する手段がない。入力ミスや方針変更があった場合、誤った文脈を引きずったまま会話を続けるか、新規セッションを作り直すしかない。

### 1.2 ゴール

Bot の過去の回答メッセージに **Discord のリプライ** をすることで、その時点まで会話を巻き戻し、リプライ本文を新しいプロンプトとして会話を再開する。

---

## 2. ユーザー体験

### 2.1 基本フロー

```
[スレッド内の会話]

User:  テスト追加して
Bot:   ✅ テストを追加しました（Turn 1 の回答）

User:  リファクタリングして
Bot:   ✅ リファクタリングしました（Turn 2 の回答）

User:  ログ出力を追加して          ← ここで入力を間違えた
Bot:   ✅ ログ出力を追加しました（Turn 3 の回答）

--- ここで Turn 2 の回答にリプライ ---

User:  [Bot の Turn 2 回答にリプライ] エラーハンドリングを追加して
Bot:   ⏪ Turn 2 まで巻き戻しました
Bot:   📨 受信しました。処理を開始します...
Bot:   ✅ エラーハンドリングを追加しました（新しい Turn 3 の回答）
```

### 2.2 操作方法

1. スレッド内の Bot 回答メッセージを **長押し**（モバイル）または **右クリック**（デスクトップ）
2. 「返信」を選択
3. やり直したい内容を入力して送信

特別なコマンドは不要。**Bot の回答にリプライ = その時点からやり直し** という直感的な操作になる。

---

## 3. 技術設計

### 3.1 全体の仕組み

巻き戻しは以下の 3 要素で実現する:

1. **ターンマッピングファイル** — Discord メッセージ ID とターン番号の対応を永続化
2. **ターン記録** — Bot が回答を送信するたびにマッピングを記録
3. **セッション分岐** — JSONL を指定ターンまで切り詰めた新セッションを作成

```
~/.claude/projects/[workDir]/
  ├── [sessionId].jsonl          ← 既存：会話履歴
  └── [sessionId].turns.json     ← 新規：ターンマッピング
```

### 3.2 ターンマッピングファイル

**`[sessionId].turns.json`** の構造:

```json
{
  "1": "1234567890123456789",
  "2": "1234567890123456790",
  "3": "1234567890123456791"
}
```

- キー: ターン番号（1-indexed、文字列）
- 値: Discord メッセージ ID

ターン番号は JSONL 内の user/assistant ペアの順番に対応する:

```
JSONL:
  { "type": "user", ... }         ← Turn 1 (user)
  { "type": "assistant", ... }    ← Turn 1 (assistant)
  { "type": "user", ... }         ← Turn 2 (user)
  { "type": "assistant", ... }    ← Turn 2 (assistant)

turns.json:
  { "1": "msg_id_of_turn1_result", "2": "msg_id_of_turn2_result" }
```

### 3.3 ターン記録フロー

```
ClaudeProcess 終了
  ↓
Orchestrator.onProcessEnd() → notify({ type: 'result', text })
  ↓
discord-notifier: flush() → thread.send(embed)
  ↓ Discord Message を受け取る
thread.send() の戻り値から message.id を取得
  ↓
onResultSent(discordMessageId) コールバック
  ↓
TurnStore.record(sessionId, workDir, turnNumber, discordMessageId)
  ↓
[sessionId].turns.json に追記
```

**ターン番号の算出:** Orchestrator が prompt を処理するたびにインクリメントするカウンタで管理する。

### 3.4 巻き戻しフロー

```
User が Bot 回答にリプライ（MessageCreate イベント）
  ↓
msg.reference?.messageId を取得
  ↓
TurnStore.findTurn(sessionId, workDir, discordMessageId)
  → ターン番号を逆引き（turns.json のキーと値を反転検索）
  ↓ 見つからない場合はエラー
SessionBrancher.branch(sessionId, workDir, targetTurn)
  ↓
  1. 元の JSONL を読み込み
  2. targetTurn 番目の assistant 応答までの行を抽出
  3. 新しい sessionId (UUID) を生成
  4. 抽出した行を新しい JSONL ファイルに書き出し
  5. 元の turns.json から targetTurn までのエントリをコピーして新 turns.json を作成
  6. 新しい sessionId を返却
  ↓
Session.reset() → Session.restore(newSessionId)
  ↓
notify({ type: 'info', message: '⏪ Turn N まで巻き戻しました' })
  ↓
リプライ本文を通常のプロンプトとして処理
  → Orchestrator.handleMessage(replyText)
```

### 3.5 セッション分岐の詳細

**JSONL の切り詰め処理:**

```typescript
// 元の JSONL の全行を読み込み
const lines: string[] = readAllLines(sourceJsonl);

// ターン（user/assistant ペア）をカウントしながら切り詰め位置を決定
let turnCount = 0;
let cutIndex = 0;

for (let i = 0; i < lines.length; i++) {
  const parsed = JSON.parse(lines[i]);
  if (parsed.type === 'assistant') {
    turnCount++;
    if (turnCount === targetTurn) {
      cutIndex = i + 1; // この行まで含める
      break;
    }
  }
}

// 新しい JSONL に書き出し
const newLines = lines.slice(0, cutIndex);
writeAllLines(newJsonlPath, newLines);
```

**turns.json のコピー:**

元の turns.json から targetTurn 以下のエントリのみをコピーする。これにより、巻き戻し前の Bot メッセージ（巻き戻し範囲内）に対しても再度リプライで巻き戻しが可能になる。

### 3.6 同一スレッド内での継続

巻き戻しは新しいスレッドを作成せず、同一スレッド内でセッションを切り替える。

- 元のセッションの JSONL は変更しない（非破壊）
- 新しいセッション ID で分岐した JSONL が作られる
- スレッドの SessionContext 内のセッションが新しいものに切り替わる

---

## 4. 変更一覧

### 4.1 新規ファイル

#### `infrastructure/turn-store.ts`

ターンマッピングの読み書きを担当する。

```typescript
export class TurnStore {
  /** ターンを記録する */
  async record(
    sessionId: string,
    workDir: string,
    turn: number,
    discordMessageId: string,
  ): Promise<void>;

  /** Discord メッセージ ID からターン番号を逆引きする */
  async findTurn(
    sessionId: string,
    workDir: string,
    discordMessageId: string,
  ): Promise<number | null>;

  /** 指定ターンまでのマッピングを新しいセッションにコピーする */
  async copyTo(
    sourceSessionId: string,
    targetSessionId: string,
    workDir: string,
    upToTurn: number,
  ): Promise<void>;
}
```

#### `infrastructure/session-brancher.ts`

JSONL を切り詰めて新セッションを作成する。

```typescript
export class SessionBrancher {
  constructor(private readonly turnStore: TurnStore) {}

  /**
   * 指定ターンまでの会話で分岐セッションを作成する。
   * @returns 新しい sessionId
   */
  async branch(
    sessionId: string,
    workDir: string,
    targetTurn: number,
  ): Promise<string>;
}
```

### 4.2 変更ファイル

#### `infrastructure/discord-notifier.ts`

**変更内容:** result メッセージ送信時に Discord メッセージ ID を取得し、コールバックで通知する。

```typescript
// ThreadSender の send 戻り値を活用
// 現在: thread.send(...).catch(...)
// 変更後: thread.send(...).then(msg => onResultSent(msg.id)).catch(...)

export interface Notifier {
  notify: NotifyFn;
  setAuthorId(authorId: string): void;
  onResultSent: ((discordMessageId: string) => void) | null;  // 追加
}
```

`flush()` 内の result 送信処理で、`thread.send()` の戻り値から `id` を取得してコールバックを呼ぶ。

`ThreadSender.send()` の戻り値型を `Promise<unknown>` から `Promise<{ id: string }>` に変更する:

```typescript
export interface ThreadSender {
  send(content: string | SendOptions): Promise<{ id: string }>;  // 変更
  sendTyping(): Promise<unknown>;
  setName(name: string): Promise<unknown>;
}
```

#### `domain/orchestrator.ts`

**変更内容:** ターンカウンタの追加。

```typescript
export class Orchestrator {
  private turnCount = 0;  // 追加

  get currentTurn(): number {  // 追加
    return this.turnCount;
  }

  // handleCommand の prompt 処理時にインクリメント
  case 'prompt':
    if (state === 'idle') {
      this.turnCount++;
      // ... existing spawn logic
    }

  // rewind コマンドの追加
  case 'rewind':
    if (state === 'idle') {
      this.turnCount = command.targetTurn;
      // ... rewind logic は index.ts 側で処理
    }
}
```

**補足:** rewind の実行自体は Infrastructure 層の処理（JSONL 操作・ファイル I/O）を伴うため、Orchestrator はターンカウンタのリセットと状態遷移のみ担当する。実際の分岐処理は `index.ts` で行い、完了後に Orchestrator に通知する設計とする。

#### `domain/types.ts`

**変更内容:** Command 型に `rewind` バリアントを追加。

```typescript
export type Command =
  | { type: 'new'; options: SessionOptions }
  | { type: 'interrupt' }
  | { type: 'prompt'; text: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'rewind'; targetTurn: number; newSessionId: string; prompt: string };  // 追加
```

#### `domain/session-manager.ts`

**変更内容なし。** SessionContext の構造は変更不要。セッションの切り替えは既存の `session.reset()` + `session.restore()` で対応できる。

#### `index.ts`

**変更内容:** MessageCreate ハンドラでリプライを検出し、巻き戻しフローを実行する。

```typescript
client.on(Events.MessageCreate, async (msg) => {
  // ... 既存のガード処理 ...

  const ctx = sessionManager.get(msg.channelId);
  if (!ctx) return;

  // リプライ検出
  if (msg.reference?.messageId && ctx.session.sessionId) {
    const referencedId = msg.reference.messageId;
    const turn = await turnStore.findTurn(
      ctx.session.sessionId,
      ctx.session.workDir,
      referencedId,
    );

    if (turn !== null) {
      // 巻き戻しフロー
      const newSessionId = await sessionBrancher.branch(
        ctx.session.sessionId,
        ctx.session.workDir,
        turn,
      );
      ctx.session.reset();
      ctx.session.restore(newSessionId);
      // turnCount をリセット
      // リプライ本文を通常プロンプトとして処理
      // ...
      return;
    }
    // turn が見つからない場合 → 通常メッセージとして処理（リプライ先が result 以外）
  }

  // ... 既存のプロンプト処理 ...
});
```

**Notifier の onResultSent コールバック設定:**

```typescript
function createSession(threadId, thread, workspace): SessionContext {
  // ... 既存の処理 ...
  const notifier = createNotifier(thread);

  // ターン記録コールバックを設定
  notifier.onResultSent = (discordMessageId) => {
    const sid = session.sessionId;
    if (sid) {
      turnStore
        .record(sid, workspace.path, orchestrator.currentTurn, discordMessageId)
        .catch((err) => console.error('Turn record error:', err));
    }
  };

  // ...
}
```

---

## 5. エッジケース

| ケース | 対処 |
|--------|------|
| リプライ先が Bot の result 以外（progress / info） | turns.json にエントリがないため `findTurn` が null を返す → 通常メッセージとして処理 |
| 処理中（busy）にリプライ | 既存と同じ「処理中です」を返す |
| 長文分割された result へのリプライ | 最初のメッセージのみ turns.json に記録する。分割後のメッセージへのリプライは通常メッセージ扱い |
| 巻き戻し後に再度巻き戻し | turns.json が新セッションにコピーされているため動作する |
| turns.json が存在しない（旧セッション） | `findTurn` が null → 通常メッセージ扱い。既存セッションへの後方互換性を維持 |
| リプライ本文が空 | 巻き戻しのみ実行し、プロンプトは送信しない。ユーザーが次に送るメッセージで再開 |
| JSONL 内の行が壊れている | session-brancher が壊れた行もそのままコピーする（パース不能行はターンカウントに影響しない） |

---

## 6. テスト方針

### 6.1 `turn-store.test.ts`

- `record()` で turns.json にエントリが書き込まれる
- `findTurn()` で Discord メッセージ ID からターン番号を逆引きできる
- `findTurn()` で存在しない ID は null を返す
- `copyTo()` で指定ターンまでのエントリがコピーされる
- turns.json が存在しない場合に `findTurn()` が null を返す

### 6.2 `session-brancher.test.ts`

- JSONL が指定ターンまで正しく切り詰められる
- 新しい JSONL ファイルが新セッション ID で作成される
- 元の JSONL は変更されない
- metadata 行（slug 等）が保持される
- turns.json が新セッションにコピーされる

### 6.3 `discord-notifier.test.ts`

- result 送信時に `onResultSent` コールバックが呼ばれる
- `onResultSent` が null の場合でもエラーにならない
- 長文分割時は最初のメッセージの ID のみ通知される

### 6.4 `orchestrator.test.ts`

- prompt 処理のたびに `currentTurn` がインクリメントされる
- rewind 後に `currentTurn` が正しくリセットされる

### 6.5 統合テスト

- リプライによる巻き戻し → 新セッションでの会話再開の一連のフロー
- 巻き戻し後の再巻き戻し

---

## 7. 実装順序

1. `infrastructure/turn-store.ts` + テスト — ファイル読み書きの基盤
2. `infrastructure/session-brancher.ts` + テスト — JSONL 分岐ロジック
3. `infrastructure/discord-notifier.ts` — `ThreadSender.send()` 戻り値型変更、`onResultSent` コールバック追加
4. `domain/types.ts` — Command 型に rewind 追加
5. `domain/orchestrator.ts` + テスト — ターンカウンタ追加
6. `index.ts` — リプライ検出、巻き戻しフロー、コールバック設定
