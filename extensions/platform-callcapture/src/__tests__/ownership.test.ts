// Cross-process ownership claim for the call-capture daemon (see
// ownership.ts's header comment for the full "two hosts, two daemons"
// problem this closes). Mirrors `extensions/team-supervisor/src/
// __tests__/concurrent/pid.test.ts`'s test shape (real tmpdir, real file
// operations) but drives liveness through the injectable `isProcessAlive`
// port instead of relying on real PIDs — `tryClaimOwnership` must never
// crash the caller on a lost race, so its tests exercise the graceful
// "already held" branch directly rather than only the throwing
// `acquirePidFile` precedent's "current process is always alive" trick.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tryClaimOwnership } from '../ownership';

let workDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `ethos-callcapture-ownership-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('tryClaimOwnership', () => {
  it('claims the lock when no lock file exists, and writes this process pid', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    const result = tryClaimOwnership(lockPath);

    expect(result.claimed).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(Number(readFileSync(lockPath, 'utf-8').trim())).toBe(process.pid);
  });

  it('release() removes the lock file', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    const result = tryClaimOwnership(lockPath);
    if (!result.claimed) throw new Error('expected claim to succeed');

    result.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns claimed: false with the owner pid when a live process already holds the lock — does not throw', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    writeFileSync(lockPath, '4242');

    const result = tryClaimOwnership(lockPath, { isProcessAlive: (pid) => pid === 4242 });

    expect(result).toEqual({ claimed: false, ownerPid: 4242 });
    // The lock file must be left untouched — a losing caller must not
    // disturb the winner's lock.
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe('4242');
  });

  it('cleans up a stale lock file left by a dead pid and claims it', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    writeFileSync(lockPath, '9999999');

    const result = tryClaimOwnership(lockPath, { isProcessAlive: () => false });

    expect(result.claimed).toBe(true);
    expect(Number(readFileSync(lockPath, 'utf-8').trim())).toBe(process.pid);
  });

  it('creates the parent directory if it does not exist yet', () => {
    const lockPath = join(workDir, 'nested', 'dir', 'callcapture.lock');
    const result = tryClaimOwnership(lockPath);

    expect(result.claimed).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('an unreadable/corrupt lock file is treated as stale and reclaimed', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    writeFileSync(lockPath, 'not-a-pid');

    const result = tryClaimOwnership(lockPath, { isProcessAlive: () => true });

    expect(result.claimed).toBe(true);
    expect(Number(readFileSync(lockPath, 'utf-8').trim())).toBe(process.pid);
  });
});
