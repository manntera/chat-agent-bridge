import type { ConversationEntry } from './session-reader.js';
import { fetchWithRetry } from './fetch-with-retry.js';

// ============================================================
// Pass 1: セッションごとの個別要約
// ============================================================

const SESSION_SUMMARY_PROMPT = `\
あなたはソフトウェア開発チームの作業記録アシスタントです。
以下はAIコーディングアシスタントとユーザーの1セッション分の会話履歴です。
このセッションで行われた作業をタスク単位で要約してください。

ルール:
- 会話内容から客観的・事実ベースで抽出すること（推測や解釈を加えない）
- 日本語で出力すること
- 1セッション内に複数のタスクがあれば、タスクごとに分けて記述すること
- AIツールの操作手順（「Bashツールを使用し」「Agentツールを用いて」等）は記述しないこと。何をしたかだけを書く
- 中間の試行錯誤や失敗→リトライの経緯は省略し、最終的にやったことと結果を書くこと
- 変更したファイル名や関数名は含めてよいが、フルパスは不要（ファイル名のみで十分）
- 簡潔に書くこと。各項目は1〜3行程度を目安とする

フォーマット（タスクごとに以下を繰り返す）:
【タスク: （タスク名）】
- 目的: （なぜこの作業を行ったか。1〜2文で簡潔に）
- やったこと: （何をしたかを箇条書きで。各項目は1行で収まる程度に）
- 結果: （最終的にどうなったか。完了/途中/問題ありを1〜2文で）

【悩んだ所・知見】
（このプロジェクト固有の知見で、今後の開発に役立つものだけを厳選して記述。一般的なプログラミングの知識や当たり前のベストプラクティスは書かない。1つのセッションで0〜2個程度。なければ「なし」）

【困っていること・未解決】
（解決できなかった問題、チームに相談したいこと。なければ「なし」）

会話履歴:
`;

// ============================================================
// Pass 2: 全セッション要約を統合して日報生成
// ============================================================

const REPORT_PROMPT = `\
あなたはソフトウェア開発チームの日報作成アシスタントです。
以下は、ある開発者が今日行った各作業セッションの要約です。
これらを統合して、チームメンバーが読む**簡潔で読みやすい**日報を作成してください。

ルール:
- 以下のMarkdownフォーマットに厳密に従うこと
- タスク単位で情報を集約すること（同じタスクの情報が複数セッションに分散している場合は1箇所にまとめる）
- 日本語で出力すること
- 見出しだけ読めば全体像がわかり、本文も読めば2〜3分で詳細を把握できる構成にすること
- 関連する作業は1つのタスクにまとめること

簡潔さに関するルール（重要）:
- AIツールの操作手順は一切書かないこと（「Bashツールを使用し」「Agentツールを用いて」「Grepツールで検索し」等は全て不要）
- 中間の試行錯誤・失敗・リトライの経緯は書かないこと。最終的にやったことと結果だけを書く
- 「結果」は「やったこと」の繰り返しにしないこと。状態（完了/途中/問題あり）とPR番号等を端的に書く
- フルパスは書かないこと（ファイル名だけで十分）
- 各セクションの文量目安: 目的は1〜2文、やったことは箇条書き3〜7項目、結果は1〜3文

構成の意図:
- タスクセクション: 1タスクにつき「目的」「やったこと」「結果」を1箇所に集約して記述する。読み手がタスク単位で状況を把握できるようにする
- 「悩んだ所・知見」: このプロジェクト固有の、今後の開発に役立つ知見だけを厳選して記述する。一般的なプログラミングのベストプラクティスや当たり前の知識は書かない。1日で0〜5個程度に厳選すること。該当がなければセクションごと省略する
- 「困っていること・未解決」: 現在困っていること、チームに相談したいことを記述する。該当がなければセクションごと省略する

フォーマット:
## （タスク1のタイトル）
### 目的
（なぜこの作業を行ったか。1〜2文で簡潔に）

### やったこと
（箇条書きで、各項目は1〜2行。技術的に重要なポイントに絞る）

### 結果
（完了/途中/問題ありの状態を端的に。PR番号やIssue番号があれば記載）

## 悩んだ所・知見
### （トピックのタイトル）
（何が問題で、どう解決し、何がわかったか。3〜5行で）

## 困っていること・未解決
### （トピックのタイトル）
（何が問題で、どうしてほしいか。3〜5行で）

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
      const res = await fetchWithRetry(
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
