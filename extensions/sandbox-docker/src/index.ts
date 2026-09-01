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
  /** `--cpus` quota. Default 2, matching the previous hardcoded value. */
  cpu?: number;
  signal?: AbortSignal;
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

    const {
      stdin,
      timeoutMs = 30_000,
      env = [],
      networkMode = 'none',
      memoryMb = 256,
      cpu = 2,
      signal,
    } = opts;

    const containerName = `ethos-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const args = ['docker', 'run', '--rm'];
    args.push('--name', containerName);
    if (stdin !== undefined) args.push('-i');
    args.push('--network', networkMode);
    args.push(`--memory=${memoryMb}m`);
    args.push('--memory-swap', `${memoryMb}m`); // disable swap
    args.push('--cpus', String(cpu));
    args.push('--pids-limit', '256');
    args.push('--cap-drop', 'ALL'); // drop all Linux capabilities
    args.push('--security-opt', 'no-new-privileges');
    for (const e of env) {
      args.push('-e', e);
    }
    args.push('--', image, ...cmd);

    return this.spawnRaw(args, stdin, timeoutMs, containerName, signal);
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up for ephemeral containers (--rm)
  }

  // ---------------------------------------------------------------------------

  private spawnRaw(
    args: string[],
    stdin: string | undefined,
    timeoutMs: number,
    containerName?: string,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const [prog, ...rest] = args;
    return new Promise((resolve, reject) => {
      // If already aborted before spawning, reject immediately.
      if (signal?.aborted) {
        reject(new Error('Docker execution aborted'));
        return;
      }

      const child = spawn(prog, rest, { stdio: ['pipe', 'pipe', 'pipe'] });

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let settled = false;

      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const killContainer = () => {
        if (containerName) {
          spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('close', () => {
            spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
          });
        }
      };

      child.stdout.on('data', (c: Buffer) => outChunks.push(c));
      child.stderr.on('data', (c: Buffer) => errChunks.push(c));

      if (stdin !== undefined) {
        child.stdin.write(stdin, 'utf-8');
      }
      child.stdin.end();

      const onAbort = () => {
        if (settled) return;
        cleanup();
        child.kill('SIGKILL');
        killContainer();
        reject(new Error('Docker execution aborted'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        child.kill('SIGKILL');
        killContainer();
        reject(new Error(`Docker command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        if (settled) return;
        cleanup();
        resolve({
          stdout: Buffer.concat(outChunks).toString('utf-8'),
          stderr: Buffer.concat(errChunks).toString('utf-8'),
          exitCode: code ?? 0,
        });
      });

      child.on('error', (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      });
    });
  }
}
