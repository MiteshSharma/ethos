import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, MicActivityEvent, SpawnedChild, SpawnFn } from '../detector';
import { MicActivityDetector } from '../detector';

// Fake spawned child — a real Readable (so readline works against it
// unmodified) plus the minimal exit/error/kill surface MicActivityDetector
// needs. Mirrors the FakeMeetingClient idiom in
// extensions/tools-meeting/src/__tests__/meet-join.test.ts: inject the
// boundary, test against a fake, never touch a real process or the
// compiled binary.
class FakeChild implements SpawnedChild {
  readonly stdout = new Readable({ read() {} });
  killed = false;
  private readonly exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.push(listener);
  }

  onError(listener: (err: Error) => void): void {
    this.errorHandlers.push(listener);
  }

  kill(): void {
    this.killed = true;
  }

  emitLine(line: unknown): void {
    this.stdout.push(`${JSON.stringify(line)}\n`);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const h of this.exitHandlers) h(code, signal);
  }

  emitProcessError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }
}

/** Fake Clock — pending timers are advanced explicitly, never by real time. */
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

  /** Fire every timer currently pending, as if `ms` had elapsed. */
  advance(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

function setup(debounceMs = 2000) {
  const child = new FakeChild();
  const clock = new FakeClock();
  const spawnFn: SpawnFn = () => child;
  const detector = new MicActivityDetector({
    spawnFn,
    clock,
    debounceMs,
    binaryPath: 'fake-binary',
  });
  const events: MicActivityEvent[] = [];
  detector.start((event) => events.push(event));
  return { child, clock, detector, events };
}

// readline emits 'line' asynchronously after a push — flush microtasks/timers
// so pushed lines are observed before assertions run.
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('MicActivityDetector', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('emits call_started on the first running:true event', async () => {
    const { child, events } = setup();
    child.emitLine({ event: 'initial', running: false, deviceId: 1, at: '2026-01-01T00:00:00Z' });
    await flush();
    child.emitLine({
      event: 'running_changed',
      running: true,
      deviceId: 1,
      at: '2026-01-01T00:00:01Z',
    });
    await flush();

    expect(events).toEqual([{ type: 'call_started', at: expect.any(Number) }]);
  });

  it('debounces call_ended: a brief flicker back to running:true suppresses it', async () => {
    const { child, clock, events } = setup(2000);
    child.emitLine({ event: 'running_changed', running: true, deviceId: 1, at: 't1' });
    await flush();
    child.emitLine({ event: 'running_changed', running: false, deviceId: 1, at: 't2' });
    await flush();
    expect(clock.pendingCount).toBe(1);

    // Flicker recovers before the debounce window elapses.
    child.emitLine({ event: 'running_changed', running: true, deviceId: 1, at: 't3' });
    await flush();

    expect(clock.pendingCount).toBe(0);
    expect(events).toEqual([{ type: 'call_started', at: expect.any(Number) }]);
  });

  it('emits call_ended once the debounce window elapses with no further running:true', async () => {
    const { child, clock, events } = setup(2000);
    child.emitLine({ event: 'running_changed', running: true, deviceId: 1, at: 't1' });
    await flush();
    child.emitLine({ event: 'running_changed', running: false, deviceId: 1, at: 't2' });
    await flush();

    clock.advance();

    expect(events).toEqual([
      { type: 'call_started', at: expect.any(Number) },
      { type: 'call_ended', at: expect.any(Number) },
    ]);
  });

  it('surfaces a typed error event when the child process emits an error line', async () => {
    const { child, events } = setup();
    child.emitLine({ event: 'error', message: 'failed to attach listener' });
    await flush();

    expect(events).toEqual([{ type: 'error', message: 'failed to attach listener' }]);
  });

  it('surfaces a typed error event when the child process exits unexpectedly', () => {
    const { child, events } = setup();
    child.emitExit(1, null);

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('exited unexpectedly') },
    ]);
  });

  it('surfaces a typed error event when the child process reports a spawn/runtime error', () => {
    const { child, events } = setup();
    child.emitProcessError(new Error('ENOENT'));

    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('ENOENT') }]);
  });

  it('stop() kills the child process and no further events fire', async () => {
    const { child, detector, events } = setup();
    detector.stop();
    expect(child.killed).toBe(true);

    child.emitLine({ event: 'running_changed', running: true, deviceId: 1, at: 't1' });
    await flush();

    expect(events).toEqual([]);
  });

  it('throws a clear error on non-darwin process.platform', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const detector = new MicActivityDetector({ spawnFn: () => new FakeChild() });

    expect(() => detector.start(() => {})).toThrow(/macOS/);
  });
});
