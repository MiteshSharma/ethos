// Buffered voice-turn span writer.
//
// Voice spans must NEVER be written inline on the turn/audio path. The store
// behind them is synchronous SQLite (`@ethosagent/sqlite` wraps `node:sqlite`,
// which has no async I/O) — a write from `pushAudio` or a `reply_audio` handler
// blocks the very event loop that paces audio frames, and the audible symptom
// is a stutter, not a slow query. So `record()` only appends to an in-memory
// buffer; the sink is called from a timer and from `close()`, both off the
// turn path.
//
// The buffer is bounded and drops the OLDEST spans when full: telemetry that
// grows without limit turns a provider outage into an OOM. A hard crash loses
// at most the last flush window, which is the accepted trade for telemetry.

/** Stage of a voice turn a span measures. */
export type VoiceSpanStage =
  /** Committed utterance audio → transcript. */
  | 'stt'
  /** Turn start → first spoken sentence flushed to synthesis. */
  | 'llm_first_sentence'
  /** Turn start → first synthesized audio frame emitted. */
  | 'tts_first_audio'
  /** The whole turn: utterance committed → reply finished (or interrupted). */
  | 'turn';

export interface VoiceTurnSpan {
  /** Utterance this span belongs to — spans of one turn share it. */
  turnId: string;
  stage: VoiceSpanStage;
  startTs: number;
  endTs: number;
  status: 'ok' | 'error' | 'interrupted';
  /** The STT provider that ACTUALLY ran, not the one config asked for. */
  sttProvider?: string;
  /** The TTS provider that ACTUALLY ran. */
  ttsProvider?: string;
  /** Lane/session this turn belonged to, when the caller knows it. */
  laneKey?: string;
  error?: string;
}

/** Where flushed spans go. Implementations may block; they are called off the audio path. */
export interface VoiceSpanSink {
  write(spans: VoiceTurnSpan[]): void | Promise<void>;
}

export interface BufferedVoiceSpanWriterOptions {
  sink: VoiceSpanSink;
  /** Flush cadence in ms. 0 disables the timer (flush only on `close()`). Default 5000. */
  flushIntervalMs?: number;
  /** Max spans held in memory; oldest are dropped past it. Default 512. */
  maxBuffered?: number;
  /** Called when the bound forces a drop, with the running dropped count. */
  onDrop?: (droppedTotal: number) => void;
  /** Called when the sink throws. Never rethrown — telemetry cannot break a call. */
  onError?: (err: unknown) => void;
}

export class BufferedVoiceSpanWriter {
  private readonly sink: VoiceSpanSink;
  private readonly flushIntervalMs: number;
  private readonly maxBuffered: number;
  private readonly onDrop: ((droppedTotal: number) => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;

  private buffer: VoiceTurnSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private droppedTotal = 0;

  constructor(opts: BufferedVoiceSpanWriterOptions) {
    this.sink = opts.sink;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000;
    this.maxBuffered = opts.maxBuffered ?? 512;
    this.onDrop = opts.onDrop;
    this.onError = opts.onError;
  }

  /** Spans dropped so far because the buffer was full. */
  get dropped(): number {
    return this.droppedTotal;
  }

  /** Spans currently buffered (not yet handed to the sink). */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Append a span. Synchronous, allocation-only, and NEVER touches the sink —
   * this is the method the audio path calls.
   */
  record(span: VoiceTurnSpan): void {
    if (this.closed) return;
    this.buffer.push(span);
    if (this.buffer.length > this.maxBuffered) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffered);
      this.droppedTotal += 1;
      this.onDrop?.(this.droppedTotal);
    }
    this.ensureTimer();
  }

  /** Hand everything buffered to the sink. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const run = (async () => {
      try {
        await this.sink.write(batch);
      } catch (err) {
        this.onError?.(err);
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  /** Final flush + stop the timer. Called on session end. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private ensureTimer(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Never hold the process open for telemetry.
    this.timer.unref?.();
  }
}
