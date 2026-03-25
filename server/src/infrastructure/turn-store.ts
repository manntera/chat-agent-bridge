import { readFile, writeFile, readdir } from 'node:fs/promises';
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

  /**
   * 全セッションの turns.json を横断して Discord メッセージ ID から逆引きする。
   * 現セッションの findTurn で見つからなかった場合のフォールバック用。
   */
  async findTurnAcrossSessions(
    workDir: string,
    discordMessageId: string,
  ): Promise<{ sessionId: string; turn: number } | null> {
    const dir = projectDir(workDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    const turnsFiles = entries.filter((e) => e.endsWith('.turns.json'));
    for (const file of turnsFiles) {
      const map = await this.load(join(dir, file));
      for (const [turnStr, msgId] of Object.entries(map)) {
        if (msgId === discordMessageId) {
          const sessionId = file.replace('.turns.json', '');
          return { sessionId, turn: Number(turnStr) };
        }
      }
    }
    return null;
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
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      console.error('TurnStore: corrupt or unreadable turns file:', filePath, err);
      return {};
    }
  }
}
