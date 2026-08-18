import { describe, expect, it, vi } from 'vitest';
import type {
  CallCaptureDependencyCheck,
  CallCaptureDetectorPort,
  CallCaptureNotificationGatePort,
  CallCaptureProcessGateCheck,
  CallCaptureWakeEvent,
} from '../daemon';
import { CallCaptureDaemon } from '../daemon';
import type { MicActivityEvent } from '../detector';
import type { CaptureOfferHandle, CaptureOfferOutcome } from '../notification';

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
  readonly offers: Array<{ callId: string; title: string; message: string }> = [];
  readonly expireCalls: string[] = [];
  private resolveOutcome: ((outcome: CaptureOfferOutcome) => void) | null = null;

  async presentCaptureOffer(opts: {
    callId: string;
    title: string;
    message: string;
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

/** Default process-prefilter gate for tests unrelated to Issue A's gating
 * behavior — always reports a known calling app running (as the clean
 * source label the real `checkCallingAppRunning` binding would resolve to),
 * i.e. the gate never blocks. Tests that exercise the gate itself supply
 * their own. */
function allowAppRunning(source = 'zoom'): CallCaptureProcessGateCheck {
  return async () => source;
}

function blockAppRunning(): CallCaptureProcessGateCheck {
  return async () => null;
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
    await flush();

    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(runCapture).toHaveBeenCalledTimes(1);
    const [signal] = runCapture.mock.calls[0];
    expect(signal.aborted).toBe(false);
  });

  it('accepted → runCapture is called with the source label the process-prefilter gate resolved', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async (_signal: AbortSignal, _source: string) => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      checkCallingAppRunning: allowAppRunning('teams'),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
    await flush();

    gate.settle({ outcome: 'accepted' });
    await flush();

    expect(runCapture).toHaveBeenCalledTimes(1);
    const [, source] = runCapture.mock.calls[0];
    expect(source).toBe('teams');
  });

  it('call_ended while awaiting notification (not yet accepted) → handle.expire() called, no runCapture', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const runCapture = vi.fn(async () => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
    await flush();

    detector.emit({ type: 'call_ended', at: 2000 });
    await flush();

    expect(gate.expireCalls).toEqual(['1000']);
    expect(runCapture).not.toHaveBeenCalled();
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();

    // First call: started, then ended before acceptance (supersedes the offer).
    detector.emit({ type: 'call_started', at: 1000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture: vi.fn(async () => {}),
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
    await flush();

    daemon.stop();
    await flush();

    expect(detector.stopped).toBe(true);
    expect(gate.expireCalls).toEqual(['1000']);

    // Safe to call again from idle.
    expect(() => daemon.stop()).not.toThrow();
  });

  it('a call_started arriving while not idle is ignored and logged (defensive guard)', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture: vi.fn(async () => {}),
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
    await flush();

    // Second call_started while still awaiting the first notification.
    detector.emit({ type: 'call_started', at: 2000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
      logger,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000 });
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
    detector.emit({ type: 'call_started', at: 2000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000 });
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
    detector.emit({ type: 'call_started', at: 2000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      wake,
      runCapture,
      logger,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000 });
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
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      runCapture,
    });
    daemon.start();

    detector.emit({ type: 'call_started', at: 1000 });
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
  // Issue A — process prefilter (decision 1's coarse prefilter, now wired)
  // -------------------------------------------------------------------------

  it('known calling app running + mic-active → notification fires (unchanged behavior)', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const wake = vi.fn(async () => {});

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      checkCallingAppRunning: allowAppRunning(),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
    await flush();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(gate.offers).toHaveLength(1);
  });

  it('no known calling app running → no wake, no notification, state returns to idle, logged', async () => {
    const detector = new FakeDetector();
    const gate = new FakeNotificationGate();
    const wake = vi.fn(async () => {});
    const logger = makeLogger();

    const daemon = new CallCaptureDaemon({
      detector,
      notificationGate: gate,
      checkDependencies: okDeps(),
      checkCallingAppRunning: blockAppRunning(),
      personalityId: 'receptionist',
      wake,
      runCapture: vi.fn(async () => {}),
      logger,
    });
    daemon.start();
    detector.emit({ type: 'call_started', at: 1000 });
    await flush();

    expect(wake).not.toHaveBeenCalled();
    expect(gate.offers).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('no known calling app is running'),
    );

    // A fresh call_started afterward proves the daemon returned to idle.
    detector.emit({ type: 'call_started', at: 2000 });
    await flush();
    expect(gate.offers).toHaveLength(0);
  });
});
