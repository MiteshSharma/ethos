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
// buildCronTriggers — the three deployment profiles fall out of config with
// no code fork (plan/phases/cron-scheduler-seam.md "Config surface").
// ---------------------------------------------------------------------------

describe('buildCronTriggers', () => {
  it('local/always-on: no cron config at all reproduces today — only the local trigger', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, undefined);

    expect(result.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(result.external).toBeNull();
    expect(result.arming).toBeInstanceOf(NoopArmingBackend);
  });

  it('local/always-on: explicit trigger.local: true, trigger.external: false', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { trigger: { local: true, external: false } });

    expect(result.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(result.external).toBeNull();
  });

  it('hybrid/dev rehearsal: both true — local keeps ticking, external is also live', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { trigger: { local: true, external: true } });

    expect(result.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(result.external).toBeInstanceOf(HttpFireTrigger);
    expect(result.arming).toBeInstanceOf(NoopArmingBackend);
  });

  it('external/scale-to-zero: local off, external on', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { trigger: { local: false, external: true } });

    expect(result.local).toBeNull();
    expect(result.external).toBeInstanceOf(HttpFireTrigger);
  });

  it('arming is always NoopArmingBackend this phase, regardless of arming.backend value', () => {
    const { engine } = makeEngine();
    const result = buildCronTriggers(engine, { arming: { backend: 'firecracker' } });

    expect(result.arming).toBeInstanceOf(NoopArmingBackend);
  });
});
