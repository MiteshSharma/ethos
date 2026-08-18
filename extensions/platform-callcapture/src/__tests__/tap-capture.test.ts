import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudioSpawnFn, Clock, SpawnedAudioChild } from '../audio-process';
import { TapCapture } from '../tap-capture';

// Minimal fake — only what TapCapture's own wiring (args, isReadyLine,
// isErrorLine field-parsing) needs exercised. Deep readiness/timeout/
// heartbeat mechanics already have thorough coverage in
// audio-process.test.ts; duplicating that here would just be the same
// assertions against a thinner wrapper.
class FakeAudioChild implements SpawnedAudioChild {
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  killed = false;
  onExit(): void {}
  onError(): void {}
  kill(): void {
    this.killed = true;
  }
  emitStderrLine(fields: unknown): void {
    this.stderr.push(`${JSON.stringify(fields)}\n`);
  }
}

class FakeClock implements Clock {
  private nextId = 1;
  private readonly pending = new Map<number, () => void>();
  setTimeout(fn: () => void): number {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fireAll(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }
}

describe('TapCapture', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('invokes audiotee with --sample-rate and resolves chunks once metadata arrives', async () => {
    const child = new FakeAudioChild();
    const seenArgs: string[][] = [];
    const spawnFn: AudioSpawnFn = (_path, args) => {
      seenArgs.push(args);
      return child;
    };
    const tap = new TapCapture({ spawnFn, clock: new FakeClock() });

    const startPromise = tap.start();
    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    await startPromise;

    expect(seenArgs).toEqual([['--sample-rate', '16000']]);
  });

  it('rejects with the audiotee error message on an error line', async () => {
    const child = new FakeAudioChild();
    const spawnFn: AudioSpawnFn = () => child;
    const tap = new TapCapture({ spawnFn, clock: new FakeClock() });

    const startPromise = tap.start();
    child.emitStderrLine({
      message_type: 'error',
      data: { message: 'process tap creation failed' },
    });

    await expect(startPromise).rejects.toThrow(/process tap creation failed/);
  });

  it('throws a clear error on non-darwin process.platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const tap = new TapCapture({ spawnFn: () => new FakeAudioChild(), clock: new FakeClock() });

    await expect(tap.start()).rejects.toThrow(/macOS/);
  });

  it('rejects a second start() call while already running', async () => {
    const child = new FakeAudioChild();
    const spawnFn: AudioSpawnFn = () => child;
    const tap = new TapCapture({ spawnFn, clock: new FakeClock() });

    const startPromise = tap.start();
    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    await startPromise;

    await expect(tap.start()).rejects.toThrow(/already running/);
  });

  it('does not hang: readiness timeout rejects instead of waiting forever', async () => {
    const child = new FakeAudioChild();
    const clock = new FakeClock();
    const spawnFn: AudioSpawnFn = () => child;
    const tap = new TapCapture({ spawnFn, clock, readinessTimeoutMs: 1000, heartbeatMs: 0 });

    const startPromise = tap.start();
    clock.fireAll(); // fires the readiness-timeout timer immediately, no real sleep

    await expect(startPromise).rejects.toThrow(/did not report readiness/);
  });
});
