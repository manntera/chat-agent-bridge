import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDir } from './session-store.js';
import type { TurnStore } from './turn-store.js';

/** ユーザープロンプト行かどうか（tool_result は除外） */
function isUserPrompt(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== 'user') return false;
  const msg = parsed.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (Array.isArray(content)) {
    return !content.some((c: Record<string, unknown>) => c.type === 'tool_result');
  }
  return true;
}

export class SessionBrancher {
  constructor(private readonly turnStore: TurnStore) {}

  /**
   * 指定ターンまでの会話で分岐セッションを作成する。
   *
   * ターンの定義: ユーザープロンプト（tool_result を除く user 行）1つで1ターン。
   * ツール使用時に複数の assistant/user 行が生成されても1ターンとしてカウントする。
   *
   * @returns 新しい sessionId
   */
  async branch(sessionId: string, workDir: string, targetTurn: number): Promise<string> {
    const dir = projectDir(workDir);
    const sourcePath = join(dir, `${sessionId}.jsonl`);

    const content = await readFile(sourcePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');

    // ユーザープロンプト（tool_result 以外の user 行）をカウントして切り詰め位置を決定
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
        throw new Error(`Turn ${targetTurn} が見つかりません（全 ${userPromptCount} ターン）`);
      }
    }

    const newSessionId = randomUUID();
    const newLines = lines.slice(0, cutIndex);
    const newPath = join(dir, `${newSessionId}.jsonl`);
    await writeFile(newPath, newLines.length > 0 ? newLines.join('\n') + '\n' : '');

    // turns.json もコピー
    await this.turnStore.copyTo(sessionId, newSessionId, workDir, targetTurn);

    return newSessionId;
  }
}
