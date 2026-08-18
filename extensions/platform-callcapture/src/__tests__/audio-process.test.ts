import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AudioSpawnFn, Clock, ReadyLineResult, SpawnedAudioChild } from '../audio-process';
import { pcmChunksFromStdout, startAudioCapture } from '../audio-process';

// Fake spawned audio child — real Readables (so `for await` / readline work
// against them unmodified) plus the minimal exit/error/kill surface
// `startAudioCapture` needs. Mirrors `detector.test.ts`'s `FakeChild` idiom,
// extended with a second (stderr) stream.
class FakeAudioChild implements SpawnedAudioChild {
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
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

  emitStderrLine(fields: unknown): void {
    this.stderr.push(`${JSON.stringify(fields)}\n`);
  }

  emitStdout(bytes: Buffer): void {
    this.stdout.push(bytes);
  }

  endStdout(): void {
    this.stdout.push(null);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const h of this.exitHandlers) h(code, signal);
  }

  emitProcessError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }
}

/** Virtual-time fake `Clock`. `advanceBy(ms)` steps simulated time forward to
 * each pending timer's due time IN ORDER (not one jump to the end) — the
 * same semantics real timers (and libraries like sinon's `clock.tick`) use.
 * This matters for a self-rescheduling chain like the heartbeat: firing it
 * schedules a new timer `heartbeatMs` after the CURRENT simulated time, and
 * that new timer must still be eligible to fire within the same
 * `advanceBy()` call if its due time falls inside the requested window. */
class FakeClock implements Clock {
  private nextId = 1;
  private now = 0;
  private readonly pending = new Map<number, { fn: () => void; dueAt: number }>();

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, { fn, dueAt: this.now + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advanceBy(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let earliestId: number | null = null;
      let earliestDue = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.pending) {
        if (entry.dueAt <= target && entry.dueAt < earliestDue) {
          earliestDue = entry.dueAt;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const entry = this.pending.get(earliestId);
      this.pending.delete(earliestId);
      this.now = earliestDue;
      entry?.fn();
    }
    this.now = target;
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('pcmChunksFromStdout', () => {
  it('parses byte-aligned stdout chunks into Int16Array frames', async () => {
    const stream = new Readable({ read() {} });
    const samples = Int16Array.from([1, -1, 1000, -1000]);
    const buf = Buffer.from(samples.buffer);
    queueMicrotask(() => {
      stream.push(buf);
      stream.push(null);
    });

    const chunks = await collect(pcmChunksFromStdout(stream, 16_000));

    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0]?.data ?? [])).toEqual([1, -1, 1000, -1000]);
    expect(chunks[0]?.sampleRate).toBe(16_000);
  });

  it('carries a trailing odd byte across a stream-chunk boundary instead of dropping or misaligning it', async () => {
    const stream = new Readable({ read() {} });
    const samples = Int16Array.from([100, 200]);
    const buf = Buffer.from(samples.buffer); // 4 bytes total
    queueMicrotask(() => {
      stream.push(buf.subarray(0, 3)); // splits mid-sample: full [100] + 1 byte of [200]
      stream.push(buf.subarray(3, 4)); // the remaining byte of [200]
      stream.push(null);
    });

    const chunks = await collect(pcmChunksFromStdout(stream, 16_000));
    const allSamples = chunks.flatMap((c) => Array.from(c.data));

    expect(allSamples).toEqual([100, 200]);
  });
});

const isMetadataReady = (fields: Record<string, unknown>): ReadyLineResult | null => {
  if (fields.message_type !== 'metadata') return null;
  const data = fields.data as Record<string, unknown> | undefined;
  const sampleRate = data?.sample_rate;
  return typeof sampleRate === 'number' ? { sampleRate } : null;
};

const isErrorLine = (fields: Record<string, unknown>): string | null => {
  if (fields.message_type !== 'error') return null;
  const data = fields.data as Record<string, unknown> | undefined;
  const message = data?.message;
  return typeof message === 'string' ? message : 'unknown error';
};

function setup(overrides: Partial<Parameters<typeof startAudioCapture>[0]> = {}) {
  const child = new FakeAudioChild();
  const clock = new FakeClock();
  const spawnFn: AudioSpawnFn = () => child;
  const waiting: number[] = [];
  const runtimeErrors: string[] = [];

  const promise = startAudioCapture({
    binaryPath: 'fake-binary',
    args: [],
    spawnFn,
    clock,
    readinessTimeoutMs: 20_000,
    heartbeatMs: 5_000,
    onWaiting: (s) => waiting.push(s),
    onRuntimeError: (m) => runtimeErrors.push(m),
    isReadyLine: isMetadataReady,
    isErrorLine,
    ...overrides,
  });

  return { child, clock, promise, waiting, runtimeErrors };
}

describe('startAudioCapture', () => {
  it('resolves a chunk stream once the readiness line arrives', async () => {
    const { child, promise } = setup();

    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    const handle = await promise;

    expect(handle.sampleRate).toBe(16_000);

    const samples = Int16Array.from([42, -42]);
    child.emitStdout(Buffer.from(samples.buffer));
    child.endStdout();
    const chunks = await collect(handle.chunks);
    expect(Array.from(chunks[0]?.data ?? [])).toEqual([42, -42]);
  });

  it('rejects with a typed error when an error line arrives before readiness', async () => {
    const { child, promise } = setup();

    child.emitStderrLine({ message_type: 'error', data: { message: 'tap setup failed' } });

    await expect(promise).rejects.toThrow(/tap setup failed/);
    expect(child.killed).toBe(true);
  });

  it('rejects with a typed timeout error — never hangs — when readiness never arrives', async () => {
    const { clock, promise } = setup({ readinessTimeoutMs: 20_000, heartbeatMs: 5_000 });

    clock.advanceBy(20_000);

    await expect(promise).rejects.toThrow(/did not report readiness within 20000ms/);
  });

  it('calls onWaiting with increasing elapsed-seconds heartbeats while waiting', async () => {
    const { clock, waiting, promise } = setup({ readinessTimeoutMs: 20_000, heartbeatMs: 5_000 });

    clock.advanceBy(15_000);
    expect(waiting).toEqual([5, 10, 15]);

    clock.advanceBy(5_000); // hits the 20s readiness timeout too
    await expect(promise).rejects.toThrow();
  });

  it('rejects when the process exits before reporting readiness', async () => {
    const { child, promise } = setup();

    child.emitExit(1, null);

    await expect(promise).rejects.toThrow(/exited before reporting readiness/);
  });

  it('surfaces a post-readiness error line via onRuntimeError instead of throwing or hanging', async () => {
    const { child, promise, runtimeErrors } = setup();

    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    await promise;

    child.emitStderrLine({ message_type: 'error', data: { message: 'device disconnected' } });

    expect(runtimeErrors).toEqual(['device disconnected']);
  });

  it('does not treat a caller-requested stop() exit as a runtime error', async () => {
    const { child, promise, runtimeErrors } = setup();

    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    const handle = await promise;

    handle.stop();
    child.emitExit(0, 'SIGTERM');

    expect(runtimeErrors).toEqual([]);
  });

  it('surfaces an unrequested post-readiness exit via onRuntimeError', async () => {
    const { child, promise, runtimeErrors } = setup();

    child.emitStderrLine({ message_type: 'metadata', data: { sample_rate: 16_000 } });
    await promise;

    child.emitExit(1, null); // no stop() was called — this is a real crash

    expect(runtimeErrors).toEqual([expect.stringContaining('exited unexpectedly')]);
  });
});
