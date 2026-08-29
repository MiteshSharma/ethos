// T8 — exit ordering. `forceSettleAll()`'s deny + audit must COMPLETE before
// the process actually exits, which no fake-timer unit test can prove:
// `process.exit()` ending the process is the thing under test. So this spawns
// a real child that mirrors `serve.ts`'s `cleanup()` shape (force-settle, then
// `process.exit(0)`), sends it SIGTERM, and reads the audit marker file the
// child's observability sink wrote.
//
// Child-process precedent: apps/ethos/src/__tests__/docker-healthcheck.test.ts.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SERVICE = join(REPO_ROOT, 'apps', 'web-api', 'src', 'services', 'approvals.service');

/**
 * The child. Imports the real `ApprovalsService` by absolute path (its own
 * `@ethosagent/*` imports resolve from apps/web-api/node_modules), parks one
 * pending approval, and settles it from a SIGTERM handler shaped like
 * `serve.ts`'s `cleanup()`.
 *
 * `timeoutMs: 0` so no auto-deny timer can settle the approval instead — the
 * shutdown path is the only thing that can produce the audit row.
 */
function childScript(markerPath: string): string {
  return `import { appendFileSync } from 'node:fs';
import { ApprovalsService } from ${JSON.stringify(SERVICE)};

const marker = ${JSON.stringify(markerPath)};
const approvals = new ApprovalsService({
  allowlist: { matches: async () => false },
  timeoutMs: 0,
  observability: {
    recordSafetyApproval: (row) => appendFileSync(marker, JSON.stringify(row) + '\\n'),
  },
});

approvals.onPending(() => appendFileSync(marker, 'READY\\n'));
void approvals.requestApproval({
  sessionId: 'sess_exit',
  toolCallId: 'tc_exit',
  toolName: 'terminal',
  args: { command: 'rm -rf /' },
  reason: 'recursive force-delete',
});

process.on('SIGTERM', () => {
  approvals.forceSettleAll();
  process.exit(0);
});

// Keep the child alive until the signal lands.
setInterval(() => {}, 1000);
`;
}

describe('serve shutdown ordering — forceSettleAll before process.exit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-approval-exit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('audits the deny before the process exits on SIGTERM', async () => {
    const markerPath = join(dir, 'audit.log');
    const scriptPath = join(dir, 'shutdown-child.ts');
    await writeFile(scriptPath, childScript(markerPath), 'utf8');

    const child = spawn(TSX, [scriptPath], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    try {
      await waitFor(async () => (await readMarker(markerPath)).includes('READY'), 8000);
    } catch (err) {
      child.kill('SIGKILL');
      throw new Error(`child never parked an approval: ${String(err)}\n${stderr}`);
    }

    child.kill('SIGTERM');
    const code = await exited;

    const marker = await readMarker(markerPath);
    const rows = marker
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { decision: string; details?: { decidedBy?: string } });

    expect(code).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].details?.decidedBy).toBe('__ethos_system__');
  }, 20_000);
});

async function readMarker(path: string): Promise<string> {
  return await readFile(path, 'utf8').catch(() => '');
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
