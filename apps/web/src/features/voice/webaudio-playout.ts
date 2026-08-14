// Absolute-time playout for talk-mode.
//
// The batch path played each clip with `new Audio(dataURL)`: nothing could
// start until the whole clip existed, and consecutive clips were paced by
// whenever the previous one's `ended` event happened to fire. Chaining playback
// off relative timers (or off `ended`) accumulates the scheduler's lateness —
// a few milliseconds per clip becomes an audible warble over a long call.
//
// (The output analyser is here for the same reason: the Call Stage's speaking
// state is amplitude-driven, and the only place the agent's own level exists is
// on this graph, between the scheduled sources and the destination.)
//
// Everything here schedules against the audio clock instead: each buffer starts
// at an ABSOLUTE time on the context's timeline, and the next one starts exactly
// where the previous one ends. Late delivery cannot compound, because the next
// start time is derived from the previous start time, never from "now".

import { CALL_MOTION, smoothLevel } from './call-motion';

/** The slice of `AudioBuffer` this module needs. */
export interface PlayoutBuffer {
  readonly duration: number;
}

/** The slice of `AudioBufferSourceNode` this module needs. */
export interface PlayoutSource {
  buffer: PlayoutBuffer | null;
  connect(destination: unknown): void;
  start(when: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

/**
 * The slice of `AnalyserNode` the playout meters its OWN output with.
 *
 * The overlay's speaking state is amplitude-driven (DESIGN.md § "Call
 * overlay"), and the only place the agent's level exists is on the way to the
 * speakers. `fftSize` is set by whoever creates the node, not here — this stays
 * a read-only view so the fake in tests is three lines.
 */
export interface PlayoutAnalyser {
  readonly frequencyBinCount: number;
  getByteFrequencyData(array: Uint8Array): void;
  connect(destination: unknown): void;
}

/** The slice of `AudioContext` this module needs (adapter in browser glue). */
export interface PlayoutContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createBuffer(channels: number, frames: number, sampleRate: number): PlayoutBuffer;
  createBufferSource(): PlayoutSource;
  createAnalyser(): PlayoutAnalyser;
  decodeAudioData(data: ArrayBuffer): Promise<PlayoutBuffer>;
  /** Fill channel 0 of a buffer created by `createBuffer`. */
  fillMono(buffer: PlayoutBuffer, samples: Float32Array): void;
}

/** What the voice client drives. Times are on the context's absolute clock. */
export interface PlayoutSink {
  /** Schedule raw PCM immediately. Returns the absolute time it finishes. */
  playPcm16(samples: Int16Array, sampleRate: number): number;
  /** Decode a complete encoded clip and schedule it after everything queued. */
  playEncoded(bytes: Uint8Array): Promise<number>;
  /** Current absolute time — the same clock the returned end times use. */
  now(): number;
  /**
   * Resolves once nothing is scheduled ahead of the clock. Derived from the
   * timeline itself — one wake-up per remaining span, not a poll.
   */
  whenIdle(): Promise<void>;
  /** Stop every scheduled source and reset the timeline (barge-in / hang-up). */
  stop(): void;
  /** True while audio is scheduled at or beyond the current time. */
  readonly speaking: boolean;
  /**
   * Smoothed level of what is coming out of the speakers right now, 0..1.
   * Zero whenever nothing is scheduled — the Call Stage draws from this, and
   * an analyser tail after the last buffer would keep the shape talking.
   */
  outputLevel(): number;
}

export interface AbsolutePlayoutOptions {
  /**
   * How far ahead of `currentTime` a fresh schedule starts. Big enough that a
   * buffer is never scheduled in the past (which browsers play immediately,
   * overlapping whatever is already sounding), small enough to stay inside the
   * first-audio latency budget.
   */
  leadSeconds?: number;
  /** Sleep used by `whenIdle`. Injected in tests; `setTimeout` in the browser. */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_LEAD_SECONDS = 0.05;

export class AbsolutePlayout implements PlayoutSink {
  private readonly ctx: PlayoutContext;
  private readonly lead: number;
  private readonly delay: (ms: number) => Promise<void>;
  /**
   * Every source plays through this on the way to the destination, so the
   * measured level is the mix the user actually hears rather than a guess from
   * the bytes that were queued.
   */
  private readonly analyser: PlayoutAnalyser;
  /** Smoothed output level, 0..1. Advanced by `outputLevel`, not by a timer. */
  private level = 0;
  /** Absolute time the currently scheduled audio runs out. */
  private cursor = 0;
  private live: PlayoutSource[] = [];
  /** Serializes async decodes so segments schedule in arrival order. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: PlayoutContext, opts: AbsolutePlayoutOptions = {}) {
    this.ctx = ctx;
    this.lead = opts.leadSeconds ?? DEFAULT_LEAD_SECONDS;
    this.delay = opts.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.analyser = ctx.createAnalyser();
    this.analyser.connect(ctx.destination);
  }

  playPcm16(samples: Int16Array, sampleRate: number): number {
    if (samples.length === 0) return this.cursor;
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) floats[i] = (samples[i] ?? 0) / 32768;
    this.ctx.fillMono(buffer, floats);
    return this.schedule(buffer);
  }

  playEncoded(bytes: Uint8Array): Promise<number> {
    // A copy, because `decodeAudioData` detaches the ArrayBuffer it is given
    // and the caller's payload may be a view into the socket's read buffer.
    const copy = bytes.slice();
    const next = this.chain
      .then(() => this.ctx.decodeAudioData(copy.buffer as ArrayBuffer))
      .then((buffer) => this.schedule(buffer));
    // Keep the chain alive after a failed decode; the caller sees the rejection.
    this.chain = next.catch(() => undefined);
    return next;
  }

  now(): number {
    return this.ctx.currentTime;
  }

  async whenIdle(): Promise<void> {
    // Let any queued decode land first, so a segment still being decoded is
    // not mistaken for an empty timeline.
    await this.chain.catch(() => undefined);
    // One wait per remaining span. New audio arriving during the wait simply
    // extends the cursor and earns another (correct) wait.
    for (let guard = 0; guard < 1000; guard++) {
      const remainingMs = (this.cursor - this.ctx.currentTime) * 1000;
      if (remainingMs <= 0) return;
      await this.delay(remainingMs);
    }
  }

  get speaking(): boolean {
    return this.cursor > this.ctx.currentTime;
  }

  outputLevel(): number {
    // Nothing scheduled means silence, whatever the analyser's decay still
    // holds. Reset rather than smooth down, so the shape stops when the voice
    // does instead of trailing it.
    if (!this.speaking) {
      this.level = 0;
      return 0;
    }
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    // Voice energy concentrates low, so the first bins carry the envelope.
    const bins = Math.min(40, data.length);
    if (bins === 0) return this.level;
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += data[i] ?? 0;
    const raw = Math.min(1, (sum / bins / 255) * 1.9);
    this.level = smoothLevel(this.level, raw, CALL_MOTION.smoothing);
    return this.level;
  }

  stop(): void {
    for (const source of this.live) {
      try {
        source.stop();
      } catch {
        // Already stopped or never started — nothing to unwind.
      }
    }
    this.live = [];
    this.cursor = 0;
    this.level = 0;
    this.chain = Promise.resolve();
  }

  private schedule(buffer: PlayoutBuffer): number {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    // The whole point: continue the timeline when audio is still queued, and
    // only fall back to the clock when the queue has actually run dry.
    const startAt = Math.max(this.cursor, this.ctx.currentTime + this.lead);
    source.onended = () => {
      this.live = this.live.filter((s) => s !== source);
    };
    source.start(startAt);
    this.live.push(source);
    this.cursor = startAt + buffer.duration;
    return this.cursor;
  }
}
