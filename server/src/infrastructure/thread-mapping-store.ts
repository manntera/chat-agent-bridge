import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export interface ThreadMapping {
  sessionId: string;
  workDir: string;
  workspaceName: string;
}

interface ThreadMappingsFile {
  mappings: Record<string, ThreadMapping>;
}

export class ThreadMappingStore {
  private mappings: Map<string, ThreadMapping>;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.mappings = new Map();
    this.load();
  }

  /** JSON ファイルから読み込み。ファイルが存在しなければ空 */
  private load(): void {
    if (!existsSync(this.filePath)) {
      this.mappings = new Map();
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed: ThreadMappingsFile = JSON.parse(raw);
      if (parsed.mappings && typeof parsed.mappings === 'object') {
        this.mappings = new Map(Object.entries(parsed.mappings));
      } else {
        console.warn(`thread-sessions.json の形式が不正です: ${this.filePath}`);
        this.mappings = new Map();
      }
    } catch {
      console.warn(`thread-sessions.json の読み込みに失敗しました: ${this.filePath}`);
      this.mappings = new Map();
    }
  }

  /** ファイルに書き込み（同期I/O: マッピング数が大幅に増えた場合は非同期化を検討） */
  private save(): void {
    const data: ThreadMappingsFile = {
      mappings: Object.fromEntries(this.mappings),
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  get(threadId: string): ThreadMapping | null {
    return this.mappings.get(threadId) ?? null;
  }

  set(threadId: string, mapping: ThreadMapping): void {
    this.mappings.set(threadId, mapping);
    this.save();
  }

  remove(threadId: string): void {
    this.mappings.delete(threadId);
    this.save();
  }
}
