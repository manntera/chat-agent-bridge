import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { IClaudeProcess, ProgressEvent } from '../domain/types.js';
import { parseStreamJsonLine } from './stream-json-parser.js';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

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

  spawn(prompt: string, sessionId: string, workDir: string): void {
    if (this.process !== null) return;

    let resultText = '';
    let buffer = '';

    const proc = this.spawnFn(
      this.claudePath,
      [
        '-p',
        prompt,
        '--session-id',
        sessionId,
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ],
      { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.process = proc;

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
      this.onProcessEnd(exitCode ?? 1, resultText);
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
