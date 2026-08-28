import type { Logger, PauseOffset } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { type BootReconciliationDeps, runBootReconciliation } from '../boot-reconciliation';

function makeLogger(): Logger & { warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  const logger: Logger & { warns: string[]; infos: string[] } = {
    warns,
    infos,
    debug: () => {},
    info: (m: string) => {
      infos.push(m);
    },
    warn: (m: string) => {
      warns.push(m);
    },
    error: () => {},
    child: () => logger,
  };
  return logger;
}

/** Full deps, every method recording into a shared call-order array. */
function makeDeps(order: string[]) {
  const record = (name: string) => async () => {
    order.push(name);
  };
  const bridge = {
    hydrate: vi.fn(record('hydrate')),
    sweep: vi.fn(record('sweep')),
  };
  const deps = {
    pauseLifecycle: {
      readPauseOffset: vi.fn(async (): Promise<PauseOffset | null> => {
        order.push('readPauseOffset');
        return null;
      }),
      signalReadyToSuspend: vi.fn(async () => {}),
    },
    clarifyBridges: [bridge],
    a2aTaskStore: { failNonTerminal: vi.fn(record('failNonTerminal')) },
    gateway: {
      sweepPendingDeliveries: vi.fn(record('sweepPendingDeliveries')),
      sweepUndeliveredJobs: vi.fn(record('sweepUndeliveredJobs')),
    },
    backgroundExecutor: { bootSweep: vi.fn(record('bootSweep')) },
    cronEngine: { fire: vi.fn(record('fire')) },
  } satisfies BootReconciliationDeps;
  return { deps, bridge };
}

const EXPECTED_ORDER = [
  'readPauseOffset',
  'hydrate',
  'sweep',
  'failNonTerminal',
  'sweepPendingDeliveries',
  'sweepUndeliveredJobs',
  'bootSweep',
  'fire',
];

describe('runBootReconciliation', () => {
  it('calls every supplied dependency exactly once, in the documented order', async () => {
    const order: string[] = [];
    const { deps, bridge } = makeDeps(order);

    const result = await runBootReconciliation(deps);

    expect(order).toEqual(EXPECTED_ORDER);
    expect(deps.pauseLifecycle.readPauseOffset).toHaveBeenCalledTimes(1);
    expect(bridge.hydrate).toHaveBeenCalledTimes(1);
    expect(bridge.sweep).toHaveBeenCalledTimes(1);
    expect(deps.a2aTaskStore.failNonTerminal).toHaveBeenCalledTimes(1);
    expect(deps.gateway.sweepPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(deps.gateway.sweepUndeliveredJobs).toHaveBeenCalledTimes(1);
    expect(deps.backgroundExecutor.bootSweep).toHaveBeenCalledTimes(1);
    expect(deps.cronEngine.fire).toHaveBeenCalledTimes(1);
    expect(result.steps).toEqual({
      pause_offset: 'ok',
      clarify_hydrate: 'ok',
      clarify_sweep: 'ok',
      a2a_fail_non_terminal: 'ok',
      sweep_pending_deliveries: 'ok',
      sweep_undelivered_jobs: 'ok',
      background_boot_sweep: 'ok',
      cron_fire: 'ok',
    });
  });

  it('passes a reason to failNonTerminal', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    await runBootReconciliation(deps);
    expect(deps.a2aTaskStore.failNonTerminal).toHaveBeenCalledWith('boot reconciliation');
  });

  it('is re-invocable: a second call against the same deps runs every step again', async () => {
    const order: string[] = [];
    const { deps, bridge } = makeDeps(order);

    await runBootReconciliation(deps);
    const second = await runBootReconciliation(deps);

    // Spies deliberately NOT reset between calls — this is the resume path.
    expect(order).toEqual([...EXPECTED_ORDER, ...EXPECTED_ORDER]);
    expect(bridge.hydrate).toHaveBeenCalledTimes(2);
    expect(deps.cronEngine.fire).toHaveBeenCalledTimes(2);
    expect(deps.gateway.sweepPendingDeliveries).toHaveBeenCalledTimes(2);
    expect(Object.values(second.steps).every((s) => s === 'ok')).toBe(true);
  });

  it('fails open: a rejecting hydrate does not stop or reject the rest', async () => {
    const order: string[] = [];
    const { deps, bridge } = makeDeps(order);
    bridge.hydrate.mockRejectedValueOnce(new Error('clarify store unreachable'));
    const logger = makeLogger();

    const result = await runBootReconciliation({ ...deps, logger });

    expect(result.steps.clarify_hydrate).toBe('failed');
    expect(order).toEqual(EXPECTED_ORDER.filter((n) => n !== 'hydrate'));
    expect(result.steps).toEqual({
      pause_offset: 'ok',
      clarify_hydrate: 'failed',
      clarify_sweep: 'ok',
      a2a_fail_non_terminal: 'ok',
      sweep_pending_deliveries: 'ok',
      sweep_undelivered_jobs: 'ok',
      background_boot_sweep: 'ok',
      cron_fire: 'ok',
    });
    expect(logger.warns.some((m) => m.includes('clarify_hydrate'))).toBe(true);
  });

  it('marks missing dependencies skipped (the serve profile: no gateway, no A2A store)', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);

    const result = await runBootReconciliation({
      pauseLifecycle: deps.pauseLifecycle,
      clarifyBridges: deps.clarifyBridges,
      backgroundExecutor: deps.backgroundExecutor,
      cronEngine: deps.cronEngine,
    });

    expect(result.steps.sweep_pending_deliveries).toBe('skipped');
    expect(result.steps.sweep_undelivered_jobs).toBe('skipped');
    expect(result.steps.a2a_fail_non_terminal).toBe('skipped');
    expect(order).toEqual(['readPauseOffset', 'hydrate', 'sweep', 'bootSweep', 'fire']);
  });

  it('skips every step when no dependency at all is supplied', async () => {
    const result = await runBootReconciliation({});
    expect(result.pauseOffset).toBeNull();
    expect(Object.values(result.steps).every((s) => s === 'skipped')).toBe(true);
  });

  it('returns and logs a non-null pause offset', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    deps.pauseLifecycle.readPauseOffset.mockResolvedValueOnce({ pauseDurationMs: 42_000 });
    const logger = makeLogger();

    const result = await runBootReconciliation({ ...deps, logger });

    expect(result.pauseOffset).toEqual({ pauseDurationMs: 42_000 });
    expect(logger.infos.some((m) => m.includes('resumed from pause'))).toBe(true);
    expect(logger.warns).toEqual([]);
  });

  it('treats a null pause offset as the normal cold boot: nothing unusual logged', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    const logger = makeLogger();

    const result = await runBootReconciliation({ ...deps, logger });

    expect(result.pauseOffset).toBeNull();
    expect(result.steps.pause_offset).toBe('ok');
    expect(logger.infos).toEqual([]);
    expect(logger.warns).toEqual([]);
  });

  it('runs the rest of reconciliation when readPauseOffset rejects', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    deps.pauseLifecycle.readPauseOffset.mockRejectedValueOnce(new Error('vsock closed'));
    const logger = makeLogger();

    const result = await runBootReconciliation({ ...deps, logger });

    expect(result.steps.pause_offset).toBe('failed');
    expect(result.pauseOffset).toBeNull();
    expect(order).toEqual(EXPECTED_ORDER.filter((n) => n !== 'readPauseOffset'));
    expect(logger.warns.some((m) => m.includes('pause_offset'))).toBe(true);
  });

  it('marks clarify_sweep skipped when no bridge implements sweep', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    const result = await runBootReconciliation({
      ...deps,
      clarifyBridges: [
        {
          hydrate: async () => {
            order.push('hydrate');
          },
        },
      ],
    });
    expect(result.steps.clarify_hydrate).toBe('ok');
    expect(result.steps.clarify_sweep).toBe('skipped');
  });

  it('settles clarify bridges independently: one rejecting bridge does not mask the others', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    const logger = makeLogger();
    const ran: string[] = [];
    const bridge = (name: string, fail = false) => ({
      hydrate: async () => {
        ran.push(name);
        if (fail) throw new Error(`${name} unreachable`);
      },
    });

    const result = await runBootReconciliation({
      ...deps,
      logger,
      clarifyBridges: [bridge('first'), bridge('middle', true), bridge('last')],
    });

    // Under `Promise.all` the middle rejection would have been the only thing
    // anyone saw. All three must run, the step must report failed, and the log
    // must name WHICH bridge failed.
    expect(ran).toEqual(['first', 'middle', 'last']);
    expect(result.steps.clarify_hydrate).toBe('failed');
    expect(logger.warns.filter((m) => m.includes('clarify_hydrate'))).toEqual([
      '[boot-reconciliation] step "clarify_hydrate" failed for bridge 1',
    ]);
  });
});
