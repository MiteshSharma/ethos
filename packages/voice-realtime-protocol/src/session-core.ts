// Everything a realtime session does that is NOT provider vocabulary: own the
// socket, own the event stream, buffer outbound audio until the provider has
// confirmed the session, and guarantee exactly one terminal `closed` event.
//
// The two providers differ only in what they write and how they decode — that
// half is a `RealtimeProtocolCodec` (`./codec`), and `createRealtimeProtocolSession`
// (`./session`) is the two bolted together. If this bookkeeping lived in each
// provider it would drift, and the half that drifted would be the half nobody
// exercises (Gemini) — which is precisely the failure the shared conformance
// suite exists to catch.

import type { RealtimeEvent } from '@ethosagent/types';
import { RealtimeEventQueue } from './event-queue';
import type { RealtimeSocket, RealtimeSocketFactory, RealtimeSocketInit } from './socket';

/**
 * Outbound audio frames held while the provider handshake is in flight.
 *
 * 64 frames is ~1.3 s of speech at the 20 ms frames the browser lane captures —
 * comfortably more than a handshake round trip, and small enough that a session
 * that never confirms cannot grow unbounded.
 */
export const MAX_PENDING_AUDIO_FRAMES = 64;

export interface RealtimeSessionCoreOptions {
  socketFactory: RealtimeSocketFactory;
  init: RealtimeSocketInit;
  /** Provider handshake. Called once, as soon as the transport is open. */
  handshake(): void;
  /** Decode one provider text frame. Emit results with {@link RealtimeSessionCore.emit}. */
  decode(raw: string): void;
  signal?: AbortSignal;
}

export class RealtimeSessionCore {
  private readonly queue = new RealtimeEventQueue();
  private readonly pending: string[] = [];
  private socket: RealtimeSocket | undefined;
  private ready = false;
  private closed = false;

  constructor(private readonly opts: RealtimeSessionCoreOptions) {}

  get events(): AsyncIterable<RealtimeEvent> {
    return this.queue;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Open the transport and send the handshake. Resolves once the socket is
   * open; rejects if it errors or closes first, so `provider.open()` rejects
   * rather than handing back a session that will never speak.
   */
  connect(): Promise<void> {
    if (this.opts.signal?.aborted) {
      return Promise.reject(new Error('realtime session aborted before connect'));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.socket = this.opts.socketFactory(this.opts.init, {
        onOpen: () => {
          if (settled) return;
          settled = true;
          this.opts.handshake();
          this.bindAbort();
          resolve();
        },
        onMessage: (raw) => {
          if (this.closed) return;
          this.opts.decode(raw);
        },
        onError: (message) => {
          if (!settled) {
            settled = true;
            reject(new Error(`realtime socket failed: ${message}`));
            return;
          }
          this.emit({ type: 'error', error: message, code: 'transport_error' });
        },
        onClose: (reason) => {
          if (!settled) {
            settled = true;
            reject(new Error(`realtime socket closed before open: ${reason}`));
            return;
          }
          this.finish(reason);
        },
      });
    });
  }

  emit(event: RealtimeEvent): void {
    if (this.closed) return;
    this.queue.push(event);
  }

  /** The provider confirmed the session. Flush whatever the caller queued. */
  markReady(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    for (const frame of this.pending.splice(0)) {
      this.socket?.send(frame);
    }
  }

  /** Write now. For control messages that can only follow a session event. */
  sendJson(message: unknown): void {
    if (this.closed) return;
    this.socket?.send(JSON.stringify(message));
  }

  /**
   * Write once the provider has confirmed the session, preserving order.
   *
   * Captured audio arrives on a fixed cadence that does not wait for a
   * handshake, and both providers reject media sent before their session is
   * established. Dropping those frames would clip the first word of the first
   * utterance, so they queue. On overflow the OLDEST frame is dropped — the
   * newest audio is the audio the user is still speaking — and an `error` event
   * is emitted, because silently discarding the microphone is the failure mode
   * nobody notices until a transcript is missing a sentence.
   */
  sendWhenReady(message: unknown): void {
    if (this.closed) return;
    if (this.ready) {
      this.socket?.send(JSON.stringify(message));
      return;
    }
    if (this.pending.length >= MAX_PENDING_AUDIO_FRAMES) {
      this.pending.shift();
      this.emit({
        type: 'error',
        error:
          `dropped the oldest queued audio frame — more than ${MAX_PENDING_AUDIO_FRAMES} ` +
          'frames arrived before the provider confirmed the session',
        code: 'audio_buffer_overflow',
      });
    }
    this.pending.push(JSON.stringify(message));
  }

  async close(): Promise<void> {
    const alreadyClosed = this.closed;
    this.finish('client_closed');
    if (!alreadyClosed) this.socket?.close(1000, 'client closed');
  }

  private bindAbort(): void {
    const signal = this.opts.signal;
    if (!signal) return;
    signal.addEventListener('abort', () => void this.close(), { once: true });
  }

  /**
   * Terminal. Emitted from exactly one place so a client close racing a
   * transport close cannot produce two `closed` events or an event after the
   * iterator has completed.
   */
  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.queue.push({ type: 'closed', reason });
    this.queue.end();
  }
}
