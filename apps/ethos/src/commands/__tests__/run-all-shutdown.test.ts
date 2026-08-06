import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler, type ShutdownChild } from '../run-all';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for a spawned child. Mirrors the two Node behaviours that
 * matter here: `killed` flips as soon as a signal is *delivered* (not when the
 * child dies), and `exit` fires asynchronously.
 */
class FakeChild extends EventEmitter {
  readonly pid: number | undefined;
  killed = false;
  readonly signals: NodeJS.Signals[] = [];
  private readonly ignoreTerm: boolean;

  constructor(opts: { pid?: number | undefined; ignoreTerm?: boolean } = {}) {
    super();
    this.pid = 'pid' in opts ? opts.pid : 1234;
    this.ignoreTerm = opts.ignoreTerm ?? false;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (signal === 'SIGKILL' || !this.ignoreTerm) {
      setImmediate(() => this.emit('exit'));
    }
    return true;
  }
}

function supervised(child: FakeChild | null): ShutdownChild {
  return { shuttingDown: false, stableTimer: null, rotationTimer: null, process: child };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// createShutdownHandler
// ---------------------------------------------------------------------------

describe('run-all — shutdown', () => {
  it('exits 0 as soon as the last child is gone, without waiting out the grace period', async () => {
    // The regression: on a healthy shutdown every child dies in milliseconds and
    // nothing is left holding the event loop open. If the only path to
    // `exit(0)` is the grace timer, Node drains and picks its own exit code
    // (13, on the bundle's unsettled top-level await) instead.
    const exit = vi.fn();
    const gateway = new FakeChild({ pid: 11 });
    const serve = new FakeChild({ pid: 12 });
    const shutdown = createShutdownHandler({
      children: [supervised(gateway), supervised(serve)],
      log: () => {},
      exit,
      graceMs: 5_000,
    });

    shutdown('SIGTERM');
    expect(exit).not.toHaveBeenCalled();

    await tick(20);

    expect(gateway.signals).toEqual(['SIGTERM']);
    expect(serve.signals).toEqual(['SIGTERM']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('holds the event loop open with a ref’d grace timer', async () => {
    // The other half of the same defect: an unref’d grace timer cannot keep
    // the process alive long enough to reach its own `exit(0)`.
    const exit = vi.fn();
    const stuck = new FakeChild({ pid: 21, ignoreTerm: true });
    const created: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const timer = realSetTimeout(fn, ms);
      created.push(timer);
      return timer;
    }) as unknown as typeof globalThis.setTimeout);

    const shutdown = createShutdownHandler({
      children: [supervised(stuck)],
      log: () => {},
      exit,
      graceMs: 30_000,
    });
    shutdown('SIGTERM');
    spy.mockRestore();

    expect(created).toHaveLength(1);
    expect(created[0]?.hasRef()).toBe(true);

    // Don't leave a 30s ref'd timer pinning the vitest worker.
    if (created[0]) clearTimeout(created[0]);
    await tick(5);
  });

  it('SIGKILLs a hanging child at the grace deadline and still exits 0', async () => {
    const exit = vi.fn();
    const stuck = new FakeChild({ pid: 31, ignoreTerm: true });
    const shutdown = createShutdownHandler({
      children: [supervised(stuck)],
      log: () => {},
      exit,
      graceMs: 30,
    });

    shutdown('SIGTERM');
    await tick(5);
    expect(stuck.signals).toEqual(['SIGTERM']);
    expect(exit).not.toHaveBeenCalled();

    await tick(60);
    expect(stuck.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);

    // The SIGKILLed child's own `exit` lands after the sweep — it must not
    // trigger a second exit.
    await tick(20);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 0 immediately when there are no children', () => {
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ children: [], log: () => {}, exit, graceMs: 5_000 });

    shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 0 immediately when every child is already dead', () => {
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      children: [supervised(null), supervised(null)],
      log: () => {},
      exit,
      graceMs: 5_000,
    });

    shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('waits only on live children when a sibling is already dead', async () => {
    const exit = vi.fn();
    const live = new FakeChild({ pid: 41 });
    const shutdown = createShutdownHandler({
      children: [supervised(null), supervised(live)],
      log: () => {},
      exit,
      graceMs: 5_000,
    });

    shutdown('SIGTERM');
    expect(exit).not.toHaveBeenCalled();

    await tick(20);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not signal a child that never got a pid, and still exits at the deadline', async () => {
    const exit = vi.fn();
    const neverSpawned = new FakeChild({ pid: undefined });
    const shutdown = createShutdownHandler({
      children: [supervised(neverSpawned)],
      log: () => {},
      exit,
      graceMs: 30,
    });

    shutdown('SIGTERM');
    await tick(60);

    expect(neverSpawned.signals).toEqual(['SIGKILL']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second signal neither re-signals children nor double-exits', async () => {
    const exit = vi.fn();
    const beforeStop = vi.fn();
    const child = new FakeChild({ pid: 51 });
    const shutdown = createShutdownHandler({
      children: [supervised(child)],
      log: () => {},
      beforeStop,
      exit,
      graceMs: 5_000,
    });

    shutdown('SIGTERM');
    shutdown('SIGTERM');
    shutdown('SIGINT');

    expect(child.signals).toEqual(['SIGTERM']);
    expect(beforeStop).toHaveBeenCalledTimes(1);

    await tick(20);
    shutdown('SIGTERM'); // post-exit signal, too

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('marks children shutting down and clears their stable/rotation timers', async () => {
    const exit = vi.fn();
    const onStable = vi.fn();
    const onRotate = vi.fn();
    const sc: ShutdownChild = {
      shuttingDown: false,
      // Arrow-wrapped: passing the mock directly picks an overload that
      // returns `number`, not NodeJS.Timeout.
      stableTimer: setTimeout(() => onStable(), 20),
      rotationTimer: setInterval(() => onRotate(), 20),
      process: new FakeChild({ pid: 61 }),
    };
    const shutdown = createShutdownHandler({
      children: [sc],
      log: () => {},
      exit,
      graceMs: 5_000,
    });

    shutdown('SIGTERM');

    // The exit handler in startChild keys off this to skip the restart.
    expect(sc.shuttingDown).toBe(true);

    await tick(60);
    expect(onStable).not.toHaveBeenCalled();
    expect(onRotate).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
