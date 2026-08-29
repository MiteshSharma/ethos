// Raw `node:fs` carve-out (Law 7) — see apps/ethos/src/__tests__/no-raw-fs.test.ts
// and the allowed-exception list in CLAUDE.md. `existsSync` here answers "is
// this machine set up to run Pi at all", against an operator credential file
// that is never opened and never read. Same rationale as
// platform-callcapture/src/detector.ts's binary-presence check; not a
// `~/.ethos/` operation.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Pi's default config directory — where `auth.json` lives. */
export function defaultPiConfigDir(): string {
  return join(homedir(), '.pi', 'agent');
}

/**
 * Whether the operator has authenticated Pi.
 *
 * Existence ONLY. The file holds provider credentials; this module never opens
 * it, and nothing in this package ever logs its contents — the container gets
 * it as a read-only mount and nothing else touches it.
 */
export function piCredentialsPresent(configDir: string): boolean {
  return existsSync(join(configDir, 'auth.json'));
}

/**
 * Whether `pi` is on PATH, by the same probe the coding-agent adapter doc
 * documents (`pi --version`).
 *
 * The run itself happens inside the container, not with this binary — this is
 * a deployment-readiness signal (the machine is a Pi machine), matching how the
 * existing adapter detects Pi.
 */
export function piBinaryAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('pi', ['--version'], { stdio: 'ignore' });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
