import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferedVoiceSpanWriter, type VoiceSpanSink, type VoiceTurnSpan } from '../span-writer';

function span(turnId: string, stage: VoiceTurnSpan['stage'] = 'turn'): VoiceTurnSpan {
  return { turnId, stage, startTs: 0, endTs: 1, status: 'ok' };
}

function recordingSink(): { sink: VoiceSpanSink; batches: VoiceTurnSpan[][] } {
  const batches: VoiceTurnSpan[][] = [];
  return {
    batches,
    sink: {
      write(spans) {
        batches.push(spans);
      },
    },
  };
}

describe('BufferedVoiceSpanWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The whole reason this class exists: the sink is synchronous SQLite, and
  // calling it from the audio path stalls the loop that paces frames.
  it('never touches the sink on record() — the audio path only appends', () => {
    const { sink, batches } = recordingSink();
    const writer = new BufferedVoiceSpanWriter({ sink });

    for (let i = 0; i < 10; i++) writer.record(span(`u${i}`));

    expect(batches).toHaveLength(0);
    expect(writer.pending).toBe(10);
  });

  it('flushes on the interval, off the turn path', async () => {
    const { sink, batches } = recordingSink();
    const writer = new BufferedVoiceSpanWriter({ sink, flushIntervalMs: 1000 });

    writer.record(span('u1'));
    writer.record(span('u2'));
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((s) => s.turnId)).toEqual(['u1', 'u2']);
    expect(writer.pending).toBe(0);
  });

  it('flushes what is buffered on close() — the session-end trigger', async () => {
    const { sink, batches } = recordingSink();
    const writer = new BufferedVoiceSpanWriter({ sink, flushIntervalMs: 60_000 });

    writer.record(span('u1'));
    await writer.close();

    expect(batches).toEqual([[span('u1')]]);
  });

  it('is idempotent on close and ignores records afterwards', async () => {
    const { sink, batches } = recordingSink();
    const writer = new BufferedVoiceSpanWriter({ sink });

    writer.record(span('u1'));
    await writer.close();
    writer.record(span('u2'));
    await writer.close();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((s) => s.turnId)).toEqual(['u1']);
  });

  it('is bounded — drops the OLDEST spans and reports the drop', () => {
    const { sink } = recordingSink();
    const drops: number[] = [];
    const writer = new BufferedVoiceSpanWriter({
      sink,
      maxBuffered: 3,
      onDrop: (total) => drops.push(total),
    });

    for (let i = 1; i <= 5; i++) writer.record(span(`u${i}`));

    expect(writer.pending).toBe(3);
    expect(writer.dropped).toBe(2);
    expect(drops).toEqual([1, 2]);
  });

  it('keeps the newest spans after a drop', async () => {
    const { sink, batches } = recordingSink();
    const writer = new BufferedVoiceSpanWriter({ sink, maxBuffered: 2 });

    for (let i = 1; i <= 4; i++) writer.record(span(`u${i}`));
    await writer.close();

    expect(batches[0]?.map((s) => s.turnId)).toEqual(['u3', 'u4']);
  });

  it('swallows sink failures — telemetry cannot break a live call', async () => {
    const errors: unknown[] = [];
    const writer = new BufferedVoiceSpanWriter({
      sink: {
        write() {
          throw new Error('db locked');
        },
      },
      onError: (err) => errors.push(err),
    });

    writer.record(span('u1'));
    await expect(writer.close()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('does not start a timer when the interval is disabled', async () => {
    const { sink, batches } = recordingSink();
    const writer = new BufferedVoiceSpanWriter({ sink, flushIntervalMs: 0 });

    writer.record(span('u1'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches).toHaveLength(0);

    await writer.close();
    expect(batches).toHaveLength(1);
  });
});
