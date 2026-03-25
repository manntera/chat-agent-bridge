import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDir } from './session-store.js';
import type { TurnStore } from './turn-store.js';

export class SessionBrancher {
  constructor(private readonly turnStore: TurnStore) {}

  /**
   * 指定ターンまでの会話で分岐セッションを作成する。
   * @returns 新しい sessionId
   */
  async branch(sessionId: string, workDir: string, targetTurn: number): Promise<string> {
    const dir = projectDir(workDir);
    const sourcePath = join(dir, `${sessionId}.jsonl`);

    const content = await readFile(sourcePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');

    // ターン（user/assistant ペア）をカウントしながら切り詰め位置を決定
    let turnCount = 0;
    let cutIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type === 'assistant') {
          turnCount++;
          if (turnCount === targetTurn) {
            cutIndex = i + 1;
            break;
          }
        }
      } catch {
        // パース不能行はターンカウントに影響しない（そのままコピー）
      }
    }

    if (cutIndex === 0) {
      throw new Error(`Turn ${targetTurn} が見つかりません（全 ${turnCount} ターン）`);
    }

    const newSessionId = randomUUID();
    const newLines = lines.slice(0, cutIndex);
    const newPath = join(dir, `${newSessionId}.jsonl`);
    await writeFile(newPath, newLines.join('\n') + '\n');

    // turns.json もコピー
    await this.turnStore.copyTo(sessionId, newSessionId, workDir, targetTurn);

    return newSessionId;
  }
}
