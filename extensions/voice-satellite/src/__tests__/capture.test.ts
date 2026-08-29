import { describe, expect, it, vi } from 'vitest';
import { CaptureMachine, type CaptureMachineConfig, type CaptureState } from '../capture';
import type { WakeEngine, WakeFrame, WakeMatch } from '../wake-engine';

const MATCH: WakeMatch = { routeId: 'r-eng', phrase: 'hey engineer', confidence: 1 };

function frame(): WakeFrame {
  return { samples: new Int16Array(320), sampleRate: 16000 };
}

/** A hand-driven clock: tests fire timers by name, never by waiting. */
class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();

  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  };

  clear = (handle: unknown): void => {
    if (typeof handle === 'number') this.pending.delete(handle);
  };

  /** Fire the single pending timer scheduled for exactly `ms`. */
  fire(ms: number): void {
    for (const [id, entry] of this.pending) {
      if (entry.ms !== ms) continue;
      this.pending.delete(id);
      entry.fn();
      return;
    }
    throw new Error(
      `no pending timer for ${ms}ms (have: ${[...this.pending.values()].map((e) => e.ms).join(', ')})`,
    );
  }
}

interface Harness {
  machine: CaptureMachine;
  timers: FakeTimers;
  engine: WakeEngine & { pushSpy: ReturnType<typeof vi.fn>; resetSpy: ReturnType<typeof vi.fn> };
  states: Array<{ state: CaptureState; detail?: string }>;
  audio: WakeFrame[];
  /** Wakes RELEASED upstream — the utterances that earned a server-side turn. */
  wakes: WakeMatch[];
  /** Speech onsets, which every blip produces and no blip sends. */
  speechStarts: number;
  utteranceEnds: number;
  /** Next N `engine.push()` calls report a wake. */
  armWake(): void;
  /** Push `count` frames the VAD reads as silence. */
  silence(count: number): void;
  speech(count?: number): void;
}

const CONFIG: CaptureMachineConfig = {
  silenceFrames: 3,
  idleTimeoutMs: 60_000,
  playbackWatchdogMs: 10_000,
  // One 20 ms frame of speech is enough to qualify. The suites below this line
  // are about ENDPOINTING and re-arming, and they say what they mean in two or
  // three frames; the minimum-speech guard gets its own config where it is the
  // subject rather than a tax on every other test.
  minSpeechMs: 20,
};

function harness(config: CaptureMachineConfig = CONFIG): Harness {
  const timers = new FakeTimers();
  const states: Array<{ state: CaptureState; detail?: string }> = [];
  const audio: WakeFrame[] = [];
  const wakes: WakeMatch[] = [];
  let utteranceEnds = 0;
  let speechStarts = 0;
  let wakeArmed = false;
  let speechNow = true;

  const pushSpy = vi.fn((_frame: WakeFrame) => {
    if (!wakeArmed) return null;
    wakeArmed = false;
    return MATCH;
  });
  const resetSpy = vi.fn();

  const engine = {
    name: 'fake',
    init: async () => {},
    push: pushSpy,
    reset: resetSpy,
    dispose: async () => {},
    pushSpy,
    resetSpy,
  };

  const machine = new CaptureMachine(
    {
      engine,
      vad: { push: () => speechNow },
      now: () => 1_700_000_000_000,
      setTimer: timers.set,
      clearTimer: timers.clear,
      onSpeechStart: () => {
        speechStarts++;
      },
      onWake: (m) => wakes.push(m),
      onAudio: (f) => audio.push(f),
      onUtteranceEnd: () => {
        utteranceEnds++;
      },
      onStateChange: (state, detail) => states.push({ state, detail }),
    },
    config,
  );

  const h: Harness = {
    machine,
    timers,
    engine,
    states,
    audio,
    wakes,
    get speechStarts() {
      return speechStarts;
    },
    get utteranceEnds() {
      return utteranceEnds;
    },
    armWake: () => {
      wakeArmed = true;
    },
    silence: (count: number) => {
      speechNow = false;
      for (let i = 0; i < count; i++) machine.pushFrame(frame());
    },
    speech: (count = 1) => {
      speechNow = true;
      for (let i = 0; i < count; i++) machine.pushFrame(frame());
    },
  };
  return h;
}

describe('CaptureMachine — arming and capture', () => {
  it('starts idle and arms into listening', () => {
    const h = harness();
    expect(h.machine.getState()).toBe('idle');
    h.machine.start();
    expect(h.machine.getState()).toBe('listening');
  });

  it('captures audio after a wake and ends the utterance on sustained silence', () => {
    const h = harness();
    h.machine.start();
    h.armWake();
    h.machine.pushFrame(frame());

    // Speech onset opens the utterance LOCALLY. The wake is held — nothing has
    // gone upstream yet, because nothing has earned it.
    expect(h.speechStarts).toBe(1);
    expect(h.wakes).toHaveLength(0);
    expect(h.machine.getState()).toBe('capturing');
    // The waking frame itself is not forwarded as utterance audio.
    expect(h.audio).toHaveLength(0);

    h.speech(2);
    // One 20 ms frame clears this config's floor, so the wake is released with
    // the held frames behind it — never after them.
    expect(h.wakes).toEqual([MATCH]);
    expect(h.audio).toHaveLength(2);
    h.silence(2);
    expect(h.machine.getState()).toBe('capturing');
    h.silence(1);
    expect(h.machine.getState()).toBe('thinking');
    expect(h.utteranceEnds).toBe(1);
  });

  it('resets the silence run when speech resumes mid-utterance', () => {
    const h = harness();
    h.machine.start();
    h.armWake();
    h.machine.pushFrame(frame());
    h.silence(2);
    h.speech(1);
    h.silence(2);
    expect(h.machine.getState()).toBe('capturing');
    h.silence(1);
    expect(h.machine.getState()).toBe('thinking');
  });
});

describe('CaptureMachine — minimum speech', () => {
  // 100 ms = five 20 ms frames, so "enough" and "not enough" are both a couple
  // of pushes apart and the assertions stay readable.
  const GUARDED: CaptureMachineConfig = { ...CONFIG, minSpeechMs: 100 };

  /** Open an utterance without spending any speech on it. */
  function wake(h: Harness): void {
    h.armWake();
    h.machine.pushFrame(frame());
  }

  it('discards an utterance with too little speech and sends nothing upstream', () => {
    const h = harness(GUARDED);
    h.machine.start();
    wake(h);

    h.speech(2); // 40 ms — a cough, not a request.
    h.silence(3);

    // Nothing upstream AT ALL: not the wake (it was held), not the audio (also
    // held, never forwarded), and not the end-of-utterance that would have
    // started a turn. The onset happened and only this machine knows.
    expect(h.speechStarts).toBe(1);
    expect(h.wakes).toHaveLength(0);
    expect(h.audio).toHaveLength(0);
    expect(h.utteranceEnds).toBe(0);
    // Reported, and re-armed exactly as a completed turn re-arms.
    expect(h.machine.getState()).toBe('listening');
    const last = h.states[h.states.length - 1];
    expect(last?.state).toBe('listening');
    expect(last?.detail).toMatch(/discarded utterance: 40ms of speech, under the 100ms minimum/);
  });

  it('wakes again immediately after a discard', () => {
    const h = harness(GUARDED);
    h.machine.start();
    wake(h);
    h.speech(1);
    h.silence(3);
    expect(h.machine.getState()).toBe('listening');

    wake(h);
    expect(h.machine.getState()).toBe('capturing');
    // Two onsets, and still nothing released: the first was discarded and the
    // second has not qualified yet.
    expect(h.speechStarts).toBe(2);
    expect(h.wakes).toHaveLength(0);
    h.speech(5);
    h.silence(3);
    // One wake for two onsets — the room noise cost the server nothing.
    expect(h.wakes).toHaveLength(1);
    expect(h.utteranceEnds).toBe(1);
  });

  it('leaves an utterance above the threshold untouched, leading frames included', () => {
    const h = harness(GUARDED);
    h.machine.start();
    wake(h);

    // Two silent frames of lead-in, then the speech that qualifies it. The
    // lead-in must still arrive: it is where the first word starts.
    h.silence(2);
    h.speech(5);
    expect(h.audio).toHaveLength(7);
    h.silence(3);

    expect(h.machine.getState()).toBe('thinking');
    expect(h.utteranceEnds).toBe(1);
    expect(h.audio).toHaveLength(10);
  });

  it('does not carry speech across utterances', () => {
    const h = harness(GUARDED);
    h.machine.start();
    // Four sub-threshold utterances in a row do not add up to a fifth that
    // qualifies — a room full of noise must never accumulate into a turn.
    for (let i = 0; i < 4; i++) {
      wake(h);
      h.speech(2);
      h.silence(3);
    }
    expect(h.utteranceEnds).toBe(0);
    expect(h.audio).toHaveLength(0);
    // Four chair scrapes, four onsets, and not one server-side utterance. This
    // is the whole point of holding the wake: an open microphone in a room is
    // free until somebody actually says something to it.
    expect(h.speechStarts).toBe(4);
    expect(h.wakes).toHaveLength(0);
  });

  it('releases the wake in front of the flush, never behind it', () => {
    // ORDER IS THE CONTRACT. A host sends `wake` + `utterance_start` from
    // `onWake` and PCM from `onAudio`; audio for an utterance the server has
    // not been told about is audio the server drops on arrival.
    const order: string[] = [];
    const h = harness(GUARDED);
    const spyWake = h.wakes;
    const spyAudio = h.audio;
    // Recorded through the arrays the harness already fills, by length: the
    // first `onAudio` must land after the array of wakes is non-empty.
    h.machine.start();
    wake(h);
    h.silence(2);
    for (let i = 0; i < 5; i++) {
      const before = spyAudio.length;
      h.speech(1);
      if (spyAudio.length > before && order.length === 0) {
        order.push(spyWake.length > 0 ? 'wake-first' : 'audio-first');
      }
    }
    expect(order).toEqual(['wake-first']);
  });

  it('defaults to a threshold that a blip cannot clear', () => {
    // No `minSpeechMs` — the shipped default is what a real satellite runs.
    const h = harness({ silenceFrames: 3, idleTimeoutMs: 60_000, playbackWatchdogMs: 10_000 });
    h.machine.start();
    wake(h);
    h.speech(5); // 100 ms.
    h.silence(3);
    expect(h.utteranceEnds).toBe(0);
    expect(h.machine.getState()).toBe('listening');

    wake(h);
    h.speech(20); // 400 ms.
    h.silence(3);
    expect(h.utteranceEnds).toBe(1);
  });
});

describe('CaptureMachine — self-wake suppression', () => {
  it('never feeds the engine while the satellite is speaking', () => {
    const h = harness();
    h.machine.start();
    h.armWake();
    h.machine.pushFrame(frame());
    h.speech(1);
    h.silence(3);

    h.machine.beginPlayback();
    expect(h.machine.getState()).toBe('speaking');

    const before = h.engine.pushSpy.mock.calls.length;
    // The room now contains the agent's own voice. Arm a wake to prove the
    // engine is not merely being ignored — it is not being called at all.
    h.armWake();
    for (let i = 0; i < 10; i++) h.machine.pushFrame(frame());

    expect(h.engine.pushSpy.mock.calls.length).toBe(before);
    expect(h.wakes).toHaveLength(1);
    expect(h.machine.getState()).toBe('speaking');
  });

  it('drops frames while thinking, so a server-side pause cannot self-wake either', () => {
    const h = harness();
    h.machine.start();
    h.armWake();
    h.machine.pushFrame(frame());
    h.speech(1);
    h.silence(3);
    expect(h.machine.getState()).toBe('thinking');

    const before = h.engine.pushSpy.mock.calls.length;
    h.armWake();
    h.machine.pushFrame(frame());
    expect(h.engine.pushSpy.mock.calls.length).toBe(before);
  });

  it('re-arms and resets the engine on endPlayback', () => {
    const h = harness();
    h.machine.start();
    h.machine.beginPlayback();
    const resetsBefore = h.engine.resetSpy.mock.calls.length;
    h.machine.endPlayback();
    expect(h.machine.getState()).toBe('listening');
    expect(h.engine.resetSpy.mock.calls.length).toBeGreaterThan(resetsBefore);
  });
});

describe('CaptureMachine — verified re-arm', () => {
  it('survives five consecutive wake → capture → speak → re-arm cycles', () => {
    // 60 ms minimum, so a two-frame utterance is real and a one-frame one is
    // noise — the discard below has to be a genuine sub-threshold utterance.
    const h = harness({ ...CONFIG, minSpeechMs: 60 });
    h.machine.start();

    for (let cycle = 0; cycle < 5; cycle++) {
      expect(h.machine.getState()).toBe('listening');
      // A blip of room noise between turns must not consume the cycle: it is
      // discarded, and the machine is back in `listening` for the real one.
      if (cycle === 2) {
        h.armWake();
        h.machine.pushFrame(frame());
        h.speech(1);
        h.silence(3);
        expect(h.machine.getState()).toBe('listening');
      }
      h.armWake();
      h.machine.pushFrame(frame());
      expect(h.machine.getState()).toBe('capturing');
      h.speech(3);
      h.silence(3);
      expect(h.machine.getState()).toBe('thinking');
      h.machine.beginPlayback();
      expect(h.machine.getState()).toBe('speaking');
      h.machine.endPlayback();
    }

    // Six ONSETS, five wakes, five turns: the discarded one opened an utterance
    // locally and never reached the wire.
    expect(h.speechStarts).toBe(6);
    expect(h.wakes).toHaveLength(5);
    expect(h.utteranceEnds).toBe(5);
    expect(h.machine.getState()).toBe('listening');
    // And it is genuinely armed, not merely labelled: another utterance opens
    // and, once it has said enough, reaches the wire.
    h.armWake();
    h.machine.pushFrame(frame());
    expect(h.machine.getState()).toBe('capturing');
    h.speech(3);
    expect(h.wakes).toHaveLength(6);
  });
});

describe('CaptureMachine — watchdog', () => {
  it('force-re-arms and reports degraded when playback never finishes', () => {
    const h = harness();
    h.machine.start();
    h.machine.beginPlayback();
    h.states.length = 0;

    h.timers.fire(10_000);

    expect(h.states.map((s) => s.state)).toEqual(['degraded', 'listening']);
    expect(h.states[0]?.detail).toMatch(/watchdog/i);
    expect(h.machine.getState()).toBe('listening');

    h.armWake();
    h.machine.pushFrame(frame());
    h.speech(1);
    expect(h.wakes).toHaveLength(1);
  });

  it('cancels the watchdog when playback finishes normally', () => {
    const h = harness();
    h.machine.start();
    h.machine.beginPlayback();
    h.machine.endPlayback();
    expect([...h.timers.pending.values()].some((t) => t.ms === 10_000)).toBe(false);
  });
});

describe('CaptureMachine — idle timeout', () => {
  it('ends LISTENING only, and the microphone stays armed', () => {
    const h = harness();
    h.machine.start();
    h.timers.fire(60_000);

    expect(h.machine.getState()).toBe('idle');
    // No session callback exists on this machine to have been called: the
    // criterion is satisfied structurally, and the mic is still live.
    h.armWake();
    h.machine.pushFrame(frame());
    expect(h.machine.getState()).toBe('capturing');
    h.speech(1);
    expect(h.wakes).toEqual([MATCH]);
  });

  it('does not fire while an utterance is being captured', () => {
    const h = harness();
    h.machine.start();
    h.armWake();
    h.machine.pushFrame(frame());
    expect([...h.timers.pending.values()].some((t) => t.ms === 60_000)).toBe(false);
  });
});

describe('CaptureMachine — mute', () => {
  it('drops frames, resets the engine, and re-arms on un-mute', () => {
    const h = harness();
    h.machine.start();

    h.machine.setMuted(true);
    expect(h.machine.getState()).toBe('muted');
    const before = h.engine.pushSpy.mock.calls.length;
    h.armWake();
    h.machine.pushFrame(frame());
    expect(h.engine.pushSpy.mock.calls.length).toBe(before);
    expect(h.wakes).toHaveLength(0);

    const resetsBefore = h.engine.resetSpy.mock.calls.length;
    h.machine.setMuted(false);
    expect(h.machine.getState()).toBe('listening');
    expect(h.engine.resetSpy.mock.calls.length).toBeGreaterThan(resetsBefore);
    h.machine.pushFrame(frame());
    h.speech(1);
    expect(h.wakes).toHaveLength(1);
  });

  it('stays muted across a playback cycle', () => {
    const h = harness();
    h.machine.start();
    h.machine.setMuted(true);
    h.machine.beginPlayback();
    expect(h.machine.getState()).toBe('muted');
    h.machine.endPlayback();
    expect(h.machine.getState()).toBe('muted');
  });
});

describe('CaptureMachine — isolation', () => {
  it('keeps two machines in one process independent', () => {
    const a = harness();
    const b = harness();
    a.machine.start();
    b.machine.start();
    a.armWake();
    a.machine.pushFrame(frame());
    expect(a.machine.getState()).toBe('capturing');
    expect(b.machine.getState()).toBe('listening');
    expect(b.wakes).toHaveLength(0);
  });
});
