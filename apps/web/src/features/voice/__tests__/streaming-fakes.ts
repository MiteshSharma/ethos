import type { VoiceClientFrame, VoiceServerFrame } from '@ethosagent/web-contracts';
import type { EndpointerEvent } from '../pcm-endpointer';
import type { VoiceCaptureIo } from '../streaming-voice-call-client';
import type { VoiceTransport, VoiceTransportStatus } from '../voice-socket-transport';
import type { PlayoutSink } from '../webaudio-playout';

/** A transport the test drives from both ends. */
export class FakeVoiceTransport implements VoiceTransport {
  readonly sent: Array<{ frame: VoiceClientFrame; payload: Uint8Array }> = [];
  status: VoiceTransportStatus = 'closed';
  closed = false;
  private readonly frameListeners = new Set<
    (frame: VoiceServerFrame, payload: Uint8Array) => void
  >();
  private readonly statusListeners = new Set<(status: VoiceTransportStatus) => void>();

  connect(): Promise<void> {
    this.status = 'open';
    return Promise.resolve();
  }

  send(frame: VoiceClientFrame, payload?: Uint8Array): void {
    this.sent.push({ frame, payload: payload ?? new Uint8Array() });
  }

  on(listener: (frame: VoiceServerFrame, payload: Uint8Array) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  onStatus(listener: (status: VoiceTransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.status = 'closed';
  }

  /** Deliver a server frame to the client. */
  deliver(frame: VoiceServerFrame, payload: Uint8Array = new Uint8Array()): void {
    for (const listener of [...this.frameListeners]) listener(frame, payload);
  }

  /** Simulate a transport-level status change (e.g. the socket dropping). */
  setStatus(status: VoiceTransportStatus): void {
    this.status = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  frames(kind: VoiceClientFrame['t']): VoiceClientFrame[] {
    return this.sent.filter((s) => s.frame.t === kind).map((s) => s.frame);
  }
}

/** A capture seam the test pushes endpointer events into. */
export class FakeVoiceCapture implements VoiceCaptureIo {
  readonly sampleRate = 16_000;
  started = false;
  stopped = false;
  captureEnabled = true;
  bargeEnabled = false;
  micEnabled = true;
  earcons = 0;
  private readonly listeners = new Set<(event: EndpointerEvent) => void>();

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  micStream(): MediaStream | null {
    return null;
  }

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled;
  }

  setCaptureEnabled(enabled: boolean): void {
    this.captureEnabled = enabled;
  }

  setBargeInEnabled(enabled: boolean): void {
    this.bargeEnabled = enabled;
  }

  playEarcon(): void {
    this.earcons++;
  }

  on(listener: (event: EndpointerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: EndpointerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** speech_start → one frame → speech_end, the shape of a real utterance. */
  speakUtterance(data = Int16Array.from([1000, -1000])): void {
    this.emit({ type: 'speech_start' });
    this.emit({ type: 'frame', data });
    this.emit({ type: 'speech_end' });
  }
}

/** A playout sink with a hand-cranked clock that records what it was asked to play. */
export class FakePlayout implements PlayoutSink {
  clock = 0;
  readonly pcm: Array<{ samples: number; sampleRate: number }> = [];
  readonly encoded: Uint8Array[] = [];
  stops = 0;
  private cursor = 0;
  /** Seconds a scheduled clip is assumed to last. */
  clipSeconds = 1;

  playPcm16(samples: Int16Array, sampleRate: number): number {
    this.pcm.push({ samples: samples.length, sampleRate });
    this.cursor = Math.max(this.cursor, this.clock) + samples.length / sampleRate;
    return this.cursor;
  }

  playEncoded(bytes: Uint8Array): Promise<number> {
    this.encoded.push(bytes);
    this.cursor = Math.max(this.cursor, this.clock) + this.clipSeconds;
    return Promise.resolve(this.cursor);
  }

  now(): number {
    return this.clock;
  }

  whenIdle(): Promise<void> {
    if (this.cursor <= this.clock) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private idleWaiters: Array<() => void> = [];

  stop(): void {
    this.stops++;
    this.cursor = 0;
    this.wakeIdle();
  }

  get speaking(): boolean {
    return this.cursor > this.clock;
  }

  /** Move the clock to the end of everything scheduled. */
  finishAll(): void {
    this.clock = this.cursor;
    this.wakeIdle();
  }

  private wakeIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
