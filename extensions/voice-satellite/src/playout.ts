// The playout side of a wake turn — the half that lets a satellite ANSWER OUT
// LOUD instead of printing the answer and calling it a reply.
//
// PURE LOGIC, NO DEVICE, exactly as `capture.ts` is. Nothing here opens a
// speaker, spawns a player, or reads a clock it was not given: the host hands
// in a `PlaybackDevice` and injected timers, and this file decides what to feed
// it, what to drop, and — the load-bearing part — WHEN THE MICROPHONE MAY COME
// BACK.
//
// WHY `playback_done` MOVED. It used to be sent the instant `turn_end` landed,
// which was honest only on a host with no loudspeaker: the frame means "the
// speaker has gone quiet and I am listening again", and a node that has just
// queued four seconds of audio is not listening again. Sending it early re-arms
// the microphone into the agent's own voice — the exact self-wake the capture
// machine's suppression window exists to prevent. So the receipt now waits for
// the device's `end()` to resolve, which is the only thing in the system that
// knows the speaker actually stopped.
//
// AND WHY THERE IS STILL A WATCHDOG. A player that never drains — an `ffplay`
// that wedged, a USB speaker unplugged mid-sentence, a sound server that went
// away — would then hold the microphone shut forever, which is the one failure
// this lane refuses to have. The drain watchdog re-arms anyway and SAYS it did,
// the same trade `CaptureMachine`'s playback watchdog makes: an ambient
// listener that is silently deaf is worse than one that is noisily imperfect.
//
// STALENESS IS A DROP, NOT A QUEUE. Audio for an utterance that is no longer
// the one in flight is not late audio, it is audio for a question nobody is
// still asking — so it is discarded rather than played after whatever replaced
// it.

import type { PlaybackDevice, PlaybackFormat } from './audio-device';
import type { SatellitePlayoutEvent } from './node-client';

/**
 * The rate a `pcm_s16le` playout falls back to when the lane names none.
 *
 * The wire fields are optional and the server leaves them unset, because no
 * `TtsProvider` reports the sample rate of the bytes it produced. 24 kHz is the
 * same fallback the browser talk-mode client uses (`DEFAULT_TTS_SAMPLE_RATE`),
 * so the two surfaces guess identically rather than each inventing a number.
 */
export const DEFAULT_PLAYOUT_SAMPLE_RATE = 24_000;

/**
 * How long `end()` may take before the microphone comes back anyway.
 *
 * Deliberately BELOW `CaptureMachine`'s 120 s playback watchdog. Both would
 * eventually re-arm the node, but only this one knows the reason was the
 * PLAYER; letting the generic supervision fire first would trade a specific
 * diagnosis ("the player never reported draining") for a vague one ("no
 * endPlayback() in two minutes").
 */
export const DEFAULT_PLAYOUT_DRAIN_WATCHDOG_MS = 90_000;

/** Why a playout said something. All three degrade to text; none is fatal. */
export interface PlayoutProblem {
  utteranceId: string;
  /**
   * `start` — the device would not open (a codec it cannot play, a player that
   * is not there). `drain` — it opened and then failed on the way out.
   * `watchdog` — it never came back at all, and the microphone was re-armed
   * without a receipt.
   */
  kind: 'start' | 'drain' | 'watchdog';
  reason: string;
}

export interface SatellitePlayoutDeps {
  device: PlaybackDevice;
  /** Injected so tests drive time; never a bare setTimeout in here. */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /**
   * THE SPEAKER IS QUIET AND THE TURN IS OVER — send `playback_done` and re-arm.
   *
   * Fires exactly once per utterance that reached `turn_end`, including the
   * utterances nothing was ever played for (a text-only reply, a sentence
   * addressed to nobody, a host with no loudspeaker): those satisfy "the
   * speaker has gone quiet" trivially, and a host that waited for a playout
   * that was never coming would deafen itself on every unaddressed sentence.
   *
   * `timedOut` is the drain watchdog admitting it gave up. The host still
   * re-arms; it just does not get to claim the receipt was earned.
   */
  onDone(done: { utteranceId: string; timedOut: boolean }): void;
  /** Narration seam. Optional — a host with nowhere to print says nothing. */
  onProblem?(problem: PlayoutProblem): void;
  drainWatchdogMs?: number;
}

/** The one playout in flight. Single, for the same reason `InFlightUtterance` is. */
interface ActivePlayout {
  utteranceId: string;
  /**
   * Serializes start → writes → end on the device.
   *
   * `write` is synchronous on the seam but `start` is not, and a chunk written
   * before the device is open is a chunk played into nothing. The chain is what
   * makes "resolves when the device is ready for frames" mean something.
   */
  chain: Promise<void>;
  /** The device failed. Further chunks are dropped rather than retried. */
  broken: boolean;
  /** `end()` has been issued; a second `turn_end` must not issue another. */
  ending: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drive one `PlaybackDevice` from the server's playout frames.
 *
 * Owns nothing else: the host still sends `playback_done` and still calls
 * `CaptureMachine.endPlayback()`. It does both from {@link
 * SatellitePlayoutDeps.onDone} instead of from `turn_end`, which is the whole
 * change — the suppression window now ends when the room goes quiet rather than
 * when the wire says the words are known.
 */
export class SatellitePlayout {
  private active: ActivePlayout | null = null;
  private watchdogTimer: unknown = null;
  private readonly drainWatchdogMs: number;

  constructor(private readonly deps: SatellitePlayoutDeps) {
    this.drainWatchdogMs = deps.drainWatchdogMs ?? DEFAULT_PLAYOUT_DRAIN_WATCHDOG_MS;
  }

  /** True while audio is being fed to the device. Read by the host's narration. */
  isPlaying(): boolean {
    return this.active !== null;
  }

  /** One server playout frame, flattened by the client. Never throws. */
  handle(event: SatellitePlayoutEvent): void {
    switch (event.type) {
      case 'speak_start':
        this.onSpeakStart(event);
        return;
      case 'audio':
        this.onAudio(event.utteranceId, event.payload);
        return;
      case 'segment_end':
        // Nothing. The DEVICE is per-utterance, not per-segment: a sentence
        // boundary is a synthesis unit, and stopping the speaker at each one
        // would insert a gap the server did not intend.
        return;
      case 'turn_end':
        this.onTurnEnd(event.utteranceId);
        return;
    }
  }

  /**
   * Barge-in, hang-up, shutdown: drop what is queued and do NOT drain it.
   *
   * `cancel()` on the device, never `end()`. `end()` MEANS "the buffer emptied",
   * and the entire point of a barge-in is that it did not — a host that called
   * `end()` here would be waiting on the very audio it just decided the room
   * should not hear.
   *
   * No `onDone` either: cancelling does not close a turn. The `turn_end` for
   * this utterance still arrives, finds no active playout, and re-arms then.
   */
  cancel(): void {
    const active = this.active;
    if (active === null) return;
    this.active = null;
    this.clearWatchdog();
    try {
      this.deps.device.cancel(active.utteranceId);
    } catch {
      // A device that cannot even be cancelled has nothing left to tell us, and
      // the host is already re-arming. Swallowed rather than surfaced as a
      // playout problem the operator can do nothing about.
    }
  }

  private onSpeakStart(event: Extract<SatellitePlayoutEvent, { type: 'speak_start' }>): void {
    const active = this.active;
    if (active !== null && active.utteranceId === event.utteranceId) {
      // A later SEGMENT of the utterance already playing. The device is open
      // and the format has not changed; re-opening it would cut the sentence
      // that is mid-air.
      return;
    }
    // A different utterance while one is playing IS a barge-in — the server
    // moved on, and two answers overlapping in one room is worse than a
    // truncated one.
    if (active !== null) this.cancel();

    const format: PlaybackFormat = {
      sampleRate: event.sampleRate ?? DEFAULT_PLAYOUT_SAMPLE_RATE,
      channels: event.channels ?? 1,
      codec: event.codec,
      mimeType: event.mimeType,
    };
    const state: ActivePlayout = {
      utteranceId: event.utteranceId,
      chain: Promise.resolve(),
      broken: false,
      ending: false,
    };
    this.active = state;
    state.chain = this.deps.device.start(event.utteranceId, format).catch((err: unknown) => {
      state.broken = true;
      this.report({ utteranceId: event.utteranceId, kind: 'start', reason: errorMessage(err) });
    });
  }

  private onAudio(utteranceId: string, payload: Uint8Array): void {
    const active = this.active;
    // STALENESS DISCIPLINE, and the only place it is enforced on the way in:
    // audio whose utterance is not the one in flight is dropped here rather
    // than handed to a device that would have to know to refuse it.
    if (active === null || active.utteranceId !== utteranceId) return;
    if (active.broken || active.ending) return;
    active.chain = active.chain.then(() => {
      // Re-checked INSIDE the chain: `start()` is asynchronous, so an utterance
      // can be superseded between the frame arriving and the device being ready.
      if (active.broken || this.active !== active) return;
      try {
        this.deps.device.write(utteranceId, payload);
      } catch (err) {
        active.broken = true;
        this.report({ utteranceId, kind: 'drain', reason: errorMessage(err) });
      }
    });
  }

  private onTurnEnd(utteranceId: string): void {
    const active = this.active;
    if (active === null || active.utteranceId !== utteranceId) {
      // Nothing was played for this utterance. The speaker is quiet by
      // construction, so the receipt is honest immediately — this is the path
      // every unaddressed sentence and every text-only reply takes.
      this.finish(utteranceId, false);
      return;
    }
    if (active.ending) return;
    active.ending = true;

    this.clearWatchdog();
    this.watchdogTimer = this.deps.setTimer(() => {
      this.watchdogTimer = null;
      if (this.active !== active) return;
      this.active = null;
      this.report({
        utteranceId,
        kind: 'watchdog',
        reason:
          `the player did not report the speaker draining within ${this.drainWatchdogMs}ms — ` +
          `re-arming the microphone without a drained playout`,
      });
      this.finish(utteranceId, true);
    }, this.drainWatchdogMs);

    active.chain = active.chain
      .then(async () => {
        // A device that never opened has nothing to drain, and asking it to
        // would be asking a failure to report a second one.
        if (active.broken) return;
        await this.deps.device.end(utteranceId);
      })
      .then(
        () => this.settle(active, utteranceId),
        (err: unknown) => {
          this.report({ utteranceId, kind: 'drain', reason: errorMessage(err) });
          this.settle(active, utteranceId);
        },
      );
  }

  /** The device came back. Re-arm — unless the watchdog got here first. */
  private settle(active: ActivePlayout, utteranceId: string): void {
    if (this.active !== active) return;
    this.active = null;
    this.clearWatchdog();
    this.finish(utteranceId, false);
  }

  private finish(utteranceId: string, timedOut: boolean): void {
    try {
      this.deps.onDone({ utteranceId, timedOut });
    } catch {
      // The host's re-arm threw. There is nowhere left to report to, and
      // library code does not write to the console.
    }
  }

  private report(problem: PlayoutProblem): void {
    try {
      this.deps.onProblem?.(problem);
    } catch {
      // Same blast wall as `node-client`: a narration handler that throws must
      // not take the playout — or the microphone behind it — down with it.
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer === null) return;
    this.deps.clearTimer(this.watchdogTimer);
    this.watchdogTimer = null;
  }
}
