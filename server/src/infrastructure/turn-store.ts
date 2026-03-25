import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDir } from './session-store.js';

export type TurnMap = Record<string, string>;

function turnsFilePath(sessionId: string, workDir: string): string {
  return join(projectDir(workDir), `${sessionId}.turns.json`);
}

export class TurnStore {
  /**
   * ターンを記録する。
   * 注意: read-modify-write のため、同一セッションに対する並行呼び出しは
   * データ消失の原因になる。現在の利用では 1 スレッド = 1 セッションで
   * 応答はシーケンシャルなため問題ないが、並行化する場合は直列化が必要。
   */
  async record(
    sessionId: string,
    workDir: string,
    turn: number,
    discordMessageId: string,
  ): Promise<void> {
    const filePath = turnsFilePath(sessionId, workDir);
    const map = await this.load(filePath);
    map[String(turn)] = discordMessageId;
    await writeFile(filePath, JSON.stringify(map, null, 2));
  }

  /** Discord メッセージ ID からターン番号を逆引きする */
  async findTurn(
    sessionId: string,
    workDir: string,
    discordMessageId: string,
  ): Promise<number | null> {
    const filePath = turnsFilePath(sessionId, workDir);
    const map = await this.load(filePath);
    for (const [turnStr, msgId] of Object.entries(map)) {
      if (msgId === discordMessageId) {
        return Number(turnStr);
      }
    }
    return null;
  }

  /** 指定ターンまでのマッピングを新しいセッションにコピーする */
  async copyTo(
    sourceSessionId: string,
    targetSessionId: string,
    workDir: string,
    upToTurn: number,
  ): Promise<void> {
    const sourceMap = await this.load(turnsFilePath(sourceSessionId, workDir));
    const targetMap: TurnMap = {};
    for (const [turnStr, msgId] of Object.entries(sourceMap)) {
      if (Number(turnStr) <= upToTurn) {
        targetMap[turnStr] = msgId;
      }
    }
    await writeFile(turnsFilePath(targetSessionId, workDir), JSON.stringify(targetMap, null, 2));
  }

  /** セッションの最大ターン番号を返す（データがなければ 0） */
  async maxTurn(sessionId: string, workDir: string): Promise<number> {
    const map = await this.load(turnsFilePath(sessionId, workDir));
    const turns = Object.keys(map).map(Number);
    return turns.length > 0 ? Math.max(...turns) : 0;
  }

  private async load(filePath: string): Promise<TurnMap> {
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as TurnMap;
    } catch {
      return {};
    }
  }
}
