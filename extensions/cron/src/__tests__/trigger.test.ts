import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronArmingBackend, CronEngine } from '../index';
import {
  buildCronTriggers,
  HttpFireTrigger,
  LocalIntervalTrigger,
  NoopArmingBackend,
} from '../trigger';

function makeEngine(): { engine: CronEngine; fire: ReturnType<typeof vi.fn> } {
  const fire = vi.fn(async () => {});
  return { engine: { fire }, fire };
}

describe('LocalIntervalTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately on start(), then again every intervalMs', async () => {
    const { engine, fire } = makeEngine();
    const trigger = new LocalIntervalTrigger(engine, 1_000);

    trigger.start();
    expect(fire).toHaveBeenCalledTimes(1); // immediate check-on-start

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fire).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fire).toHaveBeenCalledTimes(3);

    trigger.stop();
  });

  it('stop() clears the interval — no further fires', async () => {
    const { engine, fire } = makeEngine();
    const trigger = new LocalIntervalTrigger(engine, 1_000);

    trigger.start();
    expect(fire).toHaveBeenCalledTimes(1);
    trigger.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fire).toHaveBeenCalledTimes(1); // no more fires after stop
  });

  it('unref()s its interval so a pending tick never keeps the process alive', () => {
    const { engine } = makeEngine();
    const trigger = new LocalIntervalTrigger(engine, 1_000);

    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      // biome-ignore lint/suspicious/noExplicitAny: stubbing the return handle's unref for the assertion
      .mockImplementation(((..._args: unknown[]) => ({ unref, ref: () => {} }) as any) as any);

    trigger.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });

  it('fire() delegates straight to the engine (callable independent of start/stop)', async () => {
    const { engine, fire } = makeEngine();
    const trigger = new LocalIntervalTrigger(engine, 60_000);

    await trigger.fire();
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

describe('HttpFireTrigger', () => {
  it('fire() calls straight into the engine — no internal loop', async () => {
    const { engine, fire } = makeEngine();
    const trigger = new HttpFireTrigger(engine);

    await trigger.fire();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('start()/stop() are no-ops', () => {
    const { engine, fire } = makeEngine();
    const trigger = new HttpFireTrigger(engine);

    expect(() => trigger.start()).not.toThrow();
    expect(() => trigger.stop()).not.toThrow();
    expect(fire).not.toHaveBeenCalled();
  });
});

describe('NoopArmingBackend', () => {
  it('arms nothing and never throws', () => {
    const backend: CronArmingBackend = new NoopArmingBackend();
    expect(() => backend.arm(new Date())).not.toThrow();
    expect(() => backend.arm(null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildCronTriggers — the mode falls out of one presence-gated config field,
// `cron.fireUrl` (plan/phases/cron-fire-url-collapse.md).
// ---------------------------------------------------------------------------

const FIRE_URL = 'https://agent.example.com/cron/fire';

describe('buildCronTriggers', () => {
  it('local mode: no cron config at all reproduces today — local trigger, no notices', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, undefined);

    expect(result.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(result.external).toBeInstanceOf(HttpFireTrigger);
    expect(result.arming).toBeInstanceOf(NoopArmingBackend);
    expect(result.notices).toEqual([]);
  });

  it('local mode: an empty cron section with an HTTP surface still ticks locally', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, {}, { hasHttpSurface: true });

    expect(result.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(result.notices).toEqual([]);
  });

  it('external mode: fireUrl on a process with an HTTP surface drops the local interval', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: true });

    expect(result.local).toBeNull();
    expect(result.external).toBeInstanceOf(HttpFireTrigger);
  });

  it('external mode emits a notice naming the URL, so a remote deployment is diagnosable', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: true });

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain(FIRE_URL);
    expect(result.notices[0]).toContain('POST /cron/fire');
  });

  // The D1 guard. A process that cannot be fired over HTTP must keep ticking
  // regardless of fireUrl — otherwise every scheduled job silently stops.
  it('forces the local interval when the process has no HTTP surface, and says so', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: false });

    expect(result.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain(FIRE_URL);
    expect(result.notices[0]).toContain('ignored');
  });

  // Pins the fail-safe default: a call site that forgets the option gets a
  // redundant tick (safe — `claimDueJob` is a compare-and-swap), never silence.
  it('defaults hasHttpSurface to false when options are omitted entirely', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { fireUrl: FIRE_URL });

    expect(result.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain(FIRE_URL);
    expect(result.notices[0]).toContain('ignored');
  });

  // The D2 guard: config no longer gates POST /cron/fire.
  it('always constructs the external HttpFireTrigger, in every mode', () => {
    const { engine } = makeEngine();

    for (const result of [
      buildCronTriggers(engine, undefined),
      buildCronTriggers(engine, {}, { hasHttpSurface: true }),
      buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: true }),
      buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: false }),
    ]) {
      expect(result.external).toBeInstanceOf(HttpFireTrigger);
    }
  });

  it('arming is always NoopArmingBackend, in every mode', () => {
    const { engine } = makeEngine();

    for (const result of [
      buildCronTriggers(engine, undefined),
      buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: true }),
      buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: false }),
    ]) {
      expect(result.arming).toBeInstanceOf(NoopArmingBackend);
    }
  });

  it('honours localIntervalMs from the options object', async () => {
    vi.useFakeTimers();
    try {
      const { engine, fire } = makeEngine();
      const result = buildCronTriggers(engine, undefined, { localIntervalMs: 1_000 });

      result.local?.start();
      expect(fire).toHaveBeenCalledTimes(1); // immediate check-on-start

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fire).toHaveBeenCalledTimes(2);

      result.local?.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
