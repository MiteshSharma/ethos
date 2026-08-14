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
}

const DEFAULT_SILENCE_FRAMES = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_PLAYBACK_WATCHDOG_MS = 120_000;

export class CaptureMachine {
  private state: CaptureState = 'idle';
  private muted = false;
  private silentRun = 0;
  private idleTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private lastWakeAt: number | null = null;

  private readonly silenceFrames: number;
  private readonly idleTimeoutMs: number;
  private readonly playbackWatchdogMs: number;

  constructor(
    private readonly deps: CaptureMachineDeps,
    config: CaptureMachineConfig = {},
  ) {
    this.silenceFrames = config.silenceFrames ?? DEFAULT_SILENCE_FRAMES;
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.playbackWatchdogMs = config.playbackWatchdogMs ?? DEFAULT_PLAYBACK_WATCHDOG_MS;
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
    this.silentRun = 0;
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
        this.deps.onAudio(frame);
        if (this.deps.vad.push(frame)) {
          this.silentRun = 0;
        } else {
          this.silentRun++;
          if (this.silentRun >= this.silenceFrames) this.endUtterance();
        }
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
    this.silentRun = 0;
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
      this.silentRun = 0;
      this.deps.engine.reset();
      this.transition('muted');
      return;
    }
    this.armListening();
  }

  // --- internals -------------------------------------------------------------

  /** Re-arm: forget engine state, clear the watchdog, start the idle clock. */
  private armListening(): void {
    this.clearWatchdog();
    this.silentRun = 0;
    this.deps.engine.reset();
    this.transition('listening');
    this.clearIdleTimer();
    this.idleTimer = this.deps.setTimer(() => {
      this.idleTimer = null;
      // Ends LISTENING and nothing else. There is no session here to end.
      if (this.state === 'listening') this.transition('idle');
    }, this.idleTimeoutMs);
  }

  private wake(match: WakeMatch): void {
    this.clearIdleTimer();
    this.lastWakeAt = this.deps.now();
    this.deps.engine.reset();
    this.silentRun = 0;
    this.transition('capturing');
    this.deps.onWake(match);
  }

  private endUtterance(): void {
    this.silentRun = 0;
    this.transition('thinking');
    this.deps.onUtteranceEnd();
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
