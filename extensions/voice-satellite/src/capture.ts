// The supervised capture state machine — the part that has to survive a
// thousand turns in a kitchen nobody is watching.
//
// The Hermes failure this exists to not repeat is "capture loop survives
// exactly one turn": the mic is armed, a wake fires, the agent answers, and the
// device is silent forever after because the re-arm depended on a callback that
// did not come. So re-arming is a state transition here, not a side effect —
// and the transition that guarantees it is the WATCHDOG, which fires when the
// host that was supposed to say "playback finished" never does.
//
// PURE LOGIC, NO DEVICE. Nothing in this file opens a microphone, imports an
// audio library, or reads a clock it was not given. The device pushes frames in
// and the machine says what to do with them; time arrives through injected
// timers so a test can drive five wake→speak→re-arm cycles in a millisecond.
//
// NO SESSION CONCEPT, DELIBERATELY. Eng-review D15 requires the idle timeout to
// end the LISTENING state and never the session. That criterion is satisfied
// STRUCTURALLY rather than by care: this machine has no session id, no lane
// key, no conversation state, and no callback that could end one. There is
// nothing here for a timeout to reset.
//
// NO PROCESS-GLOBAL STATE. Every field is instance state, so two satellites (or
// two tests) in one process cannot see each other.

import type { WakeEngine, WakeFrame, WakeMatch } from './wake-engine';

export type CaptureState =
  | 'idle'
  | 'listening'
  | 'capturing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'degraded';

export interface CaptureMachineDeps {
  engine: WakeEngine;
  vad: { push(frame: WakeFrame): boolean }; // true = speech present
  now(): number;
  /** Injected so tests drive time; never a bare setTimeout in the machine. */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /**
   * SPEECH STARTED HERE, and nothing has been sent about it yet.
   *
   * Local narration only — "the microphone heard something". Fires on every
   * VAD onset, including the chair scrapes that will be discarded a few
   * hundred milliseconds later, so a host may render it but MUST NOT put it on
   * a wire: that is what {@link onWake} is for, and the whole point of the two
   * being separate callbacks is that one of them is cheap and the other is not.
   *
   * Optional because a host with no indicator has nothing to do at onset —
   * omitting it means the utterance simply becomes visible at {@link onWake}.
   */
  onSpeechStart?(): void;
  /**
   * THIS UTTERANCE IS WORTH SENDING. Fires once the utterance has cleared
   * `minSpeechMs`, immediately before the held frames are flushed through
   * {@link onAudio} — so a host that opens a server-side utterance here is
   * opening one that has audio behind it and an end in front of it.
   *
   * Deliberately NOT fired at speech onset. See {@link CaptureMachine.wake}.
   */
  onWake(match: WakeMatch): void;
  onAudio(frame: WakeFrame): void;
  onUtteranceEnd(): void;
  onStateChange(state: CaptureState, detail?: string): void;
}

export interface CaptureMachineConfig {
  /**
   * Consecutive non-speech frames that end an utterance. The VAD's own
   * hangover smooths intra-word gaps; this is the pause that means "done".
   */
  silenceFrames?: number;
  /**
   * How long LISTENING waits without a wake before dropping to `idle`. The mic
   * stays armed in `idle` — see `pushFrame`.
   */
  idleTimeoutMs?: number;
  /**
   * How long `speaking` may last with no `endPlayback()` before the machine
   * re-arms itself. This is the bound on "the host died mid-playout and took
   * the microphone with it".
   */
  playbackWatchdogMs?: number;
  /**
   * How much SPEECH an utterance must accumulate before it is worth sending.
   * Below it the utterance is discarded locally — see `endUtterance`.
   */
  minSpeechMs?: number;
}

const DEFAULT_SILENCE_FRAMES = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_PLAYBACK_WATCHDOG_MS = 120_000;
/**
 * 400 ms of VAD-marked speech.
 *
 * A satellite watches an always-open pipe in a room, so the VAD firing on a
 * chair scrape, a cough, a door, or a keystroke burst is its STEADY STATE, not
 * an edge case. Those are impulses: one to five frames, 20–100 ms. The shortest
 * thing a person deliberately says to an agent ("stop", "yes") is voiced for
 * roughly 300 ms and usually more. 400 ms sits in the gap — above every impulse,
 * below every real request — and the two failure costs are asymmetric in its
 * favour: a discarded blip costs nothing, while a shipped blip costs an STT
 * call, a provider round trip, and a "could not transcribe" the user reads as
 * their own fault. Tune it with `minSpeechMs` if a deployment's one-word
 * commands land under the line.
 */
const DEFAULT_MIN_SPEECH_MS = 400;

export class CaptureMachine {
  private state: CaptureState = 'idle';
  private muted = false;
  private silentRun = 0;
  /**
   * Speech in the CURRENT utterance, in milliseconds.
   *
   * `silentRun` cannot answer this. It is a RUN counter — reset to zero by
   * every speech frame — so it measures the pause that ends an utterance and
   * says nothing about how much was said before it. Accumulated in ms rather
   * than frames because a frame is only a duration if you already know the
   * device's frame size, and the frames say so themselves.
   */
  private speechMs = 0;
  /**
   * Whether this utterance has cleared `minSpeechMs`. Until it does its frames
   * are HELD, not sent — see `emitAudio`.
   */
  private qualified = false;
  private held: WakeFrame[] = [];
  /**
   * The match that opened the CURRENT utterance, waiting for that utterance to
   * earn it. Null outside `capturing`, and null again the moment it is
   * released — see {@link emitAudio}.
   */
  private pendingWake: WakeMatch | null = null;
  private idleTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private lastWakeAt: number | null = null;

  private readonly silenceFrames: number;
  private readonly idleTimeoutMs: number;
  private readonly playbackWatchdogMs: number;
  private readonly minSpeechMs: number;

  constructor(
    private readonly deps: CaptureMachineDeps,
    config: CaptureMachineConfig = {},
  ) {
    this.silenceFrames = config.silenceFrames ?? DEFAULT_SILENCE_FRAMES;
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.playbackWatchdogMs = config.playbackWatchdogMs ?? DEFAULT_PLAYBACK_WATCHDOG_MS;
    this.minSpeechMs = config.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS;
  }

  /** Current state. Read by the host to fill the `state` protocol frame. */
  getState(): CaptureState {
    return this.state;
  }

  /** Epoch-ms of the last wake, or null. Feeds the "last wake event" row. */
  getLastWakeAt(): number | null {
    return this.lastWakeAt;
  }

  /** Arm the machine. Frames pushed before this are dropped. */
  start(): void {
    if (this.muted) {
      this.transition('muted');
      return;
    }
    this.armListening();
  }

  /** Disarm. Clears every timer so a stopped machine schedules nothing. */
  stop(): void {
    this.clearIdleTimer();
    this.clearWatchdog();
    this.resetCapture();
    this.transition('idle');
  }

  /**
   * Feed one captured frame.
   *
   * The self-wake gate is here and it is a DROP, not a filter: in `speaking`
   * the frame never reaches `engine.push()` at all. Feeding the engine and
   * ignoring its match would leave the wake decision one refactor away from
   * being honoured, and the agent hearing its own sign-off and waking itself is
   * the exact bug the suppression exists for.
   */
  pushFrame(frame: WakeFrame): void {
    switch (this.state) {
      case 'speaking':
      case 'muted':
      case 'thinking':
      case 'degraded':
        return;
      case 'idle':
      case 'listening': {
        // The mic stays armed in `idle`. `idle` reports "nothing has happened
        // here for a while" to the UI; it does not mean deaf. A satellite that
        // stopped listening on a timeout would need a human to walk over and
        // restart it, which is the opposite of ambient.
        const match = this.deps.engine.push(frame);
        if (match !== null) this.wake(match);
        return;
      }
      case 'capturing': {
        const speech = this.deps.vad.push(frame);
        if (speech) {
          this.speechMs += frameMs(frame);
          this.silentRun = 0;
        } else {
          this.silentRun++;
        }
        this.emitAudio(frame);
        if (!speech && this.silentRun >= this.silenceFrames) this.endUtterance();
        return;
      }
    }
  }

  /**
   * The host has started playing the reply. Suppression begins now and the
   * watchdog starts counting.
   */
  beginPlayback(): void {
    if (this.muted) return;
    this.clearIdleTimer();
    this.resetCapture();
    this.transition('speaking');
    this.clearWatchdog();
    this.watchdogTimer = this.deps.setTimer(() => {
      this.watchdogTimer = null;
      // The host never reported playback finishing. Rather than leave the mic
      // parked, say plainly that the machine is degraded and why, then re-arm:
      // an ambient listener that is silently deaf is worse than one that is
      // noisily imperfect.
      this.transition(
        'degraded',
        `playback watchdog fired after ${this.playbackWatchdogMs}ms with no endPlayback() — ` +
          `re-arming the microphone without a playback-done receipt`,
      );
      this.armListening();
    }, this.playbackWatchdogMs);
  }

  /** The speaker has gone quiet. Verified re-arm: the mic is live again. */
  endPlayback(): void {
    this.clearWatchdog();
    if (this.muted) {
      this.transition('muted');
      return;
    }
    this.armListening();
  }

  /** Operator mute. Frames are dropped and the engine forgets partial state. */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) {
      this.clearIdleTimer();
      this.clearWatchdog();
      this.resetCapture();
      this.deps.engine.reset();
      this.transition('muted');
      return;
    }
    this.armListening();
  }

  // --- internals -------------------------------------------------------------

  /** Re-arm: forget engine state, clear the watchdog, start the idle clock. */
  private armListening(detail?: string): void {
    this.clearWatchdog();
    this.resetCapture();
    this.deps.engine.reset();
    this.transition('listening', detail);
    this.clearIdleTimer();
    this.idleTimer = this.deps.setTimer(() => {
      this.idleTimer = null;
      // Ends LISTENING and nothing else. There is no session here to end.
      if (this.state === 'listening') this.transition('idle');
    }, this.idleTimeoutMs);
  }

  /**
   * Speech started. The utterance opens LOCALLY and nothing goes upstream yet.
   *
   * WHY THE WAKE IS HELD. It used to fire here, and the argument for that was
   * latency: tell the server the moment the room makes a noise and the turn is
   * already in flight by the time the words arrive. That argument died with the
   * `minSpeechMs` floor. An energy VAD on an always-open microphone fires on
   * chair scrapes, coughs, doors and keystrokes as its STEADY STATE, and the
   * floor discards those LOCALLY — so every one of them was announcing a wake
   * and opening a server-side utterance that no `audio` and no `utterance_end`
   * would ever follow. The lane held each one until a later utterance
   * superseded it or the connection dropped; nothing ever closed them, and each
   * cost a `wake` frame, an `utterance_start`, a routing-table read and a row
   * on somebody's Settings page for a door closing.
   *
   * Nothing is bought by the early send either: the frames are held anyway
   * (`emitAudio`), so the server has no audio to work on until qualification
   * regardless. Holding the wake to the same instant costs the turn nothing and
   * makes an unqualified utterance completely invisible upstream — which is
   * what "discarded locally" was always supposed to mean.
   */
  private wake(match: WakeMatch): void {
    this.clearIdleTimer();
    this.deps.engine.reset();
    this.resetCapture();
    this.pendingWake = match;
    this.transition('capturing');
    this.deps.onSpeechStart?.();
  }

  /**
   * Forward one captured frame — or HOLD it until the utterance has earned it.
   *
   * Held rather than dropped: the leading frames are where the first word is,
   * and an utterance that qualifies half a second in must still be transcribed
   * from its beginning. The flush replays them in order, so a host that streams
   * upstream sees exactly the frames it would have seen, one threshold late.
   *
   * The hold is bounded by the endpointer, not by hope: every non-speech frame
   * advances `silentRun`, so an utterance that never reaches `minSpeechMs` ends
   * after at most `silenceFrames` consecutive quiet frames per speech frame it
   * did contain — tens of kilobytes, then discarded.
   *
   * THIS IS ALSO WHERE THE WAKE IS RELEASED, in front of the flush and in the
   * same turn of the loop. The order is load-bearing: a host sends `wake` and
   * `utterance_start` from `onWake` and the PCM from `onAudio`, and audio for
   * an utterance the server has not been told about is audio the server drops.
   */
  private emitAudio(frame: WakeFrame): void {
    if (this.qualified) {
      this.deps.onAudio(frame);
      return;
    }
    this.held.push(frame);
    if (this.speechMs < this.minSpeechMs) return;
    this.qualified = true;
    const match = this.pendingWake;
    this.pendingWake = null;
    if (match !== null) {
      // Recorded at RELEASE, not at onset. `lastWakeAt` feeds a "last wake
      // event" row, and an onset the floor discarded is not an event — dating
      // the row from one would have the Settings page report a wake for every
      // chair scrape in the room.
      this.lastWakeAt = this.deps.now();
      this.deps.onWake(match);
    }
    const held = this.held;
    this.held = [];
    for (const pending of held) this.deps.onAudio(pending);
  }

  /**
   * The endpointer fired. Either the utterance goes upstream, or it never
   * happened.
   *
   * THE DISCARD IS THE POINT. An energy VAD watching a room triggers on noise
   * indefinitely; shipping each of those blips costs an STT call and comes back
   * as "could not transcribe audio — try again", which reads to the user as
   * something they did wrong when they did not speak at all. So an utterance
   * that never accumulated `minSpeechMs` of speech is dropped HERE — no
   * `onWake` and no `onAudio` were ever called for it (both are held until
   * qualification), no `onUtteranceEnd` is called now, and nothing upstream
   * learns it existed. "Nothing upstream" is literal: not even a wake.
   *
   * It re-arms through `armListening`, the same transition a completed turn
   * takes, so a discard can never wedge the machine — and it carries a detail
   * the host may narrate, which is why the discard rides `onStateChange`
   * rather than a callback of its own.
   */
  private endUtterance(): void {
    if (!this.qualified) {
      const speech = Math.round(this.speechMs);
      this.armListening(
        `discarded utterance: ${speech}ms of speech, under the ${this.minSpeechMs}ms minimum — ` +
          `room noise rather than a request, so nothing was sent`,
      );
      return;
    }
    this.resetCapture();
    this.transition('thinking');
    this.deps.onUtteranceEnd();
  }

  /** Forget the in-flight utterance: its endpointing, its speech, its frames. */
  private resetCapture(): void {
    this.silentRun = 0;
    this.speechMs = 0;
    this.qualified = false;
    this.held = [];
    // The unreleased wake goes with them. It belongs to the utterance being
    // forgotten, and a wake that outlived its utterance would be announced
    // against the next one.
    this.pendingWake = null;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    this.deps.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer === null) return;
    this.deps.clearTimer(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /**
   * `degraded` is reported as a transition and then left behind — the machine
   * re-arms through it rather than parking in it. The host forwards the detail
   * upstream so the Settings row can say which supervision failed; parking here
   * would trade an honest row for a dead microphone.
   */
  private transition(state: CaptureState, detail?: string): void {
    this.state = state;
    this.deps.onStateChange(state, detail);
  }
}

/**
 * How long one frame lasts. Read off the frame, never assumed from a config —
 * the device decides its own frame size, and a machine that guessed would
 * mis-measure speech on every host but the one it was tuned on. The zero check
 * is for the accumulator: `0 / 0` is NaN, and NaN in `speechMs` makes every
 * comparison false, which is a microphone that discards everything forever.
 */
function frameMs(frame: WakeFrame): number {
  return frame.sampleRate > 0 ? (frame.samples.length / frame.sampleRate) * 1000 : 0;
}
