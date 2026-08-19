import { describe, expect, it, vi } from 'vitest';
import type {
  CallCaptureDependencyCheck,
  CallCaptureDetectorPort,
  CallCaptureIndicatorPort,
  CallCaptureNotificationGatePort,
  CallCaptureWakeEvent,
} from '../daemon';
import { CallCaptureDaemon } from '../daemon';
import type { Clock, MicActivityEvent } from '../detector';
import type { CaptureOfferHandle, CaptureOfferOutcome } from '../notification';
import type { Speaker, TranscriptEntry } from '../transcript-session';

/** Fake Clock — mirrors detector.test.ts's own FakeClock idiom. Pending
 * timers are advanced explicitly, never by real time. */
class FakeClock implements Clock {
  private nextId = 1;
  private readonly pending = new Map<number, () => void>();
  readonly clearedHandles: unknown[] = [];

  setTimeout(fn: () => void, _ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, fn);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.clearedHandles.push(handle);
    this.pending.delete(handle as number);
  }

  /** Fire every timer currently pending, as if `ms` had elapsed. */
  advance(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

// Pure orchestration logic over injected fakes — no real hardware, binaries,
// or AgentLoop anywhere in this file, mirroring the injectable-port idiom
// `detector.test.ts`/`notification.test.ts` already use.

/** Fake detector: captures the `onEvent` callback so the test drives a
 * scripted event sequence directly. */
class FakeDetector implements CallCaptureDetectorPort {
  onEvent: ((event: MicActivityEvent) => void) | null = null;
  stopped = false;

  start(onEvent: (event: MicActivityEvent) => void): void {
    this.onEvent = onEvent;
  }

  stop(): void {
    this.stopped = true;
  }

  emit(event: MicActivityEvent): void {
    this.onEvent?.(event);
  }
}

/** Fake notification gate: `presentCaptureOffer` resolves a handle whose
 * outcome the test controls directly via `resolveOutcome`/`expire` spies. */
class FakeNotificationGate implements CallCaptureNotificationGatePort {
  readonly offers: Array<{ callId: string; title: string; message: string; source?: string }> = [];
  readonly expireCalls: string[] = [];
  private resolveOutcome: ((outcome: CaptureOfferOutcome) => void) | null = null;

  async presentCaptureOffer(opts: {
    callId: string;
    title: string;
    message: string;
    source?: string;
  }): Promise<CaptureOfferHandle> {
    this.offers.push(opts);
    const outcomePromise = new Promise<CaptureOfferOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
    return {
      waitForOutcome: () => outcomePromise,
      expire: async () => {
        this.expireCalls.push(opts.callId);
        this.resolveOutcome?.({ outcome: 'expired' });
      },
    };
  }

  settle(outcome: CaptureOfferOutcome): void {
    this.resolveOutcome?.(outcome);
  }
}

/** A notification gate whose `presentCaptureOffer` call is held open until
 * the test explicitly resolves it — used to land a `call_ended` exactly
 * while the daemon is awaiting the notification presentation itself. */
class DeferredNotificationGate implements CallCaptureNotificationGatePort {
  readonly offers: Array<{ callId: string; title: string; message: string }> = [];
  private resolvePresent: ((handle: CaptureOfferHandle) => void) | null = null;

  presentCaptureOffer(opts: {
    callId: string;
    title: string;
    message: string;
  }): Promise<CaptureOfferHandle> {
    this.offers.push(opts);
    return new Promise<CaptureOfferHandle>((resolve) => {
      this.resolvePresent = resolve;
    });
  }

  /** Resolves the pending `presentCaptureOffer` call with a handle whose
   * `expire` is a spy, and whose outcome never settles on its own. */
  resolveWithHandle(): { handle: CaptureOfferHandle; expire: ReturnType<typeof vi.fn> } {
    const expire = vi.fn(async () => {});
    const handle: CaptureOfferHandle = {
      waitForOutcome: () => new Promise(() => {}),
      expire,
    };
    this.resolvePresent?.(handle);
    return { handle, expire };
  }
}

function okDeps(): CallCaptureDependencyCheck {
  return async () => ({ ok: true });
}

function failingDeps(missing: string[]): CallCaptureDependencyCheck {
  return async () => ({ ok: false, missing, errors: missing.map((m) => `${m} missing`) });
}

/** Dependency check the test resolves manually, to land a `call_ended`
 * exactly while `checkDependencies()` is still pending. */
function deferredDeps(): {
  check: CallCaptureDependencyCheck;
  resolve: (result: { ok: true } | { ok: false; missing: string[]; errors: string[] }) => void;
} {
  let resolveFn:
    | ((result: { ok: true } | { ok: false; missing: string[]; errors: string[] }) => void)
    | null = null;
  const check: CallCaptureDependencyCheck = () =>
    new Promise((resolve) => {
      resolveFn = resolve;
    });
  return {
    check,
    resolve: (result) => resolveFn?.(result),
  };
}

/** Fake indicator: records show/updateTranscript/hide calls and lets the
 * test fire "End button clicked" directly, mirroring the other fakes'
 * "capture the callback, drive it manually" idiom. */
class FakeIndicator implements CallCaptureIndicatorPort {
  readonly showCalls: string[] = [];
  readonly updateCalls: TranscriptEntry[] = [];
  readonly audioLevelCalls: Array<{ speaker: Speaker; level: number; at: number }> = [];
  hideCalls = 0;
  private endRequestedCallback: (() => void) | null = null;

  show(source: string): void {
    this.showCalls.push(source);
  }

  updateTranscript(entry: TranscriptEntry): void {
    this.updateCalls.push(entry);
  }

  updateAudioLevel(speaker: Speaker, level: number, at: number): void {
    this.audioLevelCalls.push({ speaker, level, at });
  }

  hide(): void {
    this.hideCalls++;
  }

  onEndRequested(callback: () => void): void {
    this.endRequestedCallback = callback;
  }

  /** Simulates the user clicking the indicator's "End" affordance. */
  triggerEndRequested(): void {
    this.endRequestedCallback?.();
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Flushes microtasks so daemon-internal `.then()` chains settle before assertions. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CallCaptureDaemon', () => {
  it('call_started → preflight passes → wake fires → notification shown, in that order', async () => {
    const order: string[] = [];
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const wake = vi.fn(async (_event: CallCaptureWakeEvent) => {
      order.push('wake');
    });
    const originalPresent = gate.presentCaptureOffer.bind(gate);
    gate.presentCaptureOffer = async (opts) => {
      order.push('notification');
      return originalPresent(opts);
    };

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(gate.offers).toHaveLength(1);
    expect(order).toEqual(['wake', 'notification']);
  });

  it('call_started → preflight fails → neither wake nor notification fires, error logged naming missing deps', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const wake = vi.fn(async () => {});
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: failingDeps(['terminal-notifier', 'audiotee']),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    expect(wake).not.toHaveBeenCalled();
    expect(gate.offers).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg] = logger.error.mock.calls[0] as [string];
    expect(msg).toContain('terminal-notifier');
    expect(msg).toContain('audiotee');
  });

  it('accepted → runCapture called with a non-aborted AbortSignal', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async (_signal: AbortSignal, _source: string) => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(runCapture).toHaveBeenCalledTimes(1);
    const [signal] = runCapture.mock.calls[0];
    expect(signal.aborted).toBe(false);
  });

  it('accepted → runCapture is called with the source label carried on the call_started event', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async (_signal: AbortSignal, _source: string) => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'teams' });
    await flush();

    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(runCapture).toHaveBeenCalledTimes(1);
    const [, source] = runCapture.mock.calls[0];
    expect(source).toBe('teams');
  });

  it('onStateChange observes the full happy-path state sequence, with source carried on the capturing state', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async () => {});
    const onStateChange = vi.fn();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      onStateChange,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    gate.settle({ outcome: 'accepted' });
    await flush();

    const kinds = onStateChange.mock.calls.map(([state]) => state.kind);
    expect(kinds).toEqual(['settingUp', 'awaiting', 'capturing', 'idle']);

    const capturingCall = onStateChange.mock.calls.find(([state]) => state.kind === 'capturing');
    expect(capturingCall?.[0].source).toBe('zoom');
  });

  it('call_ended while awaiting notification (not yet accepted) → handle.expire() called, no runCapture', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async () => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    detector.emit({ type: 'call_ended', at: 2000 });
    await flush();

    expect(gate.expireCalls).toEqual(['1000']);
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('onStateChange observes a final idle state when call_ended cancels a call while still awaiting', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async () => {});
    const onStateChange = vi.fn();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      onStateChange,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    detector.emit({ type: 'call_ended', at: 2000 });
    await flush();

    const lastCall = onStateChange.mock.calls[onStateChange.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual({ kind: 'idle' });
  });

  it('call_ended while capturing (runCapture in flight) → the AbortSignal passed to runCapture is aborted', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    let capturedSignal: AbortSignal | undefined;
    let resolveRunCapture: (() => void) | undefined;
    const runCapture = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>((resolve) => {
        resolveRunCapture = resolve;
      });
    });

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(capturedSignal?.aborted).toBe(false);

    detector.emit({ type: 'call_ended', at: 3000 });
    await flush();

    expect(capturedSignal?.aborted).toBe(true);
    resolveRunCapture?.();
  });

  it('notification expired → no runCapture call, logged', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async () => {});
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    gate.settle({ outcome: 'expired' });
    await flush();

    expect(runCapture).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('notification error outcome → no runCapture call, logged', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async () => {});
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    gate.settle({ outcome: 'error', message: 'terminal-notifier spawn failed' });
    await flush();

    expect(runCapture).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('terminal-notifier spawn failed'),
    );
  });

  it('a stale outcome for a superseded callId is a no-op', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async () => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();

    // First call: started, then ended before acceptance (supersedes the offer).
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    detector.emit({ type: 'call_ended', at: 1500 });
    await flush();

    // The first offer's outcome arrives late, after the daemon already went
    // idle (and, in a real run, could have started a second call). It must
    // not resurrect state or trigger a capture.
    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(runCapture).not.toHaveBeenCalled();
  });

  it('stop() expires a pending offer and is safe to call from idle', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture: vi.fn(async () => {}),
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    daemon.stop();
    await flush();

    expect(detector.stopped).toBe(true);
    expect(gate.expireCalls).toEqual(['1000']);

    // Safe to call again from idle.
    expect(() => daemon.stop()).not.toThrow();
  });

  it('onStateChange observes a final idle state when stop() is called mid-capture', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(() => new Promise<void>(() => {}));
    const onStateChange = vi.fn();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      onStateChange,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    gate.settle({ outcome: 'accepted' });
    await flush();

    daemon.stop();

    const lastCall = onStateChange.mock.calls[onStateChange.mock.calls.length - 1];
    expect(lastCall?.[0].kind).toBe('idle');
  });

  it('a call_started arriving while not idle is ignored and logged (defensive guard)', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture: vi.fn(async () => {}),
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    // Second call_started while still awaiting the first notification.
    detector.emit({ type: 'call_started', at: 2000, source: 'zoom' });
    await flush();

    expect(gate.offers).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('call_started'));
  });

  // -------------------------------------------------------------------------
  // Bug 2 — the accept-vs-call_ended race during `settingUp`
  // -------------------------------------------------------------------------

  it('call_ended arriving while checkDependencies() is still pending cancels the call cleanly, no notification ever shown', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const wake = vi.fn(async () => {});
    const deps = deferredDeps();
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: deps.check,
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
      logger,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    // call_ended arrives BEFORE checkDependencies resolves.
    detector.emit({ type: 'call_ended', at: 1500 });
    await flush();

    // Now let checkDependencies resolve.
    deps.resolve({ ok: true });
    await flush();

    expect(gate.offers).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();

    // The daemon must have actually returned to idle — verify by driving a
    // fresh call_started and confirming a new offer IS made. `deps.check`
    // hands out a fresh pending promise per call, so this second call's
    // dependency check needs its own explicit resolve too.
    detector.emit({ type: 'call_started', at: 2000, source: 'zoom' });
    await flush();
    expect(gate.offers).toHaveLength(0); // still pending — this call's deps check hasn't resolved yet
    deps.resolve({ ok: true });
    await flush();
    expect(gate.offers).toHaveLength(1);
  });

  it('call_ended arriving while presentCaptureOffer() is still pending expires the handle once it resolves, no double-fire', async () => {
    const detector = new FakeDetector();
    const gate = new DeferredNotificationGate();
    const runCapture = vi.fn(async () => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    // call_ended arrives while presentCaptureOffer is still pending.
    detector.emit({ type: 'call_ended', at: 1500 });
    await flush();

    // Now the notification "shows up" (the promise resolves with a handle).
    const { expire } = gate.resolveWithHandle();
    await flush();

    expect(expire).toHaveBeenCalledTimes(1);
    expect(runCapture).not.toHaveBeenCalled();

    // A fresh call_started afterward proves the daemon returned to idle, not
    // stuck — and that no stray waitForOutcome handler double-fires later.
    detector.emit({ type: 'call_started', at: 2000, source: 'zoom' });
    await flush();
    expect(runCapture).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Round-3 Issue 3 — stop() must cancel an in-flight 'settingUp' call, not
  // just force `this.state` to idle out from under it.
  // -------------------------------------------------------------------------

  it('stop() while checkDependencies() is still pending cancels the call cleanly — no resurrection into awaiting', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const wake = vi.fn(async () => {});
    const deps = deferredDeps();
    const runCapture = vi.fn(async () => {});
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: deps.check,
      personalityId: 'receptionist',
      wake,
      runCapture,
      logger,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    // stop() fires while checkDependencies() is still in flight — this used
    // to only reset `this.state` to idle without marking the cancellation,
    // so the in-flight handleCallStarted would resolve later, see nothing
    // cancelled, and go on to show a notification (resurrecting the daemon
    // into 'awaiting' after stop() already ran).
    daemon.stop();
    expect(detector.stopped).toBe(true);

    // Now let the pending dependency/process check resolve.
    deps.resolve({ ok: true });
    await flush();
    await flush();

    expect(gate.offers).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('stop() while presentCaptureOffer() is still pending cancels the call cleanly — the resolved handle is expired immediately, never shown as awaiting', async () => {
    const detector = new FakeDetector();
    const gate = new DeferredNotificationGate();
    const runCapture = vi.fn(async () => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    // stop() fires while presentCaptureOffer() is still in flight.
    daemon.stop();

    // Now the notification "shows up" (the promise resolves with a handle).
    const { expire } = gate.resolveWithHandle();
    await flush();

    // The handle is expired immediately rather than left 'awaiting' — a
    // resurrection would instead have chained onto
    // handle.waitForOutcome().then(...) and, on accept, invoked runCapture.
    expect(expire).toHaveBeenCalledTimes(1);
    expect(runCapture).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Process gating is no longer a separate daemon-level check (formerly
  // "Issue A" — the process prefilter wired as a `checkCallingAppRunning`
  // port). The native detector now only ever watches known calling apps in
  // the first place, so a call_started event is scoped to one by
  // construction — there is no "mic active, no known app" case left for the
  // daemon to gate on. See process-prefilter.ts's header comment.
  // -------------------------------------------------------------------------

  it('call_started carrying a source label → notification fires', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const wake = vi.fn(async () => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(gate.offers).toHaveLength(1);
  });

  it('threads the call_started source label through to presentCaptureOffer, for the card subtitle', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture: vi.fn(async () => {}),
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'teams' });
    await flush();

    expect(gate.offers[0]?.source).toBe('teams');
  });

  // -------------------------------------------------------------------------
  // Maximum-capture-duration safety net — a last resort UNDER the real
  // call_ended signal (see daemon.ts's header comment, "CANCELLATION"),
  // added after testing this fix found a real calling-app process whose own
  // per-process signal stayed warm with no confirmable active call.
  // -------------------------------------------------------------------------

  it('aborts an in-flight capture when the safety-net timer fires without a call_ended', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const clock = new FakeClock();
    let capturedSignal: AbortSignal | undefined;
    const runCapture = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<void>(() => {}); // never resolves on its own
    });

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      maxCaptureDurationMs: 1000,
      clock,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(capturedSignal?.aborted).toBe(false);

    clock.advance();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('clears the safety-net timer once call_ended aborts the capture normally', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const clock = new FakeClock();
    let resolveRunCapture: (() => void) | undefined;
    const runCapture = vi.fn(() => {
      return new Promise<void>((resolve) => {
        resolveRunCapture = resolve;
      });
    });

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      maxCaptureDurationMs: 1000,
      clock,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(clock.pendingCount).toBe(1);

    detector.emit({ type: 'call_ended', at: 3000 });
    resolveRunCapture?.();
    await flush();

    expect(clock.pendingCount).toBe(0);
  });

  it('defaults the safety net to 4 hours when maxCaptureDurationMs is not supplied', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const clock = new FakeClock();
    const setTimeoutSpy = vi.spyOn(clock, 'setTimeout');
    const runCapture = vi.fn(() => new Promise<void>(() => {}));

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      personalityId: 'receptionist',
      runCapture,
      clock,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
    await flush();
    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4 * 60 * 60 * 1000);
  });

  // -------------------------------------------------------------------------
  // onStateChange observability hook (plan/phases/call-capture-desktop-ux.md,
  // P2) — the desktop pill observes capture start/end through this instead of
  // polling or duplicating the daemon's state machine.
  // -------------------------------------------------------------------------

  describe('onStateChange', () => {
    it('fires with each state in order across the full accepted flow, carrying source on the capturing state', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const runCapture = vi.fn(async () => {});
      const states: Array<{ kind: string }> = [];
      const onStateChange = vi.fn((state) => states.push(state));

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        onStateChange,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      gate.settle({ outcome: 'accepted' });
      await flush();
      detector.emit({ type: 'call_ended', at: 4000 });
      await flush();

      expect(states.map((s) => s.kind)).toEqual(['settingUp', 'awaiting', 'capturing', 'idle']);
      const capturingState = states[2] as { kind: 'capturing'; source: string; callId: string };
      expect(capturingState.source).toBe('zoom');
      expect(capturingState.callId).toBe('1000');
    });

    it('does not fire at all when not supplied (existing callers unaffected)', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture: vi.fn(async () => {}),
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();

      expect(() => gate.settle({ outcome: 'accepted' })).not.toThrow();
      await flush();
    });

    it('fires idle after call_ended while only awaiting (never reached capturing)', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const states: Array<{ kind: string }> = [];

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture: vi.fn(async () => {}),
        onStateChange: (state) => states.push(state),
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      detector.emit({ type: 'call_ended', at: 1500 });
      await flush();

      expect(states.map((s) => s.kind)).toEqual(['settingUp', 'awaiting', 'idle']);
    });

    it('fires idle when stop() is called while awaiting', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const states: Array<{ kind: string }> = [];

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture: vi.fn(async () => {}),
        onStateChange: (state) => states.push(state),
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();

      daemon.stop();

      expect(states.map((s) => s.kind)).toEqual(['settingUp', 'awaiting', 'idle']);
    });

    it('fires idle when stop() aborts an in-flight capture', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const runCapture = vi.fn(() => new Promise<void>(() => {}));
      const states: Array<{ kind: string }> = [];

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        onStateChange: (state) => states.push(state),
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      gate.settle({ outcome: 'accepted' });
      await flush();

      daemon.stop();

      expect(states.map((s) => s.kind)).toEqual(['settingUp', 'awaiting', 'capturing', 'idle']);
    });
  });

  // -------------------------------------------------------------------------
  // Floating on-screen recording indicator (plan/phases/
  // call-capture-desktop-ux.md) — the CLI-daemon's `CallCaptureIndicatorPort`.
  // -------------------------------------------------------------------------

  describe('indicator', () => {
    it('shows the indicator with the call source once accepted, and hides it once capture completes normally', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const indicator = new FakeIndicator();
      const runCapture = vi.fn(async () => {});

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        indicator,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();

      expect(indicator.showCalls).toEqual([]);

      gate.settle({ outcome: 'accepted' });
      await flush();

      expect(indicator.showCalls).toEqual(['zoom']);
      expect(indicator.hideCalls).toBe(1);
    });

    it("forwards each entry from runCapture's onEntry callback to indicator.updateTranscript, in order", async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const indicator = new FakeIndicator();
      const entries: TranscriptEntry[] = [
        { speaker: 'you', text: 'hello', at: 1 },
        { speaker: 'other', text: 'hi there', at: 2 },
      ];
      const runCapture = vi.fn(
        async (
          _signal: AbortSignal,
          _source: string,
          onEntry: (entry: TranscriptEntry) => void,
        ) => {
          for (const entry of entries) onEntry(entry);
        },
      );

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        indicator,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      gate.settle({ outcome: 'accepted' });
      await flush();

      expect(indicator.updateCalls).toEqual(entries);
    });

    it("forwards each reading from runCapture's onAudioLevel callback to indicator.updateAudioLevel, in order", async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const indicator = new FakeIndicator();
      const readings: Array<{ speaker: Speaker; level: number; at: number }> = [
        { speaker: 'you', level: 0.1, at: 1 },
        { speaker: 'other', level: 0.4, at: 2 },
      ];
      const runCapture = vi.fn(
        async (
          _signal: AbortSignal,
          _source: string,
          _onEntry: (entry: TranscriptEntry) => void,
          onAudioLevel: (speaker: Speaker, level: number, at: number) => void,
        ) => {
          for (const reading of readings) onAudioLevel(reading.speaker, reading.level, reading.at);
        },
      );

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        indicator,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      gate.settle({ outcome: 'accepted' });
      await flush();

      expect(indicator.audioLevelCalls).toEqual(readings);
    });

    it('hides the indicator when the max-duration safety net aborts an in-flight capture', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const indicator = new FakeIndicator();
      const clock = new FakeClock();
      const runCapture = vi.fn((signal: AbortSignal) => {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve());
        });
      });

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        indicator,
        maxCaptureDurationMs: 1000,
        clock,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      gate.settle({ outcome: 'accepted' });
      await flush();

      expect(indicator.hideCalls).toBe(0);
      clock.advance();
      await flush();

      expect(indicator.hideCalls).toBe(1);
    });

    it('hides the indicator when call_ended aborts an in-flight capture', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const indicator = new FakeIndicator();
      const runCapture = vi.fn((signal: AbortSignal) => {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve());
        });
      });

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        indicator,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      gate.settle({ outcome: 'accepted' });
      await flush();

      detector.emit({ type: 'call_ended', at: 3000 });
      await flush();

      expect(indicator.hideCalls).toBe(1);
    });

    it('an end-requested click aborts the in-flight capture through the SAME path call_ended uses, and hides the indicator', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const indicator = new FakeIndicator();
      let capturedSignal: AbortSignal | undefined;
      const runCapture = vi.fn((signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve());
        });
      });

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
        indicator,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();
      gate.settle({ outcome: 'accepted' });
      await flush();

      expect(capturedSignal?.aborted).toBe(false);

      indicator.triggerEndRequested();
      await flush();

      expect(capturedSignal?.aborted).toBe(true);
      expect(indicator.hideCalls).toBe(1);
    });

    it('an end-requested click while only awaiting (never reached capturing) expires the offer, mirroring a real call_ended', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const indicator = new FakeIndicator();

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture: vi.fn(async () => {}),
        indicator,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();

      indicator.triggerEndRequested();
      await flush();

      expect(gate.expireCalls).toEqual(['1000']);
    });

    it('does not throw when no indicator is configured (existing callers unaffected)', async () => {
      const detector = new FakeDetector();
      const gate = new FakeNotificationGate();
      const runCapture = vi.fn(
        async (
          _signal: AbortSignal,
          _source: string,
          onEntry: (entry: TranscriptEntry) => void,
        ) => {
          onEntry({ speaker: 'you', text: 'hi', at: 1 });
        },
      );

      const daemon = new CallCaptureDaemon({
        detector,
        notificationGate: gate,
        checkDependencies: okDeps(),
        personalityId: 'receptionist',
        runCapture,
      });
      daemon.start();
      detector.emit({ type: 'call_started', at: 1000, source: 'zoom' });
      await flush();

      expect(() => gate.settle({ outcome: 'accepted' })).not.toThrow();
      await flush();
    });
  });
});
