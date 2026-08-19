// CallCaptureDaemon — the Phase 4 orchestrator that wires Phases 1-3 (and
// the T5 combined preflight) together end-to-end (plan/phases/
// call-capture-extension.md, "Phase 4 — Integration"). Owns exactly one call
// lifecycle at a time: detector event → preflight → notification (accept
// gate) → direct capture dispatch → clean cancellation on call end.
//
// PROCESS GATING: there is deliberately no separate "is a known calling app
// running" check in this file (there used to be, wired via a
// `checkCallingAppRunning` port — since removed). The native detector
// (`native/mic-detector.swift`, wrapped by `detector.ts`) now only ever
// watches known calling apps in the first place, so a `call_started` event
// is already scoped to one by construction; its `source` field names which
// app triggered it. See `process-prefilter.ts`'s header comment for the
// full "why this was folded in" story.
//
// APPROVAL: the OS notification click IS the human-approval event for this
// flow. `runCallCapture()` (`@ethosagent/tools-callcapture`) is a plain
// function, never a registered `Tool` — there is no LLM-initiated
// `before_tool_call` approval gate to route through at all, because no
// ordinary chat turn can ever reach it. Decision 5 of the plan already
// requires an accepted notification before capture ever starts; this daemon
// IS that gate, and dispatches into the capture pipeline directly once a
// click is accepted.
//
// CANCELLATION: this daemon creates a fresh `AbortController` per accepted
// call and passes its signal straight into `runCapture(abortSignal)`, which
// the caller binds to `runCallCapture()` (`extensions/tools-callcapture/
// src/index.ts` already awaits the signal to stop both capture streams and
// save whatever was captured). The daemon aborts the controller on
// `call_ended` — a real signal-driven mechanism, and (as of the per-process
// detection fix) ALSO on a bounded `maxCaptureDurationMs` safety-net timer
// (default 4 hours) that fires if `call_ended` never arrives. This is
// deliberately a safety net UNDER the real signal, never a substitute for
// it — see README.md's "Per-process detection" section for why: testing
// this fix found at least one real, currently-running calling-app process
// whose own per-process CoreAudio "running input" flag stayed warm with no
// confirmable active call, the same class of symptom the device-wide flag
// had. The precise per-process signal is still a strict improvement (proven
// correct at the mechanism level — see README), but this bounded timer
// exists so that if ANY watched app's signal gets stuck warm for whatever
// reason, a capture still cannot run "unattended indefinitely," which is
// the exact original bug this whole redesign exists to fix.
//
// Structural ports throughout, mirroring `detector.ts`/`notification.ts`'s
// idiom: real code is wired by the caller (`apps/ethos/src/commands/
// serve.ts`) from `MicActivityDetector`/`NotificationGate`/
// `checkCallCaptureDependencies`/a bound `runCallCapture()`; tests inject
// fakes and never touch real hardware, binaries, or an `AgentLoop`.

import type { Clock, MicActivityEvent } from './detector';
import type { CaptureOfferHandle } from './notification';
import type { Speaker, TranscriptEntry } from './transcript-session';

const realClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

/** Default maximum-capture-duration safety net (see this file's header
 * comment, "CANCELLATION"). Deliberately generous — this exists to catch a
 * stuck signal, not to cap a long but genuine meeting. */
const DEFAULT_MAX_CAPTURE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface CallCaptureWakeEvent {
  watcherId: string;
  target: string;
  personalityId: string;
  promptPrefix?: string;
  summary: string;
}

export type CallCaptureDependencyCheck = () => Promise<
  { ok: true } | { ok: false; missing: string[]; errors: string[] }
>;

export interface CallCaptureDetectorPort {
  start(onEvent: (event: MicActivityEvent) => void): void;
  stop(): void;
}

export interface CallCaptureNotificationGatePort {
  presentCaptureOffer(opts: {
    callId: string;
    title: string;
    message: string;
    /** The clean source label for this call (e.g. `'zoom'`), shown by the
     * current implementation's card as a subtitle — see `notification.ts`'s
     * `PresentCaptureOfferOptions.source` doc comment. */
    source?: string;
  }): Promise<CaptureOfferHandle>;
}

/**
 * The floating on-screen recording indicator (plan/phases/
 * call-capture-desktop-ux.md) — visual confirmation that a capture is
 * actually in progress, shown the moment one starts and hidden the moment
 * it ends. Structural port, mirroring `CallCaptureDetectorPort`/
 * `CallCaptureNotificationGatePort`'s idiom: real code is wired by the
 * caller (`apps/ethos/src/commands/serve.ts`/`gateway.ts`) from
 * `CaptureIndicator` (`indicator.ts`, a native AppKit process for the
 * headless CLI daemon); tests inject a fake.
 */
export interface CallCaptureIndicatorPort {
  /** Shows the indicator — called once a capture is actually about to
   * start (`handleAccepted`), carrying the same clean source label
   * (`'zoom'`, `'teams'`, ...) `runCapture` receives. */
  show(source: string): void;
  /** Forwards one streamed transcript entry to the indicator's live-preview
   * popover, in the same order `runCapture`'s `onEntry` callback receives
   * them. */
  updateTranscript(entry: TranscriptEntry): void;
  /** Forwards one live audio-level reading to the indicator's level-meter, in
   * the same order `runCapture`'s `onAudioLevel` callback receives them.
   * Optional (unlike `updateTranscript`) because the existing `CaptureIndicator`
   * implementation (`indicator.ts`, structurally satisfying this port without
   * an `implements` clause — see that file's header comment) does not
   * implement it yet; a follow-up task adds the meter there. Making this
   * required would break that structural match today. */
  updateAudioLevel?(speaker: Speaker, level: number, at: number): void;
  /** Hides the indicator — called once this call's capture is done,
   * regardless of which path ended it (`call_ended`, the max-duration
   * safety net, or the indicator's own "End" affordance). */
  hide(): void;
  /**
   * Registers the callback fired when the user clicks the indicator's own
   * manual "End" affordance — the safety net for when `call_ended` never
   * fires. Registered once, in `start()`; the daemon reacts through the
   * EXACT SAME path `call_ended` already uses (`handleCallEnded()`), never
   * a second cancellation mechanism.
   */
  onEndRequested(callback: () => void): void;
}

export interface CallCaptureDaemonLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface CallCaptureDaemonOptions {
  detector: CallCaptureDetectorPort;
  notificationGate: CallCaptureNotificationGatePort;
  checkDependencies: CallCaptureDependencyCheck;
  personalityId: string;
  /**
   * Same shape as `extensions/watchers`' `WatcherManagerConfig.wake` (a
   * structural port — this package deliberately takes no dependency on
   * `@ethosagent/watchers`; the caller passes the same closure it already
   * built for `WatcherManager`). Fires as the audit-trail leg alongside the
   * OS notification (decision 4). Best-effort: a failure here must never
   * block the notification.
   */
  wake?: (event: CallCaptureWakeEvent) => Promise<void>;
  /**
   * Invokes the call-capture pipeline directly and deterministically — no LLM
   * round-trip, no chat turn. The caller (packages/wiring/src/build-agent-loop.ts,
   * threaded through apps/ethos/src/commands/serve.ts) binds this to the real
   * `runCallCapture()` from @ethosagent/tools-callcapture, closing over the
   * bound personality id and constructed capture dependencies. `abortSignal`
   * fires when this daemon later observes `call_ended` for the same call.
   * `source` is the clean label the native detector resolved for this call
   * (e.g. `'zoom'`, via `detector.ts`'s `sourceLabelForProcessName` mapping
   * on the triggering `call_started` event) — forwarded through to
   * `runCallCapture`'s `input.source`, which drives the artifact filename
   * and digest line. `onEntry` is the daemon's own live-transcript relay
   * (`(entry) => this.indicator?.updateTranscript(entry)`) — the caller
   * threads it straight through to `runCallCapture`'s own `onEntry` option
   * so the indicator's popover updates as entries stream in, not only after
   * the call ends. A caller with no indicator wired (e.g. the desktop app's
   * own daemon, which relays live entries a different way) can ignore this
   * third argument entirely — JS tolerates the extra parameter.
   * `onAudioLevel` is the daemon's own live-level relay
   * (`(speaker, level, at) => this.indicator?.updateAudioLevel?.(speaker, level, at)`)
   * — same optional-tolerance reasoning applies to a caller that ignores
   * this 4th argument.
   */
  runCapture: (
    abortSignal: AbortSignal,
    source: string,
    onEntry: (entry: TranscriptEntry) => void,
    onAudioLevel: (speaker: Speaker, level: number, at: number) => void,
  ) => Promise<void>;
  logger?: CallCaptureDaemonLogger;
  now?: () => number;
  /**
   * Maximum-capture-duration safety net (see this file's header comment,
   * "CANCELLATION"). Defaults to `DEFAULT_MAX_CAPTURE_DURATION_MS` (4
   * hours). Aborts an in-flight capture if `call_ended` never arrives for
   * it — a last-resort net UNDER the real detector signal, never a
   * substitute for it.
   */
  maxCaptureDurationMs?: number;
  /** Overrides the timer implementation backing `maxCaptureDurationMs`. */
  clock?: Clock;
  /**
   * Observability hook — fires every time the daemon's internal state
   * changes (idle → settingUp → awaiting → capturing → idle, and the
   * various early-exit/cancellation paths). Optional and additive:
   * existing callers that don't pass it see no behavior change. Added for
   * the desktop app's recording-state pill (plan/phases/
   * call-capture-desktop-ux.md, P2) to observe capture start/end without
   * polling or duplicating the daemon's state machine.
   */
  onStateChange?: (state: DaemonState) => void;
  /**
   * The floating on-screen recording indicator for the headless CLI daemon
   * (`ethos serve`/`ethos gateway` — the desktop app has its own Electron-
   * based pill, wired independently). Optional and additive: a caller that
   * doesn't pass one (tests, or any deployment without the native binary
   * built) sees no behavior change — every call site below is a `?.` no-op.
   */
  indicator?: CallCaptureIndicatorPort;
}

const NOOP_LOGGER: CallCaptureDaemonLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One call's lifecycle. `idle` between calls; `settingUp` synchronously from
 * `call_started` through preflight and the notification presentation (see
 * `handleCallStarted` — this state exists purely to close the race where a
 * `call_ended` arrives while those awaits are in flight); `awaiting` once the
 * notification is actually showing and outcome-pending; `capturing` from an
 * accepted notification until capture completes or `call_ended` aborts it. */
export type DaemonState =
  | { kind: 'idle' }
  | { kind: 'settingUp'; callId: string }
  | { kind: 'awaiting'; callId: string; handle: CaptureOfferHandle }
  | { kind: 'capturing'; callId: string; controller: AbortController; source: string };

function formatLocalTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Orchestrates one call-capture lifecycle at a time: `MicActivityDetector`
 * events drive preflight, the notification accept gate, and (on accept) a
 * cancellable direct dispatch into the capture pipeline via `runCapture`. See
 * this file's header comment for the approval and cancellation design notes.
 */
export class CallCaptureDaemon {
  private readonly detector: CallCaptureDetectorPort;
  private readonly notificationGate: CallCaptureNotificationGatePort;
  private readonly checkDependencies: CallCaptureDependencyCheck;
  private readonly personalityId: string;
  private readonly wakeFn: ((event: CallCaptureWakeEvent) => Promise<void>) | undefined;
  private readonly runCapture: CallCaptureDaemonOptions['runCapture'];
  private readonly logger: CallCaptureDaemonLogger;
  private readonly now: () => number;
  private readonly maxCaptureDurationMs: number;
  private readonly clock: Clock;
  private readonly onStateChange: ((state: DaemonState) => void) | undefined;
  private readonly indicator: CallCaptureIndicatorPort | undefined;

  private state: DaemonState = { kind: 'idle' };
  /** Set by `handleCallEnded` when a `call_ended` is observed while the
   * matching call is still in `settingUp` — the in-flight `handleCallStarted`
   * consumes and clears it at its next checkpoint. Single active call at a
   * time (no Set needed), matching the rest of this daemon's state model. */
  private cancelledCallId: string | null = null;

  constructor(options: CallCaptureDaemonOptions) {
    this.detector = options.detector;
    this.notificationGate = options.notificationGate;
    this.checkDependencies = options.checkDependencies;
    this.personalityId = options.personalityId;
    this.wakeFn = options.wake;
    this.runCapture = options.runCapture;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.maxCaptureDurationMs = options.maxCaptureDurationMs ?? DEFAULT_MAX_CAPTURE_DURATION_MS;
    this.clock = options.clock ?? realClock;
    this.onStateChange = options.onStateChange;
    this.indicator = options.indicator;
  }

  start(): void {
    this.detector.start((event) => {
      this.handleEvent(event);
    });
    // Registered once, for the daemon's whole lifetime — see
    // `CallCaptureIndicatorPort.onEndRequested`'s doc comment for why this
    // reuses `handleCallEnded()` rather than a second cancellation path.
    this.indicator?.onEndRequested(() => {
      this.handleCallEnded();
    });
  }

  private setState(next: DaemonState): void {
    this.state = next;
    this.onStateChange?.(next);
  }

  /**
   * Reads `this.state` through a fresh call expression rather than a direct
   * `this.state` member access. Needed at a few call sites that check
   * `this.state.kind` after an earlier `if (this.state.kind === X) { ... }`
   * guard narrowed it in the same scope, followed by a `this.setState(...)`
   * call meant to change it: TypeScript's control-flow analysis tracks
   * narrowing through direct `this.state = ...` assignments but not through
   * an indirection like a method call, so without this the compiler
   * incorrectly believes `this.state` is still typed as the earlier-narrowed
   * kind instead of the full union.
   */
  private currentState(): DaemonState {
    return this.state;
  }

  stop(): void {
    this.detector.stop();
    if (this.state.kind === 'settingUp') {
      // Mirrors handleCallEnded's own 'settingUp' branch exactly: the
      // in-flight handleCallStarted async function (awaiting
      // checkDependencies()/presentCaptureOffer()) still owns the transition
      // out of 'settingUp'. Don't touch `this.state` here — only mark the
      // cancellation so that in-flight call detects it at its next
      // checkpoint and bails instead of resurrecting the daemon into
      // 'awaiting' (or beyond) after stop() already ran.
      this.cancelledCallId = this.state.callId;
      return;
    }
    if (this.state.kind === 'awaiting') {
      void this.state.handle.expire();
    } else if (this.state.kind === 'capturing') {
      this.state.controller.abort();
    }
    this.setState({ kind: 'idle' });
  }

  private handleEvent(event: MicActivityEvent): void {
    switch (event.type) {
      case 'call_started':
        void this.handleCallStarted(event.at, event.source);
        return;
      case 'call_ended':
        this.handleCallEnded();
        return;
      case 'error':
        // Detector-level errors are about the detection signal, not an
        // in-progress capture — never tear down a running capture over one.
        this.logger.error(`call-capture: detector error: ${event.message}`);
    }
  }

  private async handleCallStarted(at: number, source: string): Promise<void> {
    if (this.state.kind !== 'idle') {
      // MicActivityDetector's own debounce means overlapping call_started
      // events shouldn't happen — guard defensively anyway rather than trust it.
      this.logger.warn(
        `call-capture: call_started received while not idle (state=${this.state.kind}) — ignoring`,
      );
      return;
    }
    const callId = String(at);
    // Set synchronously, before any await, so a call_ended arriving at ANY
    // point from here on is observed by handleCallEnded instead of hitting
    // idle's no-op branch (the race this state exists to close).
    this.setState({ kind: 'settingUp', callId });

    const deps = await this.checkDependencies();
    if (this.consumeCancellation(callId)) {
      this.logger.info(
        `call-capture: call ${callId} ended before the dependency check finished — no notification shown`,
      );
      const stateAfterDeps = this.currentState();
      if (stateAfterDeps.kind === 'settingUp' && stateAfterDeps.callId === callId) {
        this.setState({ kind: 'idle' });
      }
      return;
    }
    if (!deps.ok) {
      this.logger.error(
        `call-capture: missing dependencies (${deps.missing.join(', ')}) — no notification shown. ${deps.errors.join(' ')}`,
      );
      const stateAfterPreflightError = this.currentState();
      if (
        stateAfterPreflightError.kind === 'settingUp' &&
        stateAfterPreflightError.callId === callId
      ) {
        this.setState({ kind: 'idle' });
      }
      return;
    }

    if (this.wakeFn) {
      this.wakeFn({
        watcherId: 'call-capture',
        target: 'call-capture',
        personalityId: this.personalityId,
        promptPrefix: 'A call was just detected on this machine.',
        summary: `Call detected at ${formatLocalTime(at)} — a capture offer was shown.`,
      }).catch((err) => {
        this.logger.warn(
          `call-capture: wake failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    // No await happens between the check above and this call, so no event-loop
    // turn occurs in between — call_ended cannot interleave here. The next
    // cancellation checkpoint that matters is after presentCaptureOffer resolves.
    const handle = await this.notificationGate.presentCaptureOffer({
      callId,
      title: 'Ethos',
      // terminal-notifier 2.0.0 has no action-button support — clicking the
      // notification body is the only interactive affordance, and macOS
      // often labels that click target with a generic "Show" rather than
      // custom text, so the message itself must carry the instruction.
      // (`capture-offer-card`, the current implementation, ignores this —
      // see `PresentCaptureOfferOptions`'s doc comment — but
      // `DesktopNotificationGate`'s own card still renders it.)
      message: 'Call detected — click to start capturing.',
      // Threaded through so the card can show it as a subtitle (see
      // `PresentCaptureOfferOptions.source`'s doc comment). This is the
      // one line this daemon needed for the capture-offer-card swap — `source`
      // was already in scope here for `handleAccepted`/`runCapture` below.
      source,
    });

    if (this.consumeCancellation(callId)) {
      // The call ended while the notification was in flight — the handle now
      // exists (a real notification may be showing), so withdraw it immediately
      // rather than leaving it dangling for some later event to notice.
      void handle.expire();
      this.setState({ kind: 'idle' });
      return;
    }

    this.setState({ kind: 'awaiting', callId, handle });

    handle.waitForOutcome().then((outcome) => {
      if (this.state.kind !== 'awaiting' || this.state.callId !== callId) {
        // A stale outcome for an already-superseded call — no-op.
        return;
      }
      if (outcome.outcome === 'accepted') {
        void this.handleAccepted(callId, source);
        return;
      }
      if (outcome.outcome === 'expired') {
        this.logger.info(`call-capture: offer for call ${callId} expired — no capture`);
      } else {
        this.logger.error(
          `call-capture: notification error for call ${callId}: ${outcome.message}`,
        );
      }
      this.setState({ kind: 'idle' });
    });
  }

  /** Returns true (and clears the flag) if `callId` was marked cancelled by a
   * call_ended observed while this call was still in `settingUp`. */
  private consumeCancellation(callId: string): boolean {
    if (this.cancelledCallId === callId) {
      this.cancelledCallId = null;
      return true;
    }
    return false;
  }

  private async handleAccepted(callId: string, source: string): Promise<void> {
    // Defense-in-depth: the only caller (`handle.waitForOutcome().then(...)`
    // above) already checks `this.state.kind !== 'awaiting' || this.state.callId
    // !== callId` before invoking this method, with no `await` between that
    // check and this call — JS is single-threaded and nothing else can run in
    // between, so this guard is currently redundant with the caller's. Kept
    // anyway as a cheap belt-and-suspenders check per review request: it costs
    // nothing and protects against a future caller that doesn't re-check.
    if (this.state.kind !== 'awaiting' || this.state.callId !== callId) {
      this.logger.warn(
        `call-capture: accepted outcome for call ${callId} arrived while daemon state is ${this.state.kind} — ignoring`,
      );
      return;
    }
    const controller = new AbortController();
    this.setState({ kind: 'capturing', callId, controller, source });
    this.indicator?.show(source);

    // Maximum-capture-duration safety net (see this file's header comment,
    // "CANCELLATION") — a last resort UNDER the real call_ended signal, not
    // a substitute for it. Cleared in `finally` below regardless of which
    // path (call_ended, this timer, or a runCapture failure) ends the
    // capture, so it never outlives the call it was guarding.
    const safetyTimer = this.clock.setTimeout(() => {
      this.logger.warn(
        `call-capture: capture for call ${callId} hit the ${this.maxCaptureDurationMs}ms maximum-duration safety net without a call_ended — aborting as a last resort. This should not happen in normal operation.`,
      );
      controller.abort();
    }, this.maxCaptureDurationMs);

    try {
      await this.runCapture(
        controller.signal,
        source,
        (entry) => this.indicator?.updateTranscript(entry),
        (speaker, level, at) => this.indicator?.updateAudioLevel?.(speaker, level, at),
      );
    } catch (err) {
      this.logger.error(
        `call-capture: capture for call ${callId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.clock.clearTimeout(safetyTimer);
      // Hides regardless of which path got here (call_ended's abort, the
      // safety-net timer's abort, an end-requested click's abort routed
      // through handleCallEnded, or runCapture finishing/throwing on its
      // own) — show() was called unconditionally for this same call above.
      this.indicator?.hide();
      const stateAfterCapture = this.currentState();
      if (stateAfterCapture.kind === 'capturing' && stateAfterCapture.callId === callId) {
        this.setState({ kind: 'idle' });
      }
    }
  }

  private handleCallEnded(): void {
    if (this.state.kind === 'settingUp') {
      // Don't touch `this.state` here — the in-flight handleCallStarted async
      // function owns the transition out of 'settingUp' once it notices this
      // flag at its next checkpoint (after checkDependencies or after
      // presentCaptureOffer resolves). Overwriting state here would race with
      // whichever await resolves next.
      this.cancelledCallId = this.state.callId;
      return;
    }
    if (this.state.kind === 'awaiting') {
      void this.state.handle.expire();
      this.setState({ kind: 'idle' });
      return;
    }
    if (this.state.kind === 'capturing') {
      // Aborts the in-flight capture cleanly — runCapture stops both streams
      // and saves whatever was already captured.
      this.state.controller.abort();
      this.setState({ kind: 'idle' });
    }
    // idle → no-op.
  }
}
