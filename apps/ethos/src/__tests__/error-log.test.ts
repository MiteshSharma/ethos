// Phase 30.10 — error log persistence + rotation.

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `ethosDir()` resolves to `${homedir()}/.ethos`. `os.homedir()` reads `HOME`
// on POSIX, so overriding it per-test isolates the log under tmp.
let workDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  workDir = join(tmpdir(), `ethos-error-log-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  prevHome = process.env.HOME;
  process.env.HOME = workDir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(workDir, { recursive: true, force: true });
});

async function freshLog() {
  return await import('../error-log');
}

describe('error-log', () => {
  it('appendErrorLog writes one JSON line per entry', async () => {
    const { appendErrorLog, readRecentErrors } = await freshLog();
    appendErrorLog(new EthosError({ code: 'INVALID_INPUT', cause: 'a', action: 'do x' }), {
      command: 'batch',
    });
    appendErrorLog(new EthosError({ code: 'INTERNAL', cause: 'b', action: 'do y' }), {
      command: 'eval',
    });
    const entries = readRecentErrors();
    expect(entries).toHaveLength(2);
    // Newest-first order
    expect(entries[0]?.code).toBe('INTERNAL');
    expect(entries[0]?.command).toBe('eval');
    expect(entries[1]?.code).toBe('INVALID_INPUT');
    expect(entries[1]?.command).toBe('batch');
  });

  it('readRecentErrors returns [] when log absent', async () => {
    const { readRecentErrors } = await freshLog();
    expect(readRecentErrors()).toEqual([]);
  });

  it('readRecentErrors caps at limit', async () => {
    const { appendErrorLog, readRecentErrors } = await freshLog();
    for (let i = 0; i < 60; i++) {
      appendErrorLog(new EthosError({ code: 'INTERNAL', cause: `n${i}`, action: 'x' }));
    }
    expect(readRecentErrors(10)).toHaveLength(10);
    expect(readRecentErrors()).toHaveLength(50);
  });

  it('rotates when the log exceeds 10MB', async () => {
    const { appendErrorLog, errorLogPath } = await freshLog();
    // Pre-seed the log file just over 10MB.
    const path = errorLogPath();
    mkdirSync(join(workDir, '.ethos', 'logs'), { recursive: true });
    const big = `${'x'.repeat(11 * 1024 * 1024)}\n`;
    writeFileSync(path, big);
    expect(statSync(path).size).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    // The next append triggers rotation: backup is taken, current resets.
    appendErrorLog(new EthosError({ code: 'INTERNAL', cause: 'after rotate', action: 'x' }));
    expect(statSync(`${path}.1`).size).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    // Current log holds only the new entry.
    expect(statSync(path).size).toBeLessThan(1024);
  });
});
