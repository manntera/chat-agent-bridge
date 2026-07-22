import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDir } from './session-store.js';

/**
 * Claude Code のセッショントランスクリプト(~/.claude/projects/<dir>/<session>.jsonl)を
 * 指定ターンで切り詰めた分岐セッションを作成する。
 *
 * ⚠️ このファイルは Claude Code の内部フォーマットに依存する唯一の「書き込み」箇所。
 * CLI が公式にセッション分岐(fork-at-turn)を提供したら、置き換えるのはこのファイルだけで済む。
 * ターンのメタデータ(メッセージ ID との対応等)は store/conversation-store.ts が管理し、
 * ~/.claude 配下には JSONL 以外のファイルを一切作らない。
 */

/** ユーザープロンプト行かどうか(tool_result は除外) */
function isUserPrompt(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== 'user') return false;
  const msg = parsed.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (Array.isArray(content)) {
    return !content.some((c: Record<string, unknown>) => c.type === 'tool_result');
  }
  return true;
}

/**
 * 指定ターンまでの会話で分岐セッションを作成する。
 *
 * ターンの定義: ユーザープロンプト(tool_result を除く user 行)1つで1ターン。
 * ツール使用時に複数の assistant/user 行が生成されても1ターンとしてカウントする。
 *
 * @returns 新しい sessionId
 */
export async function branchTranscript(
  sessionId: string,
  workDir: string,
  targetTurn: number,
): Promise<string> {
  const dir = projectDir(workDir);
  const sourcePath = join(dir, `${sessionId}.jsonl`);

  const content = await readFile(sourcePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');

  // (N+1) 番目のユーザープロンプトの直前で切る = N ターン分を保持
  let userPromptCount = 0;
  let cutIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (isUserPrompt(parsed)) {
        userPromptCount++;
        if (userPromptCount === targetTurn + 1) {
          cutIndex = i;
          break;
        }
      }
    } catch {
      // パース不能行はカウントに影響しない
    }
  }

  if (cutIndex === -1) {
    if (userPromptCount === targetTurn) {
      // targetTurn が実ターン数と一致 → 全行を保持
      cutIndex = lines.length;
    } else {
      throw new Error(`Turn ${targetTurn} が見つかりません(全 ${userPromptCount} ターン)`);
    }
  }

  const newSessionId = randomUUID();
  const newLines = lines.slice(0, cutIndex);
  const newPath = join(dir, `${newSessionId}.jsonl`);
  await writeFile(newPath, newLines.length > 0 ? newLines.join('\n') + '\n' : '');

  return newSessionId;
}

/**
 * トランスクリプトのユーザープロンプト数(=ターン数)を数える。
 * 旧セッションを新しい会話として再開する際のターンカウンタ初期値に使う。
 */
export async function countTranscriptTurns(sessionId: string, workDir: string): Promise<number> {
  const sourcePath = join(projectDir(workDir), `${sessionId}.jsonl`);
  let content: string;
  try {
    content = await readFile(sourcePath, 'utf-8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      if (isUserPrompt(JSON.parse(line))) count++;
    } catch {
      // skip
    }
  }
  return count;
}
