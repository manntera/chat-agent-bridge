# 日報自動生成の設計

**前提ドキュメント:**

- `13_Thread_Title_Generation.md` — スレッドタイトル自動生成の設計（Gemini API 連携の基盤）

**本ドキュメントの位置づけ：** Discord 上に記録された作業ログ（Claude Code セッション）を元に、Gemini API を用いてチーム共有向けの日報を自動生成する機能を設計する。

---

## 1. 概要

### 1.1 背景

chat-agent-bridge では全ての作業が Discord スレッド上で行われ、Claude Code セッションの会話履歴が JSONL ファイルとして蓄積されている。これはチームにとって貴重な作業ログだが、そのままでは量が多く、他のメンバーが「今日何をしたか」を把握するのは困難である。

### 1.2 対応方針

指定日のセッション履歴を Gemini API（Flash モデル）に渡し、チームメンバーが状況を把握しやすい構造化された日報を生成する。スラッシュコマンド `/cc report` で任意のタイミングに実行できるようにする。

### 1.3 一日の区切り

- **朝 6:00（JST）** を日の境界とする
- 例: 「3/22 の日報」= `2026-03-22 06:00:00 JST` 〜 `2026-03-23 06:00:00 JST`
- 深夜作業が前日の日報に含まれるよう、一般的な業務サイクルに合わせた設計

---

## 2. ユーザー体験

### 2.1 基本的な使い方

```
User: /cc report
Bot:  （メインチャンネルに日報を投稿）

📋 日報 — 2026-03-22

## やったこと

### 日報自動生成機能の設計・実装
Gemini APIを利用した日報自動生成の仕組みを構築した。
SessionStoreに日付フィルタリング機能（listSessionsByDateRange）を
追加し、JSONL ファイルの更新日時で対象日のセッションを抽出する。
2段階生成方式（Pass 1: セッション個別要約、Pass 2: 統合日報生成）を
採用し、スラッシュコマンド `/cc report` として実装した。

### セッション再開時のエラーハンドリング改善
スレッド切断時に SessionManager からコンテキストが削除されず、
再開時に古いコンテキストが残る問題を修正した。
onProcessEnd コールバック内で明示的にクリーンアップ処理を追加した。

## 技術的判断・決定事項

### Gemini モデルの選定
日報生成のモデルとして gemini-2.5-flash を採用した。
候補として flash-lite（タイトル生成で使用中）と pro があったが、
日報は複数セッションを横断した要約・構造化が必要なため flash-lite
では品質が不十分と判断。pro はコストに見合わないため flash を選択した。

### 一日の区切りの設定
日の境界を朝6:00（JST）に設定した。0:00区切りだと深夜作業が
翌日扱いになり実態と合わないため、一般的な業務サイクルに合わせた。

## 技術的難易度の高かった作業

### Gemini APIの出力トークン制限への対処
セッション数が多い日（25セッション等）に、1回のAPI呼び出しで全てを
要約するとトークン上限に達し、日報が途中で打ち切られる問題が発生した。
2段階生成方式に切り替え、Pass 1 で各セッションを個別に要約した後、
Pass 2 で統合することで解決。並列実行（最大5並列）により所要時間も抑えた。

## 困っていること・未解決・保留

なし

## セッション一覧
| # | タイトル | メッセージ数 |
|---|---------|------------|
| 1 | 日報自動生成機能の設計 | 24 |
| 2 | セッション再開のエラー修正 | 12 |
```

### 2.2 日付を指定して過去の日報を生成

```
User: /cc report date:2026-03-20
Bot:  （2026-03-20 の日報を投稿）
```

### 2.3 セッションが存在しない場合

```
User: /cc report date:2026-01-01
Bot:  ⚠️ 2026-01-01 のセッションが見つかりません
```

### 2.4 Gemini API キーが未設定の場合

```
User: /cc report
Bot:  ⚠️ 日報生成には GEMINI_API_KEY の設定が必要です
```

---

## 3. 日報テンプレート

### 3.1 設計意図

チームメンバーが以下を素早く把握できることを目指す：

| セクション | 目的 | チームへの価値 |
|-----------|------|--------------|
| **やったこと** | 当日の作業事実を記録 | 進捗の共有、重複作業の防止 |
| **技術的判断・決定事項** | 判断と背景情報をセットで記録 | 「なぜそうしたか」の共有、レビュー効率化 |
| **技術的難易度の高かった作業** | 課題と解決をナレッジとして記録 | チーム内ノウハウの蓄積・共有 |
| **困っていること・未解決・保留** | 未解決事項を可視化 | チームメンバーによるディスカッション・助力 |
| **セッション一覧** | 作業の粒度と量を俯瞰 | 作業ボリュームの把握 |

### 3.2 2段階生成方式

日報生成は精度を重視し、Gemini API を2段階で呼び出す。

```
Pass 1: セッションごとに個別要約（並列実行、最大5並列）
  セッション1 → Gemini → 要約1
  セッション2 → Gemini → 要約2
  ...

Pass 2: 全要約を統合して日報を生成
  [要約1, 要約2, ...] → Gemini → 最終日報
```

- **Pass 1** では各セッションの会話履歴から「作業内容」「技術的判断」「技術的に難しかった点」「未解決・保留事項」を構造的に抽出
- **Pass 2** では全セッションの要約を統合し、4セクション構成の日報 Markdown を生成

### 3.3 Gemini に渡すプロンプト

#### Pass 1: セッション個別要約

```
あなたはソフトウェア開発チームの作業記録アシスタントです。
以下はAIコーディングアシスタントとユーザーの1セッション分の会話履歴です。
このセッションで行われた作業を正確に要約してください。

ルール:
- 以下の4項目を全て出力すること
- 会話内容から客観的・事実ベースで抽出すること（推測や解釈を加えない）
- 該当する内容がない項目は「なし」と記載すること
- 具体的なファイル名、関数名、ツール名、Issue番号などを省略せず含めること
- 日本語で出力すること

フォーマット:
【作業内容】
（何をしたか、どう実装/対処したか、結果どうなったかを事実ベースで具体的に記述）

【技術的な判断・決定】
（設計判断や技術選定。その背景と理由を含めること。なければ「なし」）

【技術的に難しかった点】
（試行錯誤が必要だった箇所、ハマったポイント、工夫した実装。なければ「なし」）

【未解決・保留事項】
（解決できなかった問題、後回しにした事項。現状の状態と理由を含めること。なければ「なし」）

会話履歴:
{session_conversation}
```

#### Pass 2: 日報統合生成

```
あなたはソフトウェア開発チームの日報作成アシスタントです。
以下は、ある開発者が今日行った各作業セッションの要約です。
これらを統合して、チームメンバーが読む日報を作成してください。

ルール:
- 以下のMarkdownフォーマットに厳密に従うこと
- 4セクション全てを必ず出力すること
- 各セッションの要約内容を漏らさず反映すること（精度が最も重要）
- 該当する内容がないセクションは「なし」と記載すること
- 各セクション内では、作業トピックごとに ### 見出しで区切り、3〜5行程度で詳細を記述
- 見出しだけ読めば全体像がわかり、本文も読めば5分程度で詳細を把握できる構成にすること
- 関連する作業は1つのトピックにまとめてよいが、情報を省略しないこと

各セクションの意図:
- 「やったこと」: その日行った作業の事実を記録する
- 「技術的判断・決定事項」: 判断や決定事項を背景情報・理由とセットで記述する
- 「技術的難易度の高かった作業」: 課題と解決をノウハウとして記録する
- 「困っていること・未解決・保留」: チームメンバーがディスカッション・助力できるようにする

フォーマット:
## やったこと
### （作業トピック1のタイトル）
（事実ベースで具体的に記述）

## 技術的判断・決定事項
### （判断トピック1のタイトル）
（背景・理由とセットで記述）

## 技術的難易度の高かった作業
### （トピック1のタイトル）
（課題と解決アプローチ、得られた知見を記述）

## 困っていること・未解決・保留
### （トピック1のタイトル）
（問題の内容、現在の状態、未解決/保留の理由を記述）

セッション要約一覧:
{session_summaries}
```

### 3.3 セッション一覧テーブル

セッション一覧はプロンプト応答とは別に、プログラム側で生成する（正確性を保証するため）。

---

## 4. 設計

### 4.1 全体フロー

```
/cc report [date:YYYY-MM-DD]
  │
  ▼
InteractionHandler — コマンドをパース
  │
  ├─ date パラメータから対象日を決定（省略時: 今日）
  ├─ 対象日の時間範囲を計算（06:00 JST 〜 翌日 06:00 JST）
  │
  ▼
SessionStore — 対象日のセッションをフィルタリング
  │
  ├─ JSONL ファイルの更新日時で絞り込み
  ├─ 各セッションの会話履歴を SessionReader で読み込み
  │
  ▼
ReportGenerator — Gemini API で日報を生成
  │
  ├─ 全セッションの会話を結合・整形
  ├─ 日報生成プロンプトを構築
  ├─ Gemini API に送信
  ├─ 応答を整形（ヘッダー + 本文 + セッション一覧テーブル）
  │
  ▼
Discord に投稿
  │
  ├─ interaction.reply() で結果を返信
  └─ 文字数超過時は分割送信
```

### 4.2 対象セッションのフィルタリング

```typescript
interface DailySessionFilter {
  /** 対象日のセッションを返す */
  filterByDate(workDir: string, date: Date): Promise<SessionSummary[]>;
}
```

- JSONL ファイルの `mtime`（最終更新日時）を基準に判定
- 時間範囲: `date 当日 06:00:00 JST` 〜 `date 翌日 06:00:00 JST`
- 既存の `SessionStore.listSessions()` を拡張し、日付フィルタリングを追加
- `MAX_SESSIONS = 25` の制限を日報用には解除（一日の全セッションを対象とする）

### 4.3 会話データの整形

複数セッションの会話を結合して Gemini に渡す。

```
=== セッション 1: {タイトル or 最初のメッセージ} ===
user: ...
assistant: ...

=== セッション 2: {タイトル or 最初のメッセージ} ===
user: ...
assistant: ...
```

- 各セッションの会話は `SessionReader.readSession()` で読み込み
- セッション間は明確な区切り線で分離
- 全体の文字数上限: **100,000 文字**（gemini-2.5-flash の 1M トークンコンテキスト内に収まるよう余裕を持たせる）
- 超過時は各セッションを均等に切り詰め（末尾＝最新の会話を優先）

### 4.4 Gemini API 呼び出し

| 項目 | 値 |
|------|-----|
| モデル | `gemini-2.5-flash`（複数セッション横断の要約に十分な精度） |
| 用途 | 日報生成（1 リクエスト / コマンド実行ごと） |
| 入力 | 整形済み全セッション会話テキスト + 日報生成プロンプト |
| 出力 | 構造化された日報 Markdown |
| トークン上限（出力） | 4,096 トークン（詳細な記述に十分な余地を確保） |
| タイムアウト | 30 秒（タイトル生成より長く設定） |

### 4.5 コンポーネント構成

```
infrastructure/
  ├─ report-generator.ts     ... 日報生成（Gemini API 呼び出し + 整形）
  ├─ session-store.ts         ... 日付フィルタリング機能を追加
  ├─ session-reader.ts        ... 既存（変更なし）
  ├─ slash-commands.ts        ... /cc report サブコマンド追加
  └─ config.ts                ... 既存（GEMINI_API_KEY を共用）

app/
  └─ interaction-handler.ts   ... report コマンドのパース追加

index.ts                      ... report コマンドのハンドリング追加
```

---

## 5. 変更一覧

### 5.1 新規ファイル

#### `infrastructure/report-generator.ts`

日報を生成するモジュール。TitleGenerator と同様のパターン。

```typescript
export interface IReportGenerator {
  generate(sessions: DailySession[], date: Date): Promise<string | null>;
}

export interface DailySession {
  sessionId: string;
  title: string;
  entries: ConversationEntry[];
}

export class ReportGenerator implements IReportGenerator {
  constructor(private readonly apiKey: string);

  /** 複数セッションの会話から日報Markdownを生成 */
  async generate(sessions: DailySession[], date: Date): Promise<string | null>;
}
```

### 5.2 変更ファイル

#### `infrastructure/slash-commands.ts`

`/cc report` サブコマンドを追加。

```typescript
.addSubcommand((sub) =>
  sub
    .setName('report')
    .setDescription('日報を生成します')
    .addStringOption((opt) =>
      opt
        .setName('date')
        .setDescription('対象日（YYYY-MM-DD 形式、省略時: 今日）')
        .setRequired(false),
    ),
)
```

#### `infrastructure/session-store.ts`

日付範囲でフィルタリングするメソッドを追加。

```typescript
export class SessionStore implements ISessionStore {
  // 既存
  async listSessions(workDir: string): Promise<SessionSummary[]>;

  // 新規
  async listSessionsByDateRange(
    workDir: string,
    from: Date,
    to: Date,
  ): Promise<SessionSummary[]>;
}
```

#### `app/interaction-handler.ts`

`report` サブコマンドのパースを追加。

#### `index.ts`

`/cc report` のハンドリングを追加。

```typescript
if (subcommand === 'report') {
  await interaction.deferReply();

  const dateStr = interaction.options.getString('date');
  const targetDate = dateStr ? parseDate(dateStr) : today();
  const { from, to } = getDayBoundary(targetDate); // 06:00 JST 基準

  const sessions = await sessionStore.listSessionsByDateRange(config.workDir, from, to);
  // ... 各セッションの会話を読み込み、ReportGenerator で日報生成、投稿
}
```

---

## 6. エッジケース

| ケース | 対処 |
|--------|------|
| `GEMINI_API_KEY` が未設定 | エラーメッセージを返す |
| 対象日にセッションが存在しない | 「セッションが見つかりません」と返す |
| `date` パラメータが不正な形式 | エラーメッセージを返す（`YYYY-MM-DD` 形式のみ受け付け） |
| Gemini API がタイムアウト（30 秒超） | エラーメッセージを返す |
| Gemini API がエラーレスポンスを返す | エラーメッセージを返す |
| 一日のセッション数が非常に多い | 文字数上限（100,000 文字）で切り詰め |
| 日報が Discord の文字数上限（2,000 文字）を超える | 複数メッセージに分割して送信 |
| タイムゾーンの扱い | サーバーのローカル時間ではなく JST（UTC+9）を明示的に使用 |
| 未来の日付を指定 | 実行可能（セッションがなければ「見つかりません」と返す） |

---

## 7. テスト方針

### `infrastructure/report-generator.test.ts`（新規）

- 正常系: 複数セッションから日報 Markdown が生成される
- 全セクションが含まれている（やったこと、判断・決定、課題、次にやること）
- セッション一覧テーブルが正しく生成される
- API エラー → `null` を返す
- タイムアウト → `null` を返す
- 空のセッションリスト → `null` を返す

### `infrastructure/session-store.test.ts`（変更）

- `listSessionsByDateRange`: 日付範囲内のセッションのみ返される
- 06:00 JST 境界のセッションが正しく判定される
- 範囲外のセッションが除外される

### `index.ts` 結合テスト

- `/cc report` で日報が生成・投稿される
- `/cc report date:2026-03-20` で指定日の日報が生成される
- 不正な日付形式でエラーメッセージが返る
- GEMINI_API_KEY 未設定でエラーメッセージが返る

---

## 8. 実装順序

1. `infrastructure/session-store.ts` — `listSessionsByDateRange()` 追加 + テスト
2. `infrastructure/report-generator.ts` — 日報生成ロジック + テスト
3. `infrastructure/slash-commands.ts` — `/cc report` サブコマンド定義
4. `app/interaction-handler.ts` — `report` コマンドのパース
5. `index.ts` — `/cc report` のハンドリング統合
