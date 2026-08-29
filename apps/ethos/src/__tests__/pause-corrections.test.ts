// plan/phases/clock-tolerance-pass.md §3/§4 — the resume-boundary correction
// fanout, and the registration of it in all three long-running commands.
//
// WHY THE REGISTRATION IS ASSERTED AT ALL, and asserted per command. Every
// store-level bump (`bumpRunningHeartbeats`, `bumpActiveHeartbeats`,
// `applyPauseOffset`) already has its own unit test in its own package, and all
// of them passed while NOTHING invoked them on a real resume: the only reader of
// `readPauseOffset()` is boot reconciliation, which runs once at startup, and a
// snapshot-restored guest continues the same process image so that read has
// long since happened. Green store tests are therefore not evidence the gate is
// protected — the wiring is the part that was missing, so the wiring is what
// these assert.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPauseCorrections,
  buildPauseCorrectionTargets,
  hasHeartbeatBump,
} from '../pause-corrections';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');
const HOUR_MS = 3_600_000;

describe('buildPauseCorrectionTargets', () => {
  it('resolves only the targets the caller actually supplied', () => {
    const targets = buildPauseCorrectionTargets(
      { jobStore: { bumpRunningHeartbeats: async () => 0 } },
      HOUR_MS,
    );

    expect(targets.map((t) => t.label)).toEqual(['jobStore']);
  });

  it('is a no-op for a caller holding nothing', () => {
    expect(buildPauseCorrectionTargets({}, HOUR_MS)).toEqual([]);
  });

  it('skips a Gateway that predates the correction entry point', () => {
    // `applyPauseOffset` is optional on the gateway shape, so an older Gateway
    // is still a valid reconciliation target — it just has nothing to correct.
    expect(buildPauseCorrectionTargets({ gateway: {} }, HOUR_MS)).toEqual([]);
  });

  it('keeps `this` bound when the gateway method is invoked from the closure', async () => {
    class FakeGateway {
      offset = 0;
      applyPauseOffset(ms: number): void {
        this.offset += ms;
      }
    }
    const gateway = new FakeGateway();

    const [target] = buildPauseCorrectionTargets({ gateway }, HOUR_MS);
    await target.run();

    expect(gateway.offset).toBe(HOUR_MS);
  });
});

describe('applyPauseCorrections', () => {
  it('hands the same duration to every supplied gate', async () => {
    const jobStore = { bumpRunningHeartbeats: vi.fn(async () => 3) };
    const kanbanStore = { bumpActiveHeartbeats: vi.fn(() => 2) };
    const pendingMemoryStore = { applyPauseOffset: vi.fn() };
    const dreamExecutor = { applyPauseOffset: vi.fn() };
    const gateway = { applyPauseOffset: vi.fn() };

    const applied = await applyPauseCorrections(
      { jobStore, kanbanStore, pendingMemoryStore, dreamExecutor, gateway },
      6 * HOUR_MS,
    );

    expect(applied).toEqual([
      'jobStore',
      'kanbanStore',
      'pendingMemoryStore',
      'dreamExecutor',
      'gateway',
    ]);
    for (const fn of [
      jobStore.bumpRunningHeartbeats,
      kanbanStore.bumpActiveHeartbeats,
      pendingMemoryStore.applyPauseOffset,
      dreamExecutor.applyPauseOffset,
      gateway.applyPauseOffset,
    ]) {
      expect(fn).toHaveBeenCalledWith(6 * HOUR_MS);
    }
  });

  it('FAILS OPEN per target — one throwing store does not deny the others', async () => {
    const kanbanStore = { bumpActiveHeartbeats: vi.fn(() => 1) };

    const applied = await applyPauseCorrections(
      {
        jobStore: {
          bumpRunningHeartbeats: async () => {
            throw new Error('database is locked');
          },
        },
        kanbanStore,
      },
      HOUR_MS,
    );

    expect(applied).toEqual(['kanbanStore']);
    expect(kanbanStore.bumpActiveHeartbeats).toHaveBeenCalledWith(HOUR_MS);
  });

  it('never rejects — it runs inside an onResume handler with no catch above it', async () => {
    await expect(
      applyPauseCorrections(
        {
          gateway: {
            applyPauseOffset: () => {
              throw new Error('boom');
            },
          },
        },
        HOUR_MS,
      ),
    ).resolves.toEqual([]);
  });
});

describe('hasHeartbeatBump', () => {
  it('accepts the concrete store and rejects the narrow contract', () => {
    expect(hasHeartbeatBump({ bumpRunningHeartbeats: async () => 0 })).toBe(true);
    expect(hasHeartbeatBump({ enqueue: () => {} })).toBe(false);
    expect(hasHeartbeatBump(undefined)).toBe(false);
    expect(hasHeartbeatBump(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registration, per command. Source-text for the same reason
// `boot-profile-command.test.ts` is: these live inside functions that boot an
// entire process and cannot be invoked from a unit test.
// ---------------------------------------------------------------------------

describe('every long-running command registers the mid-run resume handler', () => {
  for (const file of [
    'apps/ethos/src/commands/boot.ts',
    'apps/ethos/src/commands/gateway.ts',
    'apps/ethos/src/commands/serve.ts',
  ]) {
    it(`${file} subscribes to onResume`, async () => {
      const src = await read(file);
      // Optional-called: `NoopPauseLifecycle` has no `onResume`, so a deployment
      // that never enabled `pauseClockCorrection` must not crash on boot.
      expect(src).toMatch(/pauseLifecycle\.onResume\?\.\(|onPauseResume\?\.\(/);
    });
  }

  it('gateway.ts corrects the two gates only it owns', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    const call = src.slice(src.indexOf('void applyPauseCorrections('));
    // The DreamExecutor is constructed nowhere else in the codebase, and the
    // Gateway holds the delivery-ledger abandon window.
    expect(call).toContain('dreamExecutor');
    expect(call).toContain('gateway');
  });

  it('gateway.ts bumps ONE job store, not one per bot', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    // Every createAgentLoop opens its own SQLiteJobStore against the SAME
    // jobs.db, so bumping per bot would advance heartbeat_at by N × the pause.
    expect(src).toContain('const correctableJobStore = bots.find((b) => b.jobStore !== undefined)');
    expect(src).not.toMatch(/bots\.map\([^)]*\)\s*\.forEach[\s\S]{0,120}bumpRunningHeartbeats/);
  });

  it('serve.ts corrects the kanban board, the highest-stakes gate in the pass', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    const call = src.slice(src.indexOf('void applyPauseCorrections('));
    expect(call).toContain('bumpKanbanHeartbeats(boardPath');
  });

  it('boot.ts re-arms the idle watcher on the mid-run resume, not only at boot', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    // Without this the watcher latches after its one handoff and a
    // snapshot-restored process suspends exactly once, ever.
    const handler = src.slice(src.indexOf('onPauseResume?.((pauseDurationMs)'));
    expect(handler).toContain('watcher.start();');
  });
});
