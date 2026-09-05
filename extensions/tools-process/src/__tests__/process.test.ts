import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryError, type Storage, type Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessTools } from '../index';
import { loadRegistry, saveRegistry } from '../registry';
import { LOG_MAX_BYTES } from '../spawn';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(workingDir: string) {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

function getTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

/**
 * Minimal Storage that mimics ScopedStorage's boundary behaviour: any path
 * outside `allowed` throws BoundaryError on a read probe. Lets the cwd
 * validation tests exercise the allowlist gate without depending on
 * @ethosagent/storage-fs.
 */
function boundaryStorage(allowed: string[]): Storage {
  const isAllowed = (p: string) => allowed.some((a) => p === a || p.startsWith(`${a}/`));
  const denyRead = (p: string) => {
    if (!isAllowed(p)) throw new BoundaryError('read', p, allowed);
  };
  const denyWrite = (p: string) => {
    if (!isAllowed(p)) throw new BoundaryError('write', p, allowed);
  };
  return {
    async read(p) {
      denyRead(p);
      return null;
    },
    async readBytes(p) {
      denyRead(p);
      return null;
    },
    async exists(p) {
      denyRead(p);
      return false;
    },
    async mtime(p) {
      denyRead(p);
      return null;
    },
    async list(p) {
      denyRead(p);
      return [];
    },
    async listEntries(p) {
      denyRead(p);
      return [];
    },
    async write(p) {
      denyWrite(p);
    },
    async append(p) {
      denyWrite(p);
    },
    async writeAtomic(p) {
      denyWrite(p);
    },
    async mkdir(p) {
      denyWrite(p);
    },
    async remove(p) {
      denyWrite(p);
    },
    async rename(from, to) {
      denyWrite(from);
      denyWrite(to);
    },
    async chmod() {},
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

// Spawn a real, harmless long-lived child and return its (live) pid. Cap tests
// that inject fake `running` registry entries need a pid that the liveness
// sweep in process_start treats as alive — a dead/bogus pid would be swept to
// `orphan` and free the cap slot. Every spawned dummy is tracked and SIGKILLed
// in afterEach, so the registry's own cleanup loop never targets the test
// runner's pid.
const liveDummies: ChildProcess[] = [];
function spawnLivePid(): number {
  const child = spawn('sleep', ['999'], { stdio: 'ignore', detached: false });
  liveDummies.push(child);
  if (child.pid === undefined) throw new Error('failed to spawn live dummy process');
  return child.pid;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let workDir: string;
let tools: Tool[];

beforeEach(() => {
  dataDir = join(tmpdir(), `ethos-proc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workDir = dataDir;
  mkdirSync(dataDir, { recursive: true });
  tools = createProcessTools(dataDir);
});

afterEach(() => {
  // best-effort cleanup: kill any running processes from the test
  const registry = loadRegistry(dataDir);
  for (const entry of Object.values(registry)) {
    if (entry.status === 'running') {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  // Reap any live-dummy children spawned to back fake `running` entries.
  for (const child of liveDummies.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// process_start
// ---------------------------------------------------------------------------

describe('process_start', () => {
  it('returns id, pid, name, started_at and the process is running', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as {
      id: string;
      pid: number;
      name: string;
      started_at: string;
    };
    expect(data.id).toBeTruthy();
    expect(data.pid).toBeGreaterThan(0);
    expect(data.name).toBeTruthy();
    expect(data.started_at).toBeTruthy();

    // The process should actually be alive
    expect(() => process.kill(data.pid, 0)).not.toThrow();

    // cleanup
    process.kill(data.pid, 'SIGKILL');
  });

  it('carries structured { id, pid } matching the value (R6 evidence)', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as { id: string; pid: number };
    expect(result.structured).toEqual({ id: data.id, pid: data.pid });

    process.kill(data.pid, 'SIGKILL');
  });

  it('carries no structured when the command is missing (ok:false IS the evidence)', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    expect('structured' in result).toBe(false);
  });

  it('uses ctx.workingDir as default cwd', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id } = JSON.parse(result.value) as { id: string; pid: number };
    const entry = loadRegistry(dataDir)[id];
    expect(entry?.cwd).toBe(workDir);

    process.kill(entry?.pid ?? 0, 'SIGKILL');
  });

  it('uses a custom name when provided', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute(
      { command: 'sleep 30', name: 'my-server' },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as { name: string; pid: number };
    expect(data.name).toBe('my-server');
    process.kill(data.pid, 'SIGKILL');
  });

  it('records started_by from ctx.personalityId', async () => {
    const start = getTool(tools, 'process_start');
    const ctx = { ...makeCtx(workDir), personalityId: 'archivist' };
    const result = await start.execute({ command: 'sleep 30' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id, pid } = JSON.parse(result.value) as { id: string; pid: number };
    expect(loadRegistry(dataDir)[id]?.started_by).toBe('archivist');
    process.kill(pid, 'SIGKILL');
  });

  it("records started_by as 'unknown' when ctx has no personalityId", async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id, pid } = JSON.parse(result.value) as { id: string; pid: number };
    expect(loadRegistry(dataDir)[id]?.started_by).toBe('unknown');
    process.kill(pid, 'SIGKILL');
  });

  it('returns input_invalid when command is missing', async () => {
    const start = getTool(tools, 'process_start');
    const result = await start.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('enforces cap of 8 concurrent processes for the calling personality', async () => {
    // Inject 8 running entries for personality 'capped' without going through
    // process_start. They share one live pid so the liveness sweep in
    // process_start keeps them `running` — a dead pid would be swept to
    // `orphan` and free the cap slots.
    const livePid = spawnLivePid();
    const registry = loadRegistry(dataDir);
    for (let i = 0; i < 8; i++) {
      const id = `fake-${i}`;
      registry[id] = {
        id,
        name: `fake-${i}`,
        pid: livePid,
        command: 'sleep 999',
        cwd: workDir,
        status: 'running',
        startedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        started_by: 'capped',
      };
    }
    saveRegistry(dataDir, registry);

    const start = getTool(tools, 'process_start');
    const ctx = { ...makeCtx(workDir), personalityId: 'capped' };
    const result = await start.execute({ command: 'echo hi' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('PROCESS_CAP_EXCEEDED');
    }
  });

  it('dead `running` entries do not consume the cap: a 9th start succeeds after the sweep', async () => {
    // 8 entries marked `running` for personality 'stale' whose pids are all
    // dead. Without a liveness sweep before the cap-check, a 9th start would
    // hit a false PROCESS_CAP_EXCEEDED. The sweep flips them to `orphan`,
    // freeing the slots.
    const registry = loadRegistry(dataDir);
    for (let i = 0; i < 8; i++) {
      const id = `dead-${i}`;
      registry[id] = {
        id,
        name: `dead-${i}`,
        // A pid far above the OS pid_max: process.kill(pid, 0) throws, so
        // isAlive() reports it dead — a deterministic stand-in for an
        // externally-died process.
        pid: 2_000_000_000 + i,
        command: 'sleep 999',
        cwd: workDir,
        status: 'running',
        startedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        started_by: 'stale',
      };
    }
    saveRegistry(dataDir, registry);

    const start = getTool(tools, 'process_start');
    const ctx = { ...makeCtx(workDir), personalityId: 'stale' };
    const result = await start.execute({ command: 'sleep 30' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id, pid } = JSON.parse(result.value) as { id: string; pid: number };

    // The 8 dead entries should now be `orphan`, and the 9th is `running`.
    const after = loadRegistry(dataDir);
    for (let i = 0; i < 8; i++) {
      expect(after[`dead-${i}`]?.status).toBe('orphan');
    }
    expect(after[id]?.status).toBe('running');

    process.kill(pid, 'SIGKILL');
  });

  it('cap is per-personality: personality A at the cap does not block personality B', async () => {
    // 8 running entries owned by personality A, backed by a live pid so the
    // liveness sweep keeps them `running` and the cap genuinely applies.
    const livePid = spawnLivePid();
    const registry = loadRegistry(dataDir);
    for (let i = 0; i < 8; i++) {
      const id = `a-${i}`;
      registry[id] = {
        id,
        name: `a-${i}`,
        pid: livePid,
        command: 'sleep 999',
        cwd: workDir,
        status: 'running',
        startedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        started_by: 'personality-a',
      };
    }
    saveRegistry(dataDir, registry);

    const start = getTool(tools, 'process_start');

    // Personality A is at the cap — blocked.
    const ctxA = { ...makeCtx(workDir), personalityId: 'personality-a' };
    const resultA = await start.execute({ command: 'echo hi' }, ctxA);
    expect(resultA.ok).toBe(false);

    // Personality B has zero running processes — allowed despite A's cap.
    const ctxB = { ...makeCtx(workDir), personalityId: 'personality-b' };
    const resultB = await start.execute({ command: 'sleep 30' }, ctxB);
    expect(resultB.ok).toBe(true);
    if (!resultB.ok) return;
    const { pid } = JSON.parse(resultB.value) as { pid: number };
    process.kill(pid, 'SIGKILL');
  });

  it('honors a custom capMax via createProcessTools opts', async () => {
    const cappedTools = createProcessTools(dataDir, { capMax: 1 });
    const start = getTool(cappedTools, 'process_start');
    const ctx = { ...makeCtx(workDir), personalityId: 'cap1' };

    const first = await start.execute({ command: 'sleep 30' }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const { pid } = JSON.parse(first.value) as { pid: number };

    const second = await start.execute({ command: 'echo hi' }, ctx);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('PROCESS_CAP_EXCEEDED');

    process.kill(pid, 'SIGKILL');
  });

  it('falls back to the default cap when capMax is not a positive integer', async () => {
    // capMax: 0 / NaN / negative must NOT disable or wedge the cap — the
    // factory falls back to the default (8). Inject 8 running entries and
    // confirm a 9th start is still rejected.
    for (const bad of [0, -1, Number.NaN]) {
      const dir = join(
        tmpdir(),
        `ethos-proc-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(dir, { recursive: true });
      try {
        const livePid = spawnLivePid();
        const registry: Record<string, ReturnType<typeof loadRegistry>[string]> = {};
        for (let i = 0; i < 8; i++) {
          registry[`f-${i}`] = {
            id: `f-${i}`,
            name: `f-${i}`,
            // Live pid so the liveness sweep keeps the entry `running`.
            pid: livePid,
            command: 'sleep 999',
            cwd: dir,
            status: 'running',
            startedAt: new Date().toISOString(),
            lastTouchedAt: new Date().toISOString(),
            started_by: 'p',
          };
        }
        saveRegistry(dir, registry);
        const t = createProcessTools(dir, { capMax: bad });
        const ctx = { ...makeCtx(dir), personalityId: 'p' };
        const result = await getTool(t, 'process_start').execute({ command: 'echo hi' }, ctx);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('PROCESS_CAP_EXCEEDED');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('returns INVALID_CWD when cwd is outside the personality allowlist', async () => {
    const start = getTool(tools, 'process_start');
    const ctx = {
      ...makeCtx(workDir),
      personalityId: 'scoped',
      storage: boundaryStorage([workDir]),
    };
    const result = await start.execute({ command: 'echo hi', cwd: '/etc/forbidden' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('input_invalid');
      expect(result.error).toContain('INVALID_CWD');
    }
  });

  it('allows an explicit cwd that is inside the personality allowlist', async () => {
    const start = getTool(tools, 'process_start');
    const ctx = {
      ...makeCtx(workDir),
      personalityId: 'scoped',
      storage: boundaryStorage([workDir]),
    };
    const result = await start.execute({ command: 'sleep 30', cwd: workDir }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { pid } = JSON.parse(result.value) as { pid: number };
    process.kill(pid, 'SIGKILL');
  });

  it('skips cwd validation when ctx.storage is absent', async () => {
    const start = getTool(tools, 'process_start');
    // No storage wired — explicit cwd should not be boundary-checked.
    const result = await start.execute({ command: 'sleep 30', cwd: workDir }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { pid } = JSON.parse(result.value) as { pid: number };
    process.kill(pid, 'SIGKILL');
  });

  it('does not return INVALID_CWD for a cwd that simply does not exist yet', async () => {
    const start = getTool(tools, 'process_start');
    const futureDir = join(workDir, 'not-created-yet');
    const ctx = {
      ...makeCtx(workDir),
      personalityId: 'scoped',
      // futureDir is inside the allowlist, just absent on disk.
      storage: boundaryStorage([workDir]),
    };
    const result = await start.execute({ command: 'echo hi', cwd: futureDir }, ctx);
    // Either it spawns (cwd created lazily is not our concern) or it fails
    // SPAWN_FAILED — but it must NOT be INVALID_CWD.
    if (!result.ok) {
      expect(result.error).not.toContain('INVALID_CWD');
      expect(result.error).toContain('SPAWN_FAILED');
    } else {
      const { pid } = JSON.parse(result.value) as { pid: number };
      process.kill(pid, 'SIGKILL');
    }
  });
});

// ---------------------------------------------------------------------------
// process_list
// ---------------------------------------------------------------------------

describe('process_list', () => {
  it('shows a running process', async () => {
    const start = getTool(tools, 'process_start');
    const list = getTool(tools, 'process_list');

    const startResult = await start.execute(
      { command: 'sleep 30', name: 'sleeper' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const listResult = await list.execute({}, makeCtx(workDir));
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const items = JSON.parse(listResult.value) as Array<{ id: string; status: string }>;
    const found = items.find((x) => x.id === id);
    expect(found).toBeDefined();
    expect(found?.status).toBe('running');

    process.kill(pid, 'SIGKILL');
  });

  it('marks orphan when process is killed externally', async () => {
    const start = getTool(tools, 'process_start');
    const list = getTool(tools, 'process_list');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Kill externally without going through process_stop
    process.kill(pid, 'SIGKILL');

    // Give the OS a moment to reap the process
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });

    const listResult = await list.execute({}, makeCtx(workDir));
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const items = JSON.parse(listResult.value) as Array<{ id: string; status: string }>;
    const found = items.find((x) => x.id === id);
    expect(found?.status).toBe('orphan');
  });

  it('returns an empty array when no processes tracked', async () => {
    const list = getTool(tools, 'process_list');
    const result = await list.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.value)).toEqual([]);
  });

  it('does NOT rotate the log of a running process (live fd must not be renamed)', async () => {
    // A running detached child holds an open fd to its log inode. process_list
    // must leave that log alone even when it is oversized.
    const start = getTool(tools, 'process_start');
    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Inflate its stdout log past the threshold while it is still running.
    const stdoutLog = join(dataDir, 'processes', id, 'stdout.log');
    writeFileSync(stdoutLog, 'x'.repeat(LOG_MAX_BYTES + 1), 'utf8');

    await getTool(tools, 'process_list').execute({}, makeCtx(workDir));

    expect(existsSync(`${stdoutLog}.1`)).toBe(false);
    expect(statSync(stdoutLog).size).toBe(LOG_MAX_BYTES + 1);

    process.kill(pid, 'SIGKILL');
  });

  it('rotates the oversized log of a terminal process', async () => {
    const id = 'exited-big-log';
    const procDir = join(dataDir, 'processes', id);
    mkdirSync(procDir, { recursive: true });
    const stdoutLog = join(procDir, 'stdout.log');
    writeFileSync(stdoutLog, 'x'.repeat(LOG_MAX_BYTES + 1), 'utf8');
    saveRegistry(dataDir, {
      [id]: {
        id,
        name: id,
        pid: 999999,
        command: 'echo done',
        cwd: workDir,
        status: 'exited',
        exitCode: 0,
        startedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        started_by: 'test',
      },
    });

    await getTool(tools, 'process_list').execute({}, makeCtx(workDir));

    expect(existsSync(`${stdoutLog}.1`)).toBe(true);
    expect(statSync(stdoutLog).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// process_logs
// ---------------------------------------------------------------------------

describe('process_logs', () => {
  it('returns last N lines from stdout', async () => {
    const start = getTool(tools, 'process_start');
    const logs = getTool(tools, 'process_logs');

    // Write 5 lines then sleep so the process stays alive long enough
    const startResult = await start.execute(
      { command: 'for i in 1 2 3 4 5; do echo "line$i"; done; sleep 30' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Wait for lines to be written
    await waitFor(() => {
      const logPath = join(dataDir, 'processes', id, 'stdout.log');
      try {
        if (!existsSync(logPath)) return false;
        return readFileSync(logPath, 'utf8').includes('line5');
      } catch {
        return false;
      }
    });

    const logsResult = await logs.execute({ id, lines: 3, stream: 'stdout' }, makeCtx(workDir));
    expect(logsResult.ok).toBe(true);
    if (!logsResult.ok) return;
    const output = logsResult.value;
    expect(output).toContain('line3');
    expect(output).toContain('line4');
    expect(output).toContain('line5');
    expect(output).not.toContain('line1');
    expect(output).not.toContain('line2');

    process.kill(pid, 'SIGKILL');
  });

  it('returns (no output) for a process with empty logs', async () => {
    const start = getTool(tools, 'process_start');
    const logs = getTool(tools, 'process_logs');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    // Don't wait — logs should be empty immediately after start
    const logsResult = await logs.execute({ id, stream: 'stdout' }, makeCtx(workDir));
    expect(logsResult.ok).toBe(true);
    if (!logsResult.ok) return;
    expect(logsResult.value).toBe('(no output)');

    process.kill(pid, 'SIGKILL');
  });

  it('returns execution_failed for unknown id', async () => {
    const logs = getTool(tools, 'process_logs');
    const result = await logs.execute({ id: 'does-not-exist' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid when id is missing', async () => {
    const logs = getTool(tools, 'process_logs');
    const result = await logs.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

// ---------------------------------------------------------------------------
// process_stop
// ---------------------------------------------------------------------------

describe('process_stop', () => {
  it('stops a running process with SIGTERM', async () => {
    const start = getTool(tools, 'process_start');
    const stop = getTool(tools, 'process_stop');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const stopResult = await stop.execute({ id }, makeCtx(workDir));
    expect(stopResult.ok).toBe(true);
    if (!stopResult.ok) return;
    const data = JSON.parse(stopResult.value) as { stopped: boolean };
    expect(data.stopped).toBe(true);

    // Registry entry should be 'killed'
    const entry = loadRegistry(dataDir)[id];
    expect(entry?.status).toBe('killed');

    // Verify process is actually gone (give OS a moment)
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('stops a running process with SIGKILL', async () => {
    const start = getTool(tools, 'process_start');
    const stop = getTool(tools, 'process_stop');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const stopResult = await stop.execute({ id, signal: 'SIGKILL' }, makeCtx(workDir));
    expect(stopResult.ok).toBe(true);
    if (!stopResult.ok) return;
    const data = JSON.parse(stopResult.value) as { stopped: boolean };
    expect(data.stopped).toBe(true);

    process.kill(pid, 'SIGKILL'); // no-op if already dead
  });

  it('returns stopped:false for an already-exited process', async () => {
    const stop = getTool(tools, 'process_stop');
    const registry = loadRegistry(dataDir);
    const id = 'already-done';
    registry[id] = {
      id,
      name: 'done',
      pid: 12345,
      command: 'echo hi',
      cwd: workDir,
      status: 'exited',
      exitCode: 0,
      startedAt: new Date().toISOString(),
      lastTouchedAt: new Date().toISOString(),
      started_by: 'test',
    };
    saveRegistry(dataDir, registry);

    const result = await stop.execute({ id }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as { stopped: boolean; exit_code?: number };
    expect(data.stopped).toBe(false);
    expect(data.exit_code).toBe(0);
  });

  it('returns execution_failed for unknown id', async () => {
    const stop = getTool(tools, 'process_stop');
    const result = await stop.execute({ id: 'does-not-exist' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid when id is missing', async () => {
    const stop = getTool(tools, 'process_stop');
    const result = await stop.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

// ---------------------------------------------------------------------------
// process_wait
// ---------------------------------------------------------------------------

describe('process_wait', () => {
  it('waits for a short-lived process to exit', async () => {
    const start = getTool(tools, 'process_start');
    const wait = getTool(tools, 'process_wait');

    const startResult = await start.execute({ command: 'sleep 0.1' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const waitResult = await wait.execute({ id, timeout_s: 5 }, makeCtx(workDir));
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) return;
    const data = JSON.parse(waitResult.value) as { exited: boolean };
    expect(data.exited).toBe(true);
  });

  it('returns exited:false when process does not finish in time', async () => {
    const start = getTool(tools, 'process_start');
    const wait = getTool(tools, 'process_wait');

    const startResult = await start.execute({ command: 'sleep 60' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const waitResult = await wait.execute({ id, timeout_s: 0.3 }, makeCtx(workDir));
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) {
      process.kill(pid, 'SIGKILL');
      return;
    }
    const data = JSON.parse(waitResult.value) as { exited: boolean };
    expect(data.exited).toBe(false);

    process.kill(pid, 'SIGKILL');
  });

  it('returns immediately for an already-exited process', async () => {
    const wait = getTool(tools, 'process_wait');
    const registry = loadRegistry(dataDir);
    const id = 'already-done-2';
    registry[id] = {
      id,
      name: 'done',
      pid: 12345,
      command: 'echo hi',
      cwd: workDir,
      status: 'exited',
      exitCode: 0,
      startedAt: new Date().toISOString(),
      lastTouchedAt: new Date().toISOString(),
      started_by: 'test',
    };
    saveRegistry(dataDir, registry);

    const result = await wait.execute({ id }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value) as { exited: boolean; exit_code?: number };
    expect(data.exited).toBe(true);
    expect(data.exit_code).toBe(0);
  });

  it('returns execution_failed for unknown id', async () => {
    const wait = getTool(tools, 'process_wait');
    const result = await wait.execute({ id: 'does-not-exist' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns input_invalid when id is missing', async () => {
    const wait = getTool(tools, 'process_wait');
    const result = await wait.execute({}, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('error-code prefixes', () => {
  it('process_logs prefixes unknown id with PROCESS_NOT_FOUND', async () => {
    const logs = getTool(tools, 'process_logs');
    const result = await logs.execute({ id: 'nope' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROCESS_NOT_FOUND');
      expect(result.code).toBe('execution_failed');
    }
  });

  it('process_stop prefixes unknown id with PROCESS_NOT_FOUND', async () => {
    const stop = getTool(tools, 'process_stop');
    const result = await stop.execute({ id: 'nope' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROCESS_NOT_FOUND');
      expect(result.code).toBe('execution_failed');
    }
  });

  it('process_wait prefixes unknown id with PROCESS_NOT_FOUND', async () => {
    const wait = getTool(tools, 'process_wait');
    const result = await wait.execute({ id: 'nope' }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROCESS_NOT_FOUND');
      expect(result.code).toBe('execution_failed');
    }
  });

  it('process_start prefixes a spawn failure with SPAWN_FAILED', async () => {
    const start = getTool(tools, 'process_start');
    // A cwd that does not exist makes the detached spawn fail.
    const result = await start.execute(
      { command: 'echo hi', cwd: join(workDir, 'missing-dir-xyz') },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SPAWN_FAILED');
      expect(result.code).toBe('execution_failed');
    }
  });

  it('process_stop rejects an unsupported signal with SIGNAL_NOT_SUPPORTED', async () => {
    const start = getTool(tools, 'process_start');
    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const stop = getTool(tools, 'process_stop');
    const result = await stop.execute(
      { id, signal: 'SIGHUP' as unknown as 'SIGTERM' },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SIGNAL_NOT_SUPPORTED');
      expect(result.code).toBe('input_invalid');
    }

    process.kill(pid, 'SIGKILL');
  });
});

describe('maxResultChars', () => {
  it('process_start/stop/wait cap at 1024 and process_logs at 64_000', () => {
    expect(getTool(tools, 'process_start').maxResultChars).toBe(1024);
    expect(getTool(tools, 'process_stop').maxResultChars).toBe(1024);
    expect(getTool(tools, 'process_wait').maxResultChars).toBe(1024);
    expect(getTool(tools, 'process_logs').maxResultChars).toBe(64_000);
  });
});

// ---------------------------------------------------------------------------
// Stress: sequential start/stop cycles (plan success criterion)
// ---------------------------------------------------------------------------

describe('sequential start/stop cycles', () => {
  it('100 process_start/process_stop cycles complete without registry corruption or pid leaks', async () => {
    const start = getTool(tools, 'process_start');
    const stop = getTool(tools, 'process_stop');
    const CYCLES = 100;

    const ids: string[] = [];
    for (let i = 0; i < CYCLES; i++) {
      const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;
      const { id } = JSON.parse(startResult.value) as { id: string };
      ids.push(id);

      const stopResult = await stop.execute({ id, signal: 'SIGKILL' }, makeCtx(workDir));
      expect(stopResult.ok).toBe(true);

      // Registry stays valid JSON / loads cleanly throughout.
      const reg = loadRegistry(dataDir);
      expect(reg[id]).toBeDefined();
    }

    // No entry lost or duplicated: exactly CYCLES distinct ids tracked.
    expect(new Set(ids).size).toBe(CYCLES);
    const final = loadRegistry(dataDir);
    expect(Object.keys(final)).toHaveLength(CYCLES);

    // No `running` entries leak — every cycle was stopped.
    for (const id of ids) {
      const entry = final[id];
      expect(entry).toBeDefined();
      expect(['killed', 'exited', 'orphan']).toContain(entry?.status);
    }
  });
});

describe('createProcessTools', () => {
  it('returns 6 tools', () => {
    expect(tools).toHaveLength(6);
  });

  it('returns tools with distinct names', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(6);
    expect(names).toContain('process_start');
    expect(names).toContain('process_list');
    expect(names).toContain('process_logs');
    expect(names).toContain('process_stop');
    expect(names).toContain('process_wait');
    expect(names).toContain('process_watch');
  });
});

// ---------------------------------------------------------------------------
// process_watch
// ---------------------------------------------------------------------------

describe('process_watch', () => {
  it('returns PROCESS_NOT_FOUND for a non-existent id', async () => {
    const watch = getTool(tools, 'process_watch');
    const result = await watch.execute(
      { id: 'does-not-exist', patterns: ['hello'] },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROCESS_NOT_FOUND');
      expect(result.code).toBe('execution_failed');
    }
  });

  it('returns immediately for an already-exited process', async () => {
    const id = 'exited-watch';
    const registry = loadRegistry(dataDir);
    registry[id] = {
      id,
      name: 'done',
      pid: 12345,
      command: 'echo hi',
      cwd: workDir,
      status: 'exited',
      exitCode: 42,
      startedAt: new Date().toISOString(),
      lastTouchedAt: new Date().toISOString(),
      started_by: 'test',
    };
    saveRegistry(dataDir, registry);

    const watch = getTool(tools, 'process_watch');
    const result = await watch.execute({ id, patterns: ['hello'] }, makeCtx(workDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(false);
    expect(data.process_exited).toBe(true);
    expect(data.exit_code).toBe(42);
  });

  it('matches a substring pattern from stdout', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute(
      { command: 'echo "listening on port 3000"' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const result = await watch.execute(
      { id, patterns: ['listening on port'], timeout_s: 5 },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(true);
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].pattern).toBe('listening on port');
    expect(data.matches[0].line).toContain('listening on port 3000');
    expect(data.matches[0].stream).toBe('stdout');
    expect(data.matches[0].elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it('matches a regex pattern', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute(
      { command: 'echo "error TS2345: something"' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const result = await watch.execute(
      { id, patterns: ['/error TS\\d+/'], timeout_s: 5 },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(true);
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].pattern).toBe('/error TS\\d+/');
    expect(data.matches[0].line).toContain('error TS2345');
  });

  it('returns timed_out when no pattern matches within timeout', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const result = await watch.execute(
      { id, patterns: ['will-never-match'], timeout_s: 0.5 },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(false);
    expect(data.timed_out).toBe(true);

    process.kill(pid, 'SIGKILL');
  });

  it('collects multiple matches with stop_on_first_match: false', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute(
      { command: 'echo "match-A"; echo "match-B"; echo "match-C"' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const result = await watch.execute(
      { id, patterns: ['match-'], stop_on_first_match: false, timeout_s: 5 },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(true);
    expect(data.matches.length).toBeGreaterThanOrEqual(3);
  });

  it('returns process_exited when process exits before matching', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute(
      { command: 'echo "nothing relevant"; exit 0' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const result = await watch.execute(
      { id, patterns: ['will-not-match'], timeout_s: 5 },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(false);
    expect(data.process_exited).toBe(true);
  });

  it('resolves with matched: false on abort signal', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const ac = new AbortController();
    const ctx = { ...makeCtx(workDir), abortSignal: ac.signal };

    setTimeout(() => ac.abort(), 200);

    const result = await watch.execute({ id, patterns: ['never-match'], timeout_s: 30 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(false);

    process.kill(pid, 'SIGKILL');
  });

  it('streams filter: watching only stdout does not pick up stderr matches', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute(
      { command: 'echo "stderr-marker" >&2; echo "stdout-marker"' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const result = await watch.execute(
      { id, patterns: ['stderr-marker'], streams: 'stdout', timeout_s: 3 },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(false);
  });

  it('maxResultChars is 4096', () => {
    expect(getTool(tools, 'process_watch').maxResultChars).toBe(4096);
  });

  it('returns input_invalid for a malformed regex pattern', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute({ command: 'sleep 30' }, makeCtx(workDir));
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id, pid } = JSON.parse(startResult.value) as { id: string; pid: number };

    const result = await watch.execute({ id, patterns: ['/[invalid/'] }, makeCtx(workDir));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('INVALID_PATTERN');
      expect(result.code).toBe('input_invalid');
    }

    process.kill(pid, 'SIGKILL');
  });

  it('handles output split across multiple writes', async () => {
    const start = getTool(tools, 'process_start');
    const watch = getTool(tools, 'process_watch');

    const startResult = await start.execute(
      { command: 'printf "partial-"; sleep 0.3; echo "complete"' },
      makeCtx(workDir),
    );
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { id } = JSON.parse(startResult.value) as { id: string };

    const result = await watch.execute(
      { id, patterns: ['partial-complete'], timeout_s: 5 },
      makeCtx(workDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(result.value);
    expect(data.matched).toBe(true);
    expect(data.matches[0].line).toContain('partial-complete');
  });
});
