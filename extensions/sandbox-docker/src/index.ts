import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  env?: string[];
  networkMode?: 'none' | 'bridge';
  memoryMb?: number;
}

// ---------------------------------------------------------------------------
// DockerSandbox
// ---------------------------------------------------------------------------

export class DockerSandbox {
  private _available = false;

  async init(): Promise<void> {
    try {
      const result = await this.spawnRaw(['docker', 'info'], undefined, 5_000);
      this._available = result.exitCode === 0;
    } catch {
      this._available = false;
    }
  }

  isAvailable(): boolean {
    return this._available;
  }

  async run(image: string, cmd: string[], opts: RunOptions = {}): Promise<ExecResult> {
    if (!this._available) {
      return { stdout: '', stderr: 'Docker not available', exitCode: 1 };
    }

    const { stdin, timeoutMs = 30_000, env = [], networkMode = 'none', memoryMb = 256 } = opts;

    const args = ['docker', 'run', '--rm'];
    if (stdin !== undefined) args.push('-i');
    args.push('--network', networkMode);
    args.push(`--memory=${memoryMb}m`);
    args.push('--memory-swap', `${memoryMb}m`); // disable swap
    args.push('--cap-drop', 'ALL'); // drop all Linux capabilities
    args.push('--security-opt', 'no-new-privileges');
    for (const e of env) {
      args.push('-e', e);
    }
    args.push(image, ...cmd);

    return this.spawnRaw(args, stdin, timeoutMs);
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up for ephemeral containers (--rm)
  }

  // ---------------------------------------------------------------------------

  private spawnRaw(
    args: string[],
    stdin: string | undefined,
    timeoutMs: number,
  ): Promise<ExecResult> {
    const [prog, ...rest] = args;
    return new Promise((resolve, reject) => {
      const child = spawn(prog, rest, { stdio: ['pipe', 'pipe', 'pipe'] });

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      child.stdout.on('data', (c: Buffer) => outChunks.push(c));
      child.stderr.on('data', (c: Buffer) => errChunks.push(c));

      if (stdin !== undefined) {
        child.stdin.write(stdin, 'utf-8');
      }
      child.stdin.end();

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Docker command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(outChunks).toString('utf-8'),
          stderr: Buffer.concat(errChunks).toString('utf-8'),
          exitCode: code ?? 0,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
