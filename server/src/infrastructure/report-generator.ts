import type { ConversationEntry } from './session-reader.js';

// ============================================================
// Pass 1: セッションごとの個別要約
// ============================================================

const SESSION_SUMMARY_PROMPT = `\
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
（何をしたか、どう実装/対処したか、結果どうなったかを事実ベースで具体的に記述。複数あれば箇条書き）

【技術的な判断・決定】
（このセッション内で行われた設計判断や技術選定。その背景と理由を含めること。なければ「なし」）

【技術的に難しかった点】
（試行錯誤が必要だった箇所、ハマったポイント、工夫した実装。課題の内容と解決アプローチをセットで記述。なければ「なし」）

【未解決・保留事項】
（解決できなかった問題、後回しにした事項、判断を保留した事項。現状の状態と理由を含めること。なければ「なし」）

会話履歴:
`;

// ============================================================
// Pass 2: 全セッション要約を統合して日報生成
// ============================================================

const REPORT_PROMPT = `\
あなたはソフトウェア開発チームの日報作成アシスタントです。
以下は、ある開発者が今日行った各作業セッションの要約です。
これらを統合して、チームメンバーが読む日報を作成してください。

ルール:
- 以下のMarkdownフォーマットに厳密に従うこと
- 4セクション全てを必ず出力すること
- 各セッションの要約内容を漏らさず反映すること（精度が最も重要）
- 該当する内容がないセクションは「なし」と記載すること
- 日本語で出力すること
- 各セクション内では、作業トピックごとに ### 見出しで区切り、それぞれ3〜5行程度で詳細を記述すること
- 見出しだけ読めば全体像がわかり、本文も読めば5分程度で詳細を把握できる構成にすること
- 関連する作業は1つのトピックにまとめてよいが、情報を省略しないこと

各セクションの意図:
- 「やったこと」: その日行った作業の事実を記録する。推測や解釈は含めない
- 「技術的判断・決定事項」: 判断や決定事項を、その背景情報・理由とセットで記述する。チームが「なぜそうしたか」を理解できるようにする
- 「技術的難易度の高かった作業」: 課題と解決内容をセットで記述する。今後のノウハウ・ナレッジとして活かせる形にする
- 「困っていること・未解決・保留」: 現在困っていること、解決できなかったこと、保留にしたことを記述する。チームメンバーが閲覧してディスカッション・助力できるようにする

フォーマット:
## やったこと
### （作業トピック1のタイトル）
（何をしたか、どう実装したか、結果どうなったかを事実ベースで具体的に記述）

### （作業トピック2のタイトル）
（同上）

## 技術的判断・決定事項
### （判断トピック1のタイトル）
（何を判断・決定したか。背景にあった課題・制約は何か。なぜその判断に至ったかを記述）

## 技術的難易度の高かった作業
### （トピック1のタイトル）
（何が難しかったか。どういうアプローチで解決したか。得られた知見は何かを記述）

## 困っていること・未解決・保留
### （トピック1のタイトル）
（何が問題か。現在の状態はどうか。なぜ未解決/保留なのかを記述）

セッション要約一覧:
`;

const MAX_SESSION_CONVERSATION_LENGTH = 30_000;
const TIMEOUT_MS = 300_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 8192;
const REPORT_MAX_OUTPUT_TOKENS = 65536;
const GEMINI_MODEL = 'gemini-2.5-flash';
const CONCURRENT_LIMIT = 5;

export interface DailySession {
  sessionId: string;
  title: string;
  messageCount: number;
  entries: ConversationEntry[];
}

export interface IReportGenerator {
  generate(sessions: DailySession[], date: Date): Promise<string | null>;
}

function formatDateJST(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatSessionConversation(session: DailySession, maxLength: number): string {
  const lines = session.entries.map((e) => `${e.role}: ${e.text}`);
  let result = lines.join('\n');
  if (result.length > maxLength) {
    // 末尾（最新の会話）を優先
    result = result.slice(-maxLength);
  }
  return result;
}

export class ReportGenerator implements IReportGenerator {
  constructor(private readonly apiKey: string) {}

  private async callGemini(prompt: string, maxOutputTokens: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens },
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timer);

      if (!res.ok) {
        console.error(`Gemini API returned ${res.status}`);
        return null;
      }

      const data = (await res.json()) as GeminiResponse;
      return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('Gemini API timed out');
      } else {
        console.error('Gemini API error:', err);
      }
      return null;
    }
  }

  /** Pass 1: 個別セッションの要約を生成 */
  private async summarizeSession(session: DailySession): Promise<string | null> {
    const conversation = formatSessionConversation(session, MAX_SESSION_CONVERSATION_LENGTH);
    const prompt = SESSION_SUMMARY_PROMPT + conversation;
    return this.callGemini(prompt, SUMMARY_MAX_OUTPUT_TOKENS);
  }

  /** Pass 1 を並列実行（同時実行数制限付き） */
  private async summarizeAll(
    sessions: DailySession[],
  ): Promise<{ session: DailySession; summary: string }[]> {
    const results: { session: DailySession; summary: string }[] = [];

    for (let i = 0; i < sessions.length; i += CONCURRENT_LIMIT) {
      const batch = sessions.slice(i, i + CONCURRENT_LIMIT);
      const batchResults = await Promise.all(
        batch.map(async (s) => {
          const summary = await this.summarizeSession(s);
          return { session: s, summary };
        }),
      );
      for (const r of batchResults) {
        if (r.summary) {
          results.push({ session: r.session, summary: r.summary });
        }
      }
    }

    return results;
  }

  async generate(sessions: DailySession[], date: Date): Promise<string | null> {
    if (sessions.length === 0) return null;

    // Pass 1: 各セッションを個別に要約
    const summaries = await this.summarizeAll(sessions);
    if (summaries.length === 0) return null;

    // Pass 2: 全要約を統合して日報生成
    const summaryText = summaries
      .map((s, i) => `=== セッション ${i + 1}: ${s.session.title} ===\n${s.summary}`)
      .join('\n\n');

    const reportPrompt = REPORT_PROMPT + summaryText;
    const body = await this.callGemini(reportPrompt, REPORT_MAX_OUTPUT_TOKENS);
    if (!body) return null;

    const dateStr = formatDateJST(date);
    const header = `📋 **日報 — ${dateStr}**\n\n`;

    return header + body;
  }
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
}
