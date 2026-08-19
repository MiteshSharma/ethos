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
import type { Clock } from '../detector';
import { CallCaptureOwnershipManager, tryClaimOwnership } from '../ownership';

/** Fake Clock — mirrors daemon.test.ts's own FakeClock idiom. Pending
 * timers are advanced explicitly, never by real time, so the retry cadence
 * can be driven deterministically without waiting real seconds. */
class FakeClock implements Clock {
  private nextId = 1;
  private readonly pending = new Map<number, () => void>();

  setTimeout(fn: () => void, _ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fire every timer currently pending, as if its `ms` had elapsed. */
  advance(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

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

// P0 (plan/phases/call-capture-desktop-ux.md) — `tryClaimOwnership` was
// previously called exactly once, at process startup, by both `serve.ts`
// and `gateway.ts`. A process that lost that race ran for its entire
// lifetime with no `CallCaptureDaemon` constructed at all, even after the
// process that won the race exited and released the lock.
// `CallCaptureOwnershipManager` closes that gap with a bounded retry timer.
describe('CallCaptureOwnershipManager', () => {
  it('claims immediately and calls onOwnershipClaimed synchronously when the lock is free', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    const clock = new FakeClock();
    let claimed = false;
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      onOwnershipClaimed: () => {
        claimed = true;
        return () => {};
      },
    });

    manager.start();

    expect(claimed).toBe(true);
    expect(manager.owns).toBe(true);
    expect(clock.pendingCount).toBe(0);
    expect(Number(readFileSync(lockPath, 'utf-8').trim())).toBe(process.pid);
  });

  it('does not call onOwnershipClaimed and schedules a retry when a live process already holds the lock', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    writeFileSync(lockPath, '4242');
    const clock = new FakeClock();
    let claimed = false;
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      isProcessAlive: (pid) => pid === 4242,
      onOwnershipClaimed: () => {
        claimed = true;
        return () => {};
      },
    });

    manager.start();

    expect(claimed).toBe(false);
    expect(manager.owns).toBe(false);
    expect(clock.pendingCount).toBe(1);
  });

  // The "done when" scenario from the plan: two fake owners racing, where
  // the loser's owner later exits, and the loser successfully claims
  // ownership and constructs its daemon on its next retry tick — with no
  // process restart.
  it('claims on a later retry tick once the previous owner exits, with no process restart', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    writeFileSync(lockPath, '4242');
    let ownerAlive = true;
    const clock = new FakeClock();
    let claimedCount = 0;
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      isProcessAlive: (pid) => pid === 4242 && ownerAlive,
      onOwnershipClaimed: () => {
        claimedCount++;
        return () => {};
      },
    });

    manager.start();
    expect(manager.owns).toBe(false);
    expect(claimedCount).toBe(0);

    // Owner PID 4242 exits — its process is no longer alive, but the lock
    // file is still on disk (nothing in this test process ever deletes it).
    ownerAlive = false;

    // A retry tick fires (same 10s cadence, driven here without a real
    // timer) — tryClaimOwnership sees the stale lock, reclaims it, and the
    // manager constructs the daemon in-process, with no restart.
    clock.advance();

    expect(manager.owns).toBe(true);
    expect(claimedCount).toBe(1);
    expect(Number(readFileSync(lockPath, 'utf-8').trim())).toBe(process.pid);
  });

  it('does not retry again, or call onOwnershipClaimed a second time, once claimed', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    const clock = new FakeClock();
    let claimedCount = 0;
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      onOwnershipClaimed: () => {
        claimedCount++;
        return () => {};
      },
    });

    manager.start();
    expect(claimedCount).toBe(1);
    expect(clock.pendingCount).toBe(0);

    clock.advance(); // no-op — nothing pending
    expect(claimedCount).toBe(1);
  });

  it('stop() before ever claiming cancels the pending retry and does not call onOwnershipClaimed', async () => {
    const lockPath = join(workDir, 'callcapture.lock');
    writeFileSync(lockPath, '4242');
    const clock = new FakeClock();
    let claimed = false;
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      isProcessAlive: () => true,
      onOwnershipClaimed: () => {
        claimed = true;
        return () => {};
      },
    });

    manager.start();
    expect(clock.pendingCount).toBe(1);

    await manager.stop();

    expect(clock.pendingCount).toBe(0);
    expect(claimed).toBe(false);
    // A losing manager must never disturb the winner's lock on shutdown.
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe('4242');

    // The cancelled retry must not fire even if something still advances
    // the clock later.
    clock.advance();
    expect(claimed).toBe(false);
  });

  // #4 (code review) — the generic `logger?.info` line on a lost initial
  // claim doesn't say anything about what a caller-specific UI surface loses
  // (e.g. desktop's pill/notification windows never activating at all).
  // `onClaimFailed` lets a caller like that add its own one-time message
  // without spamming on every retry tick.
  it('calls onClaimFailed with the owner pid exactly once, when the initial claim is lost — not again on a later retry loss', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    writeFileSync(lockPath, '4242');
    const clock = new FakeClock();
    const claimFailedCalls: number[] = [];
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      isProcessAlive: () => true,
      onClaimFailed: (ownerPid) => claimFailedCalls.push(ownerPid),
      onOwnershipClaimed: () => () => {},
    });

    manager.start();
    expect(claimFailedCalls).toEqual([4242]);

    // A retry tick that also loses must not call onClaimFailed again — it is
    // a one-time signal, not a per-retry spam source.
    clock.advance();
    expect(claimFailedCalls).toEqual([4242]);
  });

  it('does not call onClaimFailed when the initial claim succeeds', () => {
    const lockPath = join(workDir, 'callcapture.lock');
    const clock = new FakeClock();
    const claimFailedCalls: number[] = [];
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      onClaimFailed: (ownerPid) => claimFailedCalls.push(ownerPid),
      onOwnershipClaimed: () => () => {},
    });

    manager.start();

    expect(claimFailedCalls).toEqual([]);
  });

  it('stop() after claiming calls the onOwnershipClaimed teardown and releases the lock', async () => {
    const lockPath = join(workDir, 'callcapture.lock');
    const clock = new FakeClock();
    let torndown = false;
    const manager = new CallCaptureOwnershipManager({
      lockPath,
      retryIntervalMs: 10_000,
      clock,
      onOwnershipClaimed: () => () => {
        torndown = true;
      },
    });

    manager.start();
    expect(manager.owns).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    await manager.stop();

    expect(torndown).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});
