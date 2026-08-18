import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudioSpawnFn, Clock, SpawnedAudioChild } from '../audio-process';
import { MicCapture } from '../mic-capture';

// Same minimal-fake rationale as tap-capture.test.ts — deep readiness/
// timeout/heartbeat mechanics are covered once, in audio-process.test.ts.
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

describe('MicCapture', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('invokes mic-capture with no args and resolves chunks once metadata arrives', async () => {
    const child = new FakeAudioChild();
    const seenArgs: string[][] = [];
    const spawnFn: AudioSpawnFn = (_path, args) => {
      seenArgs.push(args);
      return child;
    };
    const mic = new MicCapture({ spawnFn, clock: new FakeClock() });

    const startPromise = mic.start();
    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    await startPromise;

    expect(seenArgs).toEqual([[]]);
  });

  it('rejects with the mic-capture error message on an error line', async () => {
    const child = new FakeAudioChild();
    const spawnFn: AudioSpawnFn = () => child;
    const mic = new MicCapture({ spawnFn, clock: new FakeClock() });

    const startPromise = mic.start();
    child.emitStderrLine({
      message_type: 'error',
      data: { message: 'AVAudioEngine.start() failed' },
    });

    await expect(startPromise).rejects.toThrow(/AVAudioEngine\.start\(\) failed/);
  });

  it('throws a clear error on non-darwin process.platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const mic = new MicCapture({ spawnFn: () => new FakeAudioChild(), clock: new FakeClock() });

    await expect(mic.start()).rejects.toThrow(/macOS/);
  });

  it('rejects a second start() call while already running', async () => {
    const child = new FakeAudioChild();
    const spawnFn: AudioSpawnFn = () => child;
    const mic = new MicCapture({ spawnFn, clock: new FakeClock() });

    const startPromise = mic.start();
    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    await startPromise;

    await expect(mic.start()).rejects.toThrow(/already running/);
  });

  it('does not hang: readiness timeout rejects instead of waiting forever', async () => {
    const child = new FakeAudioChild();
    const clock = new FakeClock();
    const spawnFn: AudioSpawnFn = () => child;
    const mic = new MicCapture({ spawnFn, clock, readinessTimeoutMs: 1000, heartbeatMs: 0 });

    const startPromise = mic.start();
    clock.fireAll();

    await expect(startPromise).rejects.toThrow(/did not report readiness/);
  });
});
