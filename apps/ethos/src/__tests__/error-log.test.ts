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

  // B3 — one turn identity. An `errors.jsonl` row that names the turn's
  // `traceId` is the difference between a line you can only read and one you
  // can look up (`ethos trace <id>`), which is the whole point of putting a
  // single id on the turn.
  it('carries the turn traceId on the row when the caller supplies one', async () => {
    const { appendErrorLog, readRecentErrors } = await freshLog();
    appendErrorLog(new EthosError({ code: 'LLM_ERROR', cause: 'boom', action: 'retry' }), {
      command: 'chat',
      traceId: 'trace-abc',
    });
    const entries = readRecentErrors();
    expect(entries[0]?.traceId).toBe('trace-abc');
    expect(entries[0]?.command).toBe('chat');
  });

  it('omits traceId entirely when the error happened outside a turn', async () => {
    const { appendErrorLog, readRecentErrors } = await freshLog();
    appendErrorLog(new EthosError({ code: 'INTERNAL', cause: 'no turn', action: 'x' }), {
      command: 'serve',
    });
    const entry = readRecentErrors()[0];
    expect(entry?.traceId).toBeUndefined();
    expect(Object.hasOwn(entry ?? {}, 'traceId')).toBe(false);
  });

  it('lifts traceId onto the observability event, not into its details blob', async () => {
    const { appendErrorLog, setObservabilityService } = await freshLog();
    const seen: Array<Record<string, unknown>> = [];
    setObservabilityService({
      recordError: (opts) => {
        seen.push({ ...opts });
      },
    });
    appendErrorLog(new EthosError({ code: 'LLM_ERROR', cause: 'boom', action: 'retry' }), {
      command: 'chat',
      traceId: 'trace-xyz',
    });
    setObservabilityService({ recordError: () => {} });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceId).toBe('trace-xyz');
    const details = seen[0]?.details as Record<string, unknown>;
    expect(details.command).toBe('chat');
    expect(Object.hasOwn(details, 'traceId')).toBe(false);
  });
});
