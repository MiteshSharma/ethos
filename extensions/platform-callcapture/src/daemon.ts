// CallCaptureDaemon — the Phase 4 orchestrator that wires Phases 1-3 (and
// the T5 combined preflight) together end-to-end (plan/phases/
// call-capture-extension.md, "Phase 4 — Integration"). Owns exactly one call
// lifecycle at a time: detector event → preflight → notification (accept
// gate) → direct capture dispatch → clean cancellation on call end.
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
// `call_ended` — a real, already-existing mechanism, not a bounded-duration
// safety-net timer.
//
// Structural ports throughout, mirroring `detector.ts`/`notification.ts`'s
// idiom: real code is wired by the caller (`apps/ethos/src/commands/
// serve.ts`) from `MicActivityDetector`/`NotificationGate`/
// `checkCallCaptureDependencies`/a bound `runCallCapture()`; tests inject
// fakes and never touch real hardware, binaries, or an `AgentLoop`.

import type { MicActivityEvent } from './detector';
import type { CaptureOfferHandle } from './notification';

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
  }): Promise<CaptureOfferHandle>;
}

export interface CallCaptureDaemonLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * The process-prefilter gate (decision 1's "coarse prefilter"). Resolves the
 * matched calling app's clean source label (e.g. `'zoom'`, `'teams'`) when
 * at least one known calling app is currently running, or `null` when none
 * is — see `process-prefilter.ts`'s `checkAnyCallingAppRunning()` +
 * `sourceLabelForProcessName()`, which the caller (`serve.ts`/`gateway.ts`)
 * composes into this gate. `CallCaptureDaemon` itself stays agnostic to the
 * exact process list and the raw-name-to-label mapping; it only ever calls
 * this zero-arg gate and forwards whatever label it returns into
 * `runCapture`'s `source` argument.
 */
export type CallCaptureProcessGateCheck = () => Promise<string | null>;

export interface CallCaptureDaemonOptions {
  detector: CallCaptureDetectorPort;
  notificationGate: CallCaptureNotificationGatePort;
  checkDependencies: CallCaptureDependencyCheck;
  /**
   * Decision 1's coarse process prefilter: mic-in-use (the detector above)
   * remains the actual detection trigger, but ANY mic activity alone
   * (Dictation, Siri, Voice Memos, a browser tab's getUserMedia() grant, ...)
   * is not "a call." A capture offer only fires when this gate ALSO reports
   * at least one known calling app running. Known, documented limitation:
   * this cannot see a browser-based call (e.g. Meet in Chrome) — see
   * `process-prefilter.ts`'s header comment.
   */
  checkCallingAppRunning: CallCaptureProcessGateCheck;
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
   * `source` is the clean label `checkCallingAppRunning` resolved for this
   * call (e.g. `'zoom'`) — forwarded through to `runCallCapture`'s
   * `input.source`, which drives the artifact filename and digest line.
   */
  runCapture: (abortSignal: AbortSignal, source: string) => Promise<void>;
  logger?: CallCaptureDaemonLogger;
  now?: () => number;
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
type DaemonState =
  | { kind: 'idle' }
  | { kind: 'settingUp'; callId: string }
  | { kind: 'awaiting'; callId: string; handle: CaptureOfferHandle }
  | { kind: 'capturing'; callId: string; controller: AbortController };

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
  private readonly checkCallingAppRunning: CallCaptureProcessGateCheck;
  private readonly personalityId: string;
  private readonly wakeFn: ((event: CallCaptureWakeEvent) => Promise<void>) | undefined;
  private readonly runCapture: CallCaptureDaemonOptions['runCapture'];
  private readonly logger: CallCaptureDaemonLogger;
  private readonly now: () => number;

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
    this.checkCallingAppRunning = options.checkCallingAppRunning;
    this.personalityId = options.personalityId;
    this.wakeFn = options.wake;
    this.runCapture = options.runCapture;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.detector.start((event) => {
      this.handleEvent(event);
    });
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
    this.state = { kind: 'idle' };
  }

  private handleEvent(event: MicActivityEvent): void {
    switch (event.type) {
      case 'call_started':
        void this.handleCallStarted(event.at);
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

  private async handleCallStarted(at: number): Promise<void> {
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
    this.state = { kind: 'settingUp', callId };

    const [deps, callingApp] = await Promise.all([
      this.checkDependencies(),
      this.checkCallingAppRunning(),
    ]);
    if (this.consumeCancellation(callId)) {
      this.logger.info(
        `call-capture: call ${callId} ended before dependency/process check finished — no notification shown`,
      );
      if (this.state.kind === 'settingUp' && this.state.callId === callId) {
        this.state = { kind: 'idle' };
      }
      return;
    }
    if (!deps.ok) {
      this.logger.error(
        `call-capture: missing dependencies (${deps.missing.join(', ')}) — no notification shown. ${deps.errors.join(' ')}`,
      );
      if (this.state.kind === 'settingUp' && this.state.callId === callId) {
        this.state = { kind: 'idle' };
      }
      return;
    }
    if (!callingApp) {
      // Decision 1's coarse process prefilter: mic activity alone (Dictation,
      // Siri, Voice Memos, a browser tab's mic grant, ...) is common and
      // expected — this is not an error, just a frequent non-match, so it
      // logs at info level. Known limitation: a browser-based call (e.g.
      // Meet in Chrome) also does not pass this prefilter — see
      // process-prefilter.ts's header comment.
      this.logger.info(
        `call-capture: call ${callId} — mic activity detected, but no known calling app is running — not offering (browser-based calls are not detected by this prefilter)`,
      );
      if (this.state.kind === 'settingUp' && this.state.callId === callId) {
        this.state = { kind: 'idle' };
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
      message: 'Call detected — click to start capturing.',
    });

    if (this.consumeCancellation(callId)) {
      // The call ended while the notification was in flight — the handle now
      // exists (a real notification may be showing), so withdraw it immediately
      // rather than leaving it dangling for some later event to notice.
      void handle.expire();
      this.state = { kind: 'idle' };
      return;
    }

    this.state = { kind: 'awaiting', callId, handle };

    handle.waitForOutcome().then((outcome) => {
      if (this.state.kind !== 'awaiting' || this.state.callId !== callId) {
        // A stale outcome for an already-superseded call — no-op.
        return;
      }
      if (outcome.outcome === 'accepted') {
        void this.handleAccepted(callId, callingApp);
        return;
      }
      if (outcome.outcome === 'expired') {
        this.logger.info(`call-capture: offer for call ${callId} expired — no capture`);
      } else {
        this.logger.error(
          `call-capture: notification error for call ${callId}: ${outcome.message}`,
        );
      }
      this.state = { kind: 'idle' };
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
    this.state = { kind: 'capturing', callId, controller };

    try {
      await this.runCapture(controller.signal, source);
    } catch (err) {
      this.logger.error(
        `call-capture: capture for call ${callId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (this.state.kind === 'capturing' && this.state.callId === callId) {
        this.state = { kind: 'idle' };
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
      this.state = { kind: 'idle' };
      return;
    }
    if (this.state.kind === 'capturing') {
      // Aborts the in-flight capture cleanly — runCapture stops both streams
      // and saves whatever was already captured.
      this.state.controller.abort();
      this.state = { kind: 'idle' };
    }
    // idle → no-op.
  }
}
