import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { IClaudeProcess, ProgressEvent, SessionOptions } from '../domain/types.js';
import { parseStreamJsonLine } from './stream-json-parser.js';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const DISCORD_SYSTEM_PROMPT = `\
回答のマークダウンはDiscordで表示されます。Discord互換の構文のみ使用してください。

使用可能: **太字** *斜体* ~~取り消し線~~ \`インラインコード\` \`\`\`コードブロック\`\`\` > 引用 >>> 複数行引用 # ## ### 見出し - リスト 1. 番号リスト [リンク](URL) ||スポイラー|| -# 小文字テキスト
使用禁止: テーブル(| |)、画像(![]()), HTMLタグ、脚注、タスクリスト(- [x])、水平線(---)

テーブルの代わりにリストやコードブロックで情報を整理してください。`;

export class ClaudeProcess implements IClaudeProcess {
  private process: ChildProcess | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly claudePath: string,
    private readonly onProgress: (event: ProgressEvent) => void,
    private readonly onProcessEnd: (exitCode: number, output: string) => void,
    private readonly spawnFn: SpawnFn = nodeSpawn,
  ) {}

  get isRunning(): boolean {
    return this.process !== null;
  }

  spawn(
    prompt: string,
    sessionId: string,
    workDir: string,
    resume: boolean,
    options: SessionOptions = {},
  ): void {
    if (this.process !== null) return;

    let resultText = '';
    let buffer = '';

    const sessionArgs = resume ? ['--resume', sessionId] : ['--session-id', sessionId];

    const optionArgs: string[] = [];
    if (options.model) optionArgs.push('--model', options.model);
    if (options.effort) optionArgs.push('--effort', options.effort);

    const proc = this.spawnFn(
      this.claudePath,
      [
        '-p',
        prompt,
        ...sessionArgs,
        ...optionArgs,
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--append-system-prompt',
        DISCORD_SYSTEM_PROMPT,
      ],
      { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.process = proc;

    let stderrOutput = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        const parsed = parseStreamJsonLine(line);
        if (parsed.kind === 'progress') {
          this.onProgress(parsed.event);
        } else if (parsed.kind === 'result') {
          resultText = parsed.text;
        }
      }
    });

    proc.on('close', (exitCode) => {
      this.process = null;
      if (this.killTimer !== null) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      const output = resultText || stderrOutput;
      this.onProcessEnd(exitCode ?? 1, output);
    });

    proc.on('error', (err) => {
      this.process = null;
      this.onProcessEnd(1, err.message);
    });
  }

  interrupt(): void {
    if (this.process === null) return;

    this.process.kill('SIGINT');

    this.killTimer = setTimeout(() => {
      if (this.process !== null) {
        this.process.kill('SIGKILL');
      }
    }, 10_000);
  }
}
