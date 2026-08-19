import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { IndicatorSpawnFn, SpawnedIndicatorChild } from '../indicator';
import { CaptureIndicator } from '../indicator';
import type { TranscriptEntry } from '../transcript-session';

/** Captures every write as a decoded string, mirroring the "real stream,
 * minimal fake" idiom `detector.test.ts`'s `FakeChild` uses for stdout. */
class FakeStdin extends Writable {
  readonly writes: string[] = [];

  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk));
    callback();
  }
}

/** Fake spawned child — a real Readable/Writable pair (so readline and
 * stdin writes work unmodified) plus the minimal exit/error/kill surface
 * `CaptureIndicator` needs. Mirrors `detector.test.ts`'s `FakeChild`. */
class FakeChild implements SpawnedIndicatorChild {
  readonly stdout = new Readable({ read() {} });
  readonly stdin = new FakeStdin();
  killed = false;
  killSignal: NodeJS.Signals | undefined;
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

  kill(signal?: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal;
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

// readline emits 'line' asynchronously after a push — flush microtasks so
// pushed lines are observed before assertions run. Same helper as
// detector.test.ts.
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function setup(onError = vi.fn()) {
  const child = new FakeChild();
  const spawnFn: IndicatorSpawnFn = () => child;
  const indicator = new CaptureIndicator({ spawnFn, binaryPath: 'fake-binary', onError });
  return { child, indicator, onError };
}

describe('CaptureIndicator', () => {
  it('show() spawns the binary with the source label as an argv', () => {
    const spawnFn = vi.fn((_binaryPath: string, _args: string[]) => new FakeChild());
    const indicator = new CaptureIndicator({ spawnFn, binaryPath: 'fake-binary' });

    indicator.show('zoom');

    expect(spawnFn).toHaveBeenCalledWith('fake-binary', ['zoom']);
  });

  it('show() is a no-op if already showing (defensive guard against double-spawn)', () => {
    const spawnFn = vi.fn((_binaryPath: string, _args: string[]) => new FakeChild());
    const indicator = new CaptureIndicator({ spawnFn, binaryPath: 'fake-binary' });

    indicator.show('zoom');
    indicator.show('zoom');

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('updateTranscript() writes a transcript_append NDJSON command to stdin', () => {
    const { child, indicator } = setup();
    indicator.show('zoom');

    const entry: TranscriptEntry = { speaker: 'you', text: 'hello', at: 1 };
    indicator.updateTranscript(entry);

    expect(child.stdin.writes).toEqual([
      `${JSON.stringify({ command: 'transcript_append', speaker: 'you', text: 'hello' })}\n`,
    ]);
  });

  it('updateTranscript() before show() is a no-op (no process to write to)', () => {
    const { indicator } = setup();
    expect(() => indicator.updateTranscript({ speaker: 'you', text: 'hi', at: 1 })).not.toThrow();
  });

  it('updateAudioLevel() writes an audio_level NDJSON command to stdin', () => {
    const { child, indicator } = setup();
    indicator.show('zoom');

    indicator.updateAudioLevel('you', 0.42, 1);

    expect(child.stdin.writes).toEqual([
      `${JSON.stringify({ command: 'audio_level', speaker: 'you', level: 0.42 })}\n`,
    ]);
  });

  it('updateAudioLevel() before show() is a no-op (no process to write to)', () => {
    const { indicator } = setup();
    expect(() => indicator.updateAudioLevel('other', 0.1, 1)).not.toThrow();
  });

  it('hide() writes a hide command and kills the process', () => {
    const { child, indicator } = setup();
    indicator.show('zoom');

    indicator.hide();

    expect(child.stdin.writes).toEqual([`${JSON.stringify({ command: 'hide' })}\n`]);
    expect(child.killed).toBe(true);
  });

  it('hide() before show() is a safe no-op', () => {
    const { indicator } = setup();
    expect(() => indicator.hide()).not.toThrow();
  });

  it('hide() followed by a fresh show() spawns a new process — one process per capture', () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const indicator = new CaptureIndicator({ spawnFn, binaryPath: 'fake-binary' });

    indicator.show('zoom');
    indicator.hide();
    indicator.show('teams');

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn).toHaveBeenNthCalledWith(2, 'fake-binary', ['teams']);
  });

  it('forwards an end_requested stdout event to the registered onEndRequested callback', async () => {
    const { child, indicator } = setup();
    const onEndRequested = vi.fn();
    indicator.onEndRequested(onEndRequested);
    indicator.show('zoom');

    child.emitLine({ event: 'end_requested' });
    await flush();

    expect(onEndRequested).toHaveBeenCalledTimes(1);
  });

  it('onEndRequested is registered once and survives a hide() -> show() cycle', async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const indicator = new CaptureIndicator({ spawnFn, binaryPath: 'fake-binary' });
    const onEndRequested = vi.fn();
    indicator.onEndRequested(onEndRequested);

    indicator.show('zoom');
    indicator.hide();
    indicator.show('teams');
    second.emitLine({ event: 'end_requested' });
    await flush();

    expect(onEndRequested).toHaveBeenCalledTimes(1);
  });

  it('surfaces a spawn failure via onError without throwing', () => {
    const spawnFn: IndicatorSpawnFn = () => {
      throw new Error('binary not found');
    };
    const onError = vi.fn();
    const indicator = new CaptureIndicator({ spawnFn, binaryPath: 'fake-binary', onError });

    expect(() => indicator.show('zoom')).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('binary not found'));
  });

  it('surfaces an error event on stdout via onError', async () => {
    const { child, indicator, onError } = setup();
    indicator.show('zoom');

    child.emitLine({ event: 'error', message: 'something broke' });
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('something broke'));
  });

  it('surfaces an unexpected non-zero exit via onError', () => {
    const { child, indicator, onError } = setup();
    indicator.show('zoom');

    child.emitExit(1, null);

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('exited unexpectedly'));
  });

  it('does not report an error for the expected exit that follows hide()', () => {
    const { child, indicator, onError } = setup();
    indicator.show('zoom');
    indicator.hide();

    child.emitExit(0, null);

    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores non-JSON and unrecognized stdout lines without throwing', async () => {
    const { child, indicator, onError } = setup();
    indicator.show('zoom');

    child.stdout.push('not json\n');
    child.emitLine({ event: 'ready' });
    await flush();

    expect(onError).not.toHaveBeenCalled();
  });
});
