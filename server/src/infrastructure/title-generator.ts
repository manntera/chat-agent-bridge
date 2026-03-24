import { readSession, formatForTitleGeneration } from './session-reader.js';
import { fetchWithRetry } from './fetch-with-retry.js';

const TITLE_PROMPT = `\
以下はAIコーディングアシスタントとユーザーの会話履歴です。
この会話で取り組んでいる作業を表すタイトルを1つだけ生成してください。

ルール:
- 30文字以内の日本語
- 「対象（機能名・コンポーネント名・ファイル名など）」+「作業内容（実装・バグ修正・リファクタ・設定変更・調査など）」の形式にすること
- 他のスレッドと区別がつく具体的な内容にすること（「コード修正」「機能追加」のような抽象的なタイトルは禁止）
- タイトルのみを出力し、他の説明は不要

良い例: 「Discord通知のエラーハンドリング修正」「ユーザー認証APIの実装」「Webpack設定のビルド最適化」
悪い例: 「バグ修正」「コードレビュー」「機能実装」「開発作業」

会話履歴:
`;

const MAX_CONVERSATION_LENGTH = 20000;
const MAX_TITLE_LENGTH = 100;
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_TOKENS = 64;

export interface ITitleGenerator {
  generate(sessionId: string, workDir: string): Promise<string | null>;
}

export class TitleGenerator implements ITitleGenerator {
  constructor(private readonly apiKey: string) {}

  async generate(sessionId: string, workDir: string): Promise<string | null> {
    let entries;
    try {
      entries = await readSession(sessionId, workDir);
    } catch {
      return null;
    }

    if (entries.length === 0) return null;

    const conversation = formatForTitleGeneration(entries, MAX_CONVERSATION_LENGTH);
    const prompt = TITLE_PROMPT + conversation;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
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
      const title = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (!title) return null;

      return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('Gemini API timed out');
      } else {
        console.error('Gemini API error:', err);
      }
      return null;
    }
  }
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
}
