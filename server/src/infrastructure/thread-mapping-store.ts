import { readFileSync, existsSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';

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
  private pendingSave: Promise<void> = Promise.resolve();

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
      if (
        parsed.mappings &&
        typeof parsed.mappings === 'object' &&
        !Array.isArray(parsed.mappings)
      ) {
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

  /** ファイルに非同期書き込み（temp+rename でアトミックに更新、直列化で競合を防止） */
  private save(): Promise<void> {
    this.pendingSave = this.pendingSave.then(
      () => this.doSave(),
      () => this.doSave(),
    );
    return this.pendingSave;
  }

  private async doSave(): Promise<void> {
    const data: ThreadMappingsFile = {
      mappings: Object.fromEntries(this.mappings),
    };
    const tmpPath = this.filePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, this.filePath);
  }

  get(threadId: string): ThreadMapping | null {
    return this.mappings.get(threadId) ?? null;
  }

  async set(threadId: string, mapping: ThreadMapping): Promise<void> {
    this.mappings.set(threadId, mapping);
    await this.save();
  }

  async remove(threadId: string): Promise<void> {
    this.mappings.delete(threadId);
    await this.save();
  }
}
