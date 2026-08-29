// `SatellitePlayout` — the re-arm receipt, and what it costs to get it wrong.
//
// Every test here is about ONE of two failures. Either the microphone comes
// back too early (into the agent's own voice, which is a self-wake) or it never
// comes back at all (a player that wedged, which is a satellite that has gone
// deaf in somebody's kitchen). Time is injected, so a drain that "never
// happens" is a test that finishes in a millisecond.

import { describe, expect, it } from 'vitest';
import type { PlaybackDevice } from '../audio-device';
import type { SatellitePlayoutEvent } from '../node-client';
import { type PlayoutProblem, SatellitePlayout } from '../playout';

/** Let the device chain's promises settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeDevice {
  device: PlaybackDevice;
  /** Every method call in order, as `verb:utteranceId`. */
  calls: string[];
  /** Payloads that actually reached the speaker, decoded for legibility. */
  played: Array<{ utteranceId: string; text: string }>;
  /** Resolve the `end()` that is waiting. */
  drain(): void;
}

function fakeDevice(opts: { startFails?: string } = {}): FakeDevice {
  const calls: string[] = [];
  const played: Array<{ utteranceId: string; text: string }> = [];
  let releaseEnd: (() => void) | null = null;
  const device: PlaybackDevice = {
    start: async (utteranceId, format) => {
      calls.push(`start:${utteranceId}:${format.codec}`);
      if (opts.startFails !== undefined) throw new Error(opts.startFails);
    },
    write: (utteranceId, pcm) => {
      calls.push(`write:${utteranceId}`);
      played.push({ utteranceId, text: new TextDecoder().decode(pcm) });
    },
    end: (utteranceId) => {
      calls.push(`end:${utteranceId}`);
      // Deliberately never auto-resolves: "the speaker is still going" is the
      // state every interesting assertion here is made in.
      return new Promise<void>((resolve) => {
        releaseEnd = resolve;
      });
    },
    cancel: (utteranceId) => {
      calls.push(`cancel:${utteranceId}`);
    },
    list: async () => [],
  };
  return {
    device,
    calls,
    played,
    drain: () => {
      const release = releaseEnd;
      releaseEnd = null;
      release?.();
    },
  };
}

function fakeClock(): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  pending: () => number;
  fire: () => void;
} {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

function harness(deviceOpts: { startFails?: string } = {}): {
  playout: SatellitePlayout;
  fake: FakeDevice;
  clock: ReturnType<typeof fakeClock>;
  done: Array<{ utteranceId: string; timedOut: boolean }>;
  problems: PlayoutProblem[];
} {
  const fake = fakeDevice(deviceOpts);
  const clock = fakeClock();
  const done: Array<{ utteranceId: string; timedOut: boolean }> = [];
  const problems: PlayoutProblem[] = [];
  const playout = new SatellitePlayout({
    device: fake.device,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onDone: (d) => done.push(d),
    onProblem: (p) => problems.push(p),
    drainWatchdogMs: 5_000,
  });
  return { playout, fake, clock, done, problems };
}

function speakStart(utteranceId: string, segmentId = 's1'): SatellitePlayoutEvent {
  return {
    type: 'speak_start',
    utteranceId,
    segmentId,
    codec: 'pcm_s16le',
    mimeType: 'audio/pcm',
  };
}

function audio(utteranceId: string, text: string, segmentId = 's1'): SatellitePlayoutEvent {
  return {
    type: 'audio',
    utteranceId,
    segmentId,
    seq: 0,
    payload: new TextEncoder().encode(text),
  };
}

function turnEnd(utteranceId: string): SatellitePlayoutEvent {
  return { type: 'turn_end', utteranceId };
}

describe('staleness discipline', () => {
  it('drops a write for a superseded utterance rather than playing it', async () => {
    const { playout, fake } = harness();
    playout.handle(speakStart('u1'));
    playout.handle(audio('u1', 'mine'));
    await flush();

    // Audio for an utterance that was never opened here. By the time it
    // arrived the room had moved on; playing it would answer a question
    // nobody is still asking.
    playout.handle(audio('u2', 'stale'));
    await flush();

    expect(fake.played).toEqual([{ utteranceId: 'u1', text: 'mine' }]);
  });

  it('a new utterance barges in: the old playout is cancelled, not drained', async () => {
    const { playout, fake } = harness();
    playout.handle(speakStart('u1'));
    playout.handle(audio('u1', 'first'));
    await flush();

    playout.handle(speakStart('u2'));
    // The first utterance's audio is now stale and must not reach the speaker
    // that is already playing the second.
    playout.handle(audio('u1', 'late'));
    playout.handle(audio('u2', 'second'));
    await flush();

    expect(fake.calls).toContain('cancel:u1');
    expect(fake.calls).not.toContain('end:u1');
    expect(fake.played).toEqual([
      { utteranceId: 'u1', text: 'first' },
      { utteranceId: 'u2', text: 'second' },
    ]);
  });

  it('a turn_end for the barged-in utterance still re-arms — no wedge', async () => {
    const { playout, done } = harness();
    playout.handle(speakStart('u1'));
    playout.handle(speakStart('u2'));
    await flush();

    playout.handle(turnEnd('u1'));
    expect(done).toEqual([{ utteranceId: 'u1', timedOut: false }]);
  });
});

describe('cancel', () => {
  it('drops queued audio, calls cancel, and never calls end', async () => {
    const { playout, fake, done } = harness();
    playout.handle(speakStart('u1'));
    playout.handle(audio('u1', 'half a sentence'));
    await flush();

    playout.cancel();
    await flush();

    expect(fake.calls).toContain('cancel:u1');
    // `end()` MEANS the buffer emptied. A barge-in is exactly the case where it
    // did not, so asking for it would be waiting on audio we just discarded.
    expect(fake.calls).not.toContain('end:u1');
    // Cancelling does not close a turn; the `turn_end` still owns the receipt.
    expect(done).toEqual([]);
  });

  it('is a no-op with nothing playing', () => {
    const { playout, fake } = harness();
    playout.cancel();
    expect(fake.calls).toEqual([]);
  });
});

describe('the re-arm receipt', () => {
  it('waits for end() to resolve — the speaker going quiet, not the words being known', async () => {
    const { playout, fake, done } = harness();
    playout.handle(speakStart('u1'));
    playout.handle(audio('u1', 'four seconds of speech'));
    await flush();

    playout.handle(turnEnd('u1'));
    await flush();

    // `turn_end` has landed and the device has been asked to drain — but the
    // speaker is still going, so the microphone stays shut.
    expect(fake.calls).toContain('end:u1');
    expect(done).toEqual([]);

    fake.drain();
    await flush();
    expect(done).toEqual([{ utteranceId: 'u1', timedOut: false }]);
  });

  it('fires immediately when nothing was ever played for the utterance', () => {
    const { playout, fake, done } = harness();
    // An unaddressed sentence, or a text-only reply. The speaker is quiet by
    // construction; waiting for a playout that is not coming would deafen the
    // node on every sentence the room says to nobody.
    playout.handle(turnEnd('u9'));
    expect(done).toEqual([{ utteranceId: 'u9', timedOut: false }]);
    expect(fake.calls).toEqual([]);
  });

  it('a player that never drains trips the watchdog and re-arms anyway', async () => {
    const { playout, fake, clock, done, problems } = harness();
    playout.handle(speakStart('u1'));
    await flush();
    playout.handle(turnEnd('u1'));
    await flush();

    expect(done).toEqual([]);
    expect(clock.pending()).toBe(1);

    clock.fire();

    expect(done).toEqual([{ utteranceId: 'u1', timedOut: true }]);
    expect(problems.map((p) => p.kind)).toEqual(['watchdog']);
    expect(problems[0]?.reason).toContain('5000ms');

    // The wedged player finally coming back must not re-arm a microphone that
    // is already live, nor send a second receipt for the same utterance.
    fake.drain();
    await flush();
    expect(done).toHaveLength(1);
  });

  it('clears the watchdog once the drain lands, so nothing fires later', async () => {
    const { playout, fake, clock, done } = harness();
    playout.handle(speakStart('u1'));
    await flush();
    playout.handle(turnEnd('u1'));
    await flush();
    fake.drain();
    await flush();

    expect(done).toEqual([{ utteranceId: 'u1', timedOut: false }]);
    expect(clock.pending()).toBe(0);
  });
});

describe('segments', () => {
  it('a second segment feeds the open device rather than restarting it', async () => {
    const { playout, fake } = harness();
    playout.handle(speakStart('u1', 's1'));
    playout.handle(audio('u1', 'one', 's1'));
    playout.handle({ type: 'segment_end', utteranceId: 'u1', segmentId: 's1' });
    playout.handle(speakStart('u1', 's2'));
    playout.handle(audio('u1', 'two', 's2'));
    await flush();

    // One `start`, no `end` between sentences: a sentence boundary is a
    // synthesis unit, and stopping the speaker at each one inserts a gap the
    // server never intended.
    expect(fake.calls.filter((c) => c.startsWith('start:'))).toEqual(['start:u1:pcm_s16le']);
    expect(fake.calls).not.toContain('end:u1');
    expect(fake.played.map((p) => p.text)).toEqual(['one', 'two']);
  });
});

describe('a device that will not open', () => {
  it('reports why, plays nothing, and still re-arms', async () => {
    const { playout, fake, done, problems } = harness({
      startFails: 'aplay plays RAW PCM only and the server sent audio/ogg',
    });
    playout.handle(speakStart('u1'));
    playout.handle(audio('u1', 'unplayable'));
    await flush();

    expect(problems).toEqual([
      {
        utteranceId: 'u1',
        kind: 'start',
        reason: 'aplay plays RAW PCM only and the server sent audio/ogg',
      },
    ]);
    expect(fake.played).toEqual([]);

    playout.handle(turnEnd('u1'));
    await flush();
    // Nothing was opened, so nothing is asked to drain — and the microphone
    // comes straight back. Voice failures degrade to text; they do not park it.
    expect(fake.calls).not.toContain('end:u1');
    expect(done).toEqual([{ utteranceId: 'u1', timedOut: false }]);
  });
});

describe('the format the device is opened with', () => {
  it('falls back to the documented rate when the lane names none', async () => {
    const { fake } = harness();
    const seen: Array<{ sampleRate: number; channels: number }> = [];
    const playout = new SatellitePlayout({
      device: {
        ...fake.device,
        start: async (_id, format) => {
          seen.push({ sampleRate: format.sampleRate, channels: format.channels });
        },
      },
      setTimer: () => 0,
      clearTimer: () => {},
      onDone: () => {},
    });
    playout.handle(speakStart('u1'));
    await flush();
    // The wire fields are optional and the server leaves them unset; guessing
    // the SAME number the browser client guesses is the point.
    expect(seen).toEqual([{ sampleRate: 24_000, channels: 1 }]);
  });

  it('uses what the lane sent when it sends it', async () => {
    const { fake } = harness();
    const seen: Array<{ sampleRate: number; channels: number }> = [];
    const playout = new SatellitePlayout({
      device: {
        ...fake.device,
        start: async (_id, format) => {
          seen.push({ sampleRate: format.sampleRate, channels: format.channels });
        },
      },
      setTimer: () => 0,
      clearTimer: () => {},
      onDone: () => {},
    });
    playout.handle({
      type: 'speak_start',
      utteranceId: 'u1',
      segmentId: 's1',
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
      sampleRate: 22_050,
      channels: 2,
    });
    await flush();
    expect(seen).toEqual([{ sampleRate: 22_050, channels: 2 }]);
  });
});
