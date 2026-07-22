import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface Workspace {
  name: string;
  path: string;
}

interface WorkspacesFile {
  workspaces: Workspace[];
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface IWorkspaceStore {
  list(): Workspace[];
  add(workspace: Workspace): void;
  remove(name: string): boolean;
  findByName(name: string): Workspace | undefined;
}

export class WorkspaceStore implements IWorkspaceStore {
  private workspaces: Workspace[] = [];
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** JSON ファイルから読み込み。ファイルが存在しなければ空 */
  load(): void {
    if (!existsSync(this.filePath)) {
      this.workspaces = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed: WorkspacesFile = JSON.parse(raw);
      if (Array.isArray(parsed.workspaces)) {
        this.workspaces = parsed.workspaces;
      } else {
        console.warn(`workspaces.json の形式が不正です: ${this.filePath}`);
        this.workspaces = [];
      }
    } catch {
      console.warn(`workspaces.json の読み込みに失敗しました: ${this.filePath}`);
      this.workspaces = [];
    }
  }

  private save(): void {
    const data: WorkspacesFile = { workspaces: this.workspaces };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  list(): Workspace[] {
    return [...this.workspaces];
  }

  add(workspace: Workspace): void {
    if (!NAME_PATTERN.test(workspace.name)) {
      throw new Error(
        `ワークスペース名は英数字・ハイフン・アンダースコアのみ使用できます: "${workspace.name}"`,
      );
    }
    if (!isAbsolute(workspace.path)) {
      throw new Error(`絶対パスを指定してください: "${workspace.path}"`);
    }
    if (!existsSync(workspace.path) || !statSync(workspace.path).isDirectory()) {
      throw new Error(`ディレクトリが見つかりません: "${workspace.path}"`);
    }
    if (this.workspaces.some((w) => w.name === workspace.name)) {
      throw new Error(`ワークスペース「${workspace.name}」は既に登録されています`);
    }
    this.workspaces.push({ name: workspace.name, path: workspace.path });
    this.save();
  }

  remove(name: string): boolean {
    const index = this.workspaces.findIndex((w) => w.name === name);
    if (index === -1) return false;
    this.workspaces.splice(index, 1);
    this.save();
    return true;
  }

  findByName(name: string): Workspace | undefined {
    return this.workspaces.find((w) => w.name === name);
  }
}

/** 指定パス配下のディレクトリ一覧を返す（隠しディレクトリ・node_modules を除外） */
export function listDirectories(dirPath: string): string[] {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    return [];
  }
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
