// Absolute-time frame pacing for an outbound phone leg.
//
// A realtime provider emits speech in bursts — a few hundred milliseconds of
// audio in one message. A SIP leg wants it back at real time, one 20 ms frame
// every 20 ms, or the far end's jitter buffer either starves or overruns.
//
// The obvious implementation is `setTimeout(next, 20)` from inside the previous
// tick, and it is wrong. Every wake-up is late by some amount — GC, a busy
// event loop, a slow tool call on the same process — and a relative timer folds
// that lateness into the NEXT deadline, so the error accumulates instead of
// being corrected. Over a minute of speech the leg drifts by hundreds of
// milliseconds and the audio warbles (OpenClaw #119070). So the schedule here
// is computed from an ABSOLUTE anchor: frame `i` is due at
// `startedAt + i * frameMs`, and each wake-up asks for the remaining delay to
// its own deadline. A late wake-up shortens the next delay rather than pushing
// it out, and the error never compounds.
//
// The anchor is re-taken whenever the queue drains, because there is nothing to
// pace across a silence: an anchor held over a ten-second gap would make the
// pacer believe it owed five hundred frames and flush them all at once.
//
// Per-pacer state only — one pacer per bridge, per lane. Nothing here is
// process-global (the umbrella plan's explicit invariant, OpenClaw #78523).

/** A scheduled wake-up. `cancel()` must be safe to call after it has fired. */
export interface FramePacerTimer {
  cancel(): void;
}

export interface FramePacer {
  /** Queue PCM for paced emission. Frames are cut to `frameMs` at `sampleRate`. */
  push(samples: Int16Array): void;
  /** Drop everything queued — barge-in / hang-up. */
  cancel(): void;
  /** Resolves when the queue has drained. */
  drained(): Promise<void>;
  stop(): void;
}

export interface FramePacerOptions {
  sampleRate: number;
  /** Frame duration in milliseconds. Default 20 — the RTP payload size G.711 uses. */
  frameMs?: number;
  emit: (frame: Int16Array) => void;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable scheduler. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => FramePacerTimer;
}

const DEFAULT_FRAME_MS = 20;

export function createFramePacer(opts: FramePacerOptions): FramePacer {
  const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
  const frameSamples = Math.max(1, Math.round((opts.sampleRate * frameMs) / 1000));
  const now = opts.now ?? Date.now;
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): FramePacerTimer => {
      const handle = setTimeout(fn, ms);
      return {
        cancel: () => clearTimeout(handle),
      };
    });

  /** Queued samples, oldest first. Frames are cut off the front. */
  let queue: Int16Array[] = [];
  let queued = 0;
  /** Absolute time frame 0 of the CURRENT run was due. Reset on every drain. */
  let startedAt = 0;
  /** Frames emitted since `startedAt`. The multiplier on the absolute schedule. */
  let frameIndex = 0;
  let timer: FramePacerTimer | null = null;
  let stopped = false;
  let waiters: Array<() => void> = [];

  const settleDrained = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const takeFrame = (): Int16Array => {
    const frame = new Int16Array(frameSamples);
    let filled = 0;
    while (filled < frameSamples && queue.length > 0) {
      const head = queue[0];
      if (!head) {
        queue.shift();
        continue;
      }
      const take = Math.min(frameSamples - filled, head.length);
      frame.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) queue.shift();
      else queue[0] = head.subarray(take);
    }
    queued -= filled;
    // A short tail is PADDED, not dropped: the tail of a reply is the end of a
    // sentence, and a leg that swallows it sounds like the agent was cut off.
    // The cost is up to one frame of silence when a provider's chunk boundary
    // does not divide by 20 ms, which is inaudible.
    return frame;
  };

  const schedule = (): void => {
    if (stopped || timer !== null) return;
    if (queued <= 0) {
      settleDrained();
      return;
    }
    // THE WHOLE POINT: the deadline is derived from the anchor, never from
    // "now + frameMs". A wake-up that arrives late gets a shorter delay to its
    // own deadline, so lateness is corrected instead of accumulated.
    const dueAt = startedAt + frameIndex * frameMs;
    timer = setTimer(tick, Math.max(0, dueAt - now()));
  };

  const tick = (): void => {
    timer = null;
    if (stopped || queued <= 0) {
      settleDrained();
      return;
    }
    frameIndex += 1;
    opts.emit(takeFrame());
    schedule();
  };

  return {
    push(samples: Int16Array): void {
      if (stopped || samples.length === 0) return;
      // Re-anchor whenever the run restarts from empty. See the file header.
      if (queued === 0 && timer === null) {
        startedAt = now();
        frameIndex = 0;
      }
      queue.push(samples);
      queued += samples.length;
      schedule();
    },

    cancel(): void {
      timer?.cancel();
      timer = null;
      queue = [];
      queued = 0;
      frameIndex = 0;
      settleDrained();
    },

    drained(): Promise<void> {
      if (queued === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },

    stop(): void {
      stopped = true;
      timer?.cancel();
      timer = null;
      queue = [];
      queued = 0;
      settleDrained();
    },
  };
}
