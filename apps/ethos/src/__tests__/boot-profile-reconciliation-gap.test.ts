// plan/phases/single-process-boot-profile.md §9.4 — THE gap-closing test.
//
// This is the one that proves the plan's premise. `ethos serve` has ZERO call
// sites for `sweepPendingDeliveries()` and `sweepUndeliveredJobs()` (plan §1's
// table), so on a wake where only `serve` runs, a reply that was never
// confirmed to a platform stays `pending` forever and nothing repairs it. The
// merged `boot` profile's step 9 — `runBootReconciliation()` — is what closes
// that. Here we seed exactly the two artifacts the sweeps exist to repair, run
// the composition against them, and assert both are repaired.
//
// §9.8 rides along in the last case: the SAME already-constructed object graph
// is reconciled a SECOND time (no fresh process, no reconstruction), which is
// the property a future snapshot-resume handler depends on.
//
// `@ethosagent/job-store` / `@ethosagent/job-runner` are not dependencies of
// `@ethosagent/cli` and have no vitest alias, so they are imported by path —
// the same wall `commands/serve.ts`'s `@ethosagent/acp-server` import hits,
// resolved here by reaching the source directly rather than by asserting on
// text.

import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { Gateway } from '@ethosagent/gateway';
import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor } from '../../../../extensions/job-runner/src/index';
import { SQLiteJobStore } from '../../../../extensions/job-store/src/index';
import { runBootReconciliation } from '../boot-reconciliation';

function stubAdapter() {
  const sent: Array<{ chatId: string; message: OutboundMessage }> = [];
  let nextId = 1;
  const adapter = {
    id: 'telegram:test',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, message: OutboundMessage): Promise<DeliveryResult> => {
      sent.push({ chatId, message });
      return { ok: true, messageId: String(nextId++) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { sent });
}

const idleLoop = {
  run: vi.fn(async function* () {
    /* nothing to yield — reconciliation never runs a turn */
  }),
  hooks: new DefaultHookRegistry(),
} as unknown as AgentLoop;

/**
 * The object graph a `boot` process holds at §3b step 9: a live Gateway over a
 * started adapter and a real delivery ledger, and the ONE shared
 * `BackgroundExecutor` over the ONE shared job store.
 */
async function seedBootState() {
  const ledger = new SQLiteDeliveryLedger(':memory:');
  const adapter = stubAdapter();
  const jobStore = new SQLiteJobStore(':memory:');

  // Artifact 1 — a reply this process's predecessor recorded as an obligation
  // and never confirmed to the platform.
  await ledger.record({
    botKey: 'bot-a',
    platform: 'telegram',
    chatId: 'chat-1',
    sessionId: 'telegram:bot-a:chat-1',
    content: 'the reply nobody ever received',
  });

  // Artifact 2 — a background job left `running` by a process that died. It
  // has a heartbeat and no beating executor, which is exactly what
  // `reclaimStale` selects on.
  const created = await jobStore.create({
    owner: 'dead-process',
    parentSessionKey: 'telegram:bot-a:chat-1',
    rootSessionKey: 'telegram:bot-a:chat-1',
    childSessionKey: 'job:1',
    depth: 0,
    prompt: 'work that never finished',
  });
  const claimed = await jobStore.claimNextQueued('dead-process');
  expect(claimed?.id).toBe(created.id);
  expect((await jobStore.get(created.id))?.status).toBe('running');

  const gateway = new Gateway({
    bots: [{ botKey: 'bot-a', loop: idleLoop, binding: { type: 'personality', name: 'default' } }],
    deliveryLedger: ledger,
    adapters: new Map([['telegram', adapter]]),
    clarifySweepIntervalMs: 0,
    streamingEditIntervalMs: 0,
  });

  const backgroundExecutor = new BackgroundExecutor({
    store: jobStore,
    loop: idleLoop,
    owner: 'boot-process',
    config: {
      // 0 keeps the pool shut so `bootSweep()`'s claim loop cannot start a real
      // run — the sweep half is what is under test, not the executor's runner.
      maxConcurrentJobs: 0,
      // A row whose heartbeat is any age at all is stale. The dead process's
      // row qualifies immediately, without waiting out a real 90s window.
      staleMs: 0,
      heartbeatMs: 10_000,
      queuedTtlMs: 3_600_000,
      maxRootBackgroundUsd: null,
    },
  });

  return { ledger, adapter, jobStore, gateway, backgroundExecutor, jobId: created.id };
}

describe('boot profile — §9.4 the reconciliation gap `ethos serve` alone leaves open', () => {
  it('repairs both a pending delivery obligation and a stale running job in one pass', async () => {
    const { ledger, adapter, jobStore, gateway, backgroundExecutor, jobId } = await seedBootState();

    // Before: exactly the damaged state a previous abnormal exit leaves behind.
    expect(await ledger.listPending(['bot-a'])).toHaveLength(1);
    expect((await jobStore.get(jobId))?.status).toBe('running');
    expect(adapter.sent).toHaveLength(0);

    const failNonTerminal = vi.fn().mockResolvedValue(0);
    const result = await runBootReconciliation({
      gateway,
      backgroundExecutor,
      // The serve-role step, in the SAME composition as the gateway-role
      // sweeps — the merge is the point. `ethos gateway start` never calls it.
      a2aTaskStore: { failNonTerminal },
      cronEngine: { fire: vi.fn() },
    });

    // After: the delivery was redelivered through the live adapter and the
    // obligation is closed. This is the repair `ethos serve` silently skips.
    expect(adapter.sent.map((s) => s.message.text)).toEqual(['the reply nobody ever received']);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);

    // And the orphaned run is reclaimed rather than sitting `running` forever.
    expect((await jobStore.get(jobId))?.status).toBe('stale');

    // The serve-role step ran too, in the same pass.
    expect(failNonTerminal).toHaveBeenCalledTimes(1);

    expect(result.steps.sweep_pending_deliveries).toBe('ok');
    expect(result.steps.sweep_undelivered_jobs).toBe('ok');
    expect(result.steps.background_boot_sweep).toBe('ok');
    expect(result.steps.a2a_fail_non_terminal).toBe('ok');
  });

  // §9.8 — the simulated resume. No new process, no reconstruction: the same
  // graph is reconciled again, which is what a snapshot-resume handler will do.
  it('is safe to run a second time against the same already-constructed graph', async () => {
    const { ledger, adapter, jobStore, gateway, backgroundExecutor, jobId } = await seedBootState();

    const first = await runBootReconciliation({ gateway, backgroundExecutor });
    expect(adapter.sent).toHaveLength(1);

    const second = await runBootReconciliation({ gateway, backgroundExecutor });

    // Every step ran again (not skipped) and none of them failed…
    expect(second.steps.sweep_pending_deliveries).toBe('ok');
    expect(second.steps.sweep_undelivered_jobs).toBe('ok');
    expect(second.steps.background_boot_sweep).toBe('ok');
    expect(second.steps).toEqual(first.steps);

    // …and a clean store gives them nothing to do: no duplicate send, no row
    // resurrected, no obligation re-opened.
    expect(adapter.sent).toHaveLength(1);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
    expect((await jobStore.get(jobId))?.status).toBe('stale');
  });

  // The prerequisite the composition depends on: `BackgroundExecutor.bootSweep`
  // had to stop being `private`, or a real executor would not be structurally
  // assignable to `BootReconciliationDeps['backgroundExecutor']`. The two cases
  // above pass a REAL executor, so type-checking already proves it — this
  // states the contract explicitly so a future `private` fails loudly here too.
  it('exposes BackgroundExecutor.bootSweep as a callable public method', async () => {
    const { backgroundExecutor } = await seedBootState();
    expect(typeof backgroundExecutor.bootSweep).toBe('function');
    await expect(backgroundExecutor.bootSweep()).resolves.toBeUndefined();
  });
});
