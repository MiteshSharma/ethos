// NotificationGate — the Phase 2 "show + wait for accept" surface (plan/
// phases/call-capture-extension.md, "Phase 2 — Notification + accept gate
// spike"). Shows an actionable `terminal-notifier` notification and
// resolves a typed outcome once the offer settles.
//
// Fail-closed by construction (decision 5): every path that isn't an
// explicit accept-click resolves a non-`accepted` outcome — `expired`
// (caller's `.expire()`, e.g. because the call ended unanswered) or `error`
// (preflight failed, or terminal-notifier itself failed to spawn/deliver).
// None of these are silent — every outcome is an observable, typed result.
//
// The command-runner is injectable, mirroring `detector.ts`'s `SpawnFn`
// injection idiom: real code spawns the real `terminal-notifier` binary via
// `defaultTerminalNotifierRun`; tests inject a fake and never really spawn
// it.

import { spawn as nodeSpawn } from 'node:child_process';
import { createClickListener } from './click-listener';
import { checkTerminalNotifierAvailable, type PreflightResult } from './preflight';

const TERMINAL_NOTIFIER_BIN = 'terminal-notifier';

export type TerminalNotifierRunResult = { ok: true } | { ok: false; error: string };

export type TerminalNotifierRunFn = (args: string[]) => Promise<TerminalNotifierRunResult>;

function defaultTerminalNotifierRun(args: string[]): Promise<TerminalNotifierRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = nodeSpawn(TERMINAL_NOTIFIER_BIN, args, { stdio: 'ignore' });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: `${TERMINAL_NOTIFIER_BIN} spawn failed: ${err.message}` });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, error: `${TERMINAL_NOTIFIER_BIN} exited with code ${code}` });
    });
  });
}

export type CaptureOfferOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'expired' }
  | { outcome: 'error'; message: string };

export interface PresentCaptureOfferOptions {
  /** Identifies the call this offer is for; used to derive a unique
   * `terminal-notifier -group` id so independent offers never collide. */
  callId: string;
  title: string;
  message: string;
}

export interface CaptureOfferHandle {
  /** Resolves once the offer settles: accepted, expired, or errored. */
  waitForOutcome(): Promise<CaptureOfferOutcome>;
  /**
   * Call when the underlying call has ended with no click yet. Withdraws
   * the OS notification (`terminal-notifier -remove <groupId>`) and
   * resolves the outcome as `'expired'`. A no-op if the offer already
   * settled (accepted, or never shown due to a preflight/spawn error).
   */
  expire(): Promise<void>;
}

export interface NotificationGateOptions {
  /** Overrides how `terminal-notifier` is actually invoked. Tests must
   * supply this — a fake — instead of really spawning it. */
  runFn?: TerminalNotifierRunFn;
  /** Overrides the preflight availability check. */
  checkAvailable?: () => Promise<PreflightResult>;
}

function groupIdFor(callId: string): string {
  return `ethos-callcapture-${callId}`;
}

function immediateErrorHandle(message: string): CaptureOfferHandle {
  return {
    waitForOutcome: () => Promise.resolve({ outcome: 'error', message }),
    expire: async () => {},
  };
}

export class NotificationGate {
  private readonly runFn: TerminalNotifierRunFn;
  private readonly checkAvailable: () => Promise<PreflightResult>;

  constructor(options: NotificationGateOptions = {}) {
    this.runFn = options.runFn ?? defaultTerminalNotifierRun;
    this.checkAvailable = options.checkAvailable ?? (() => checkTerminalNotifierAvailable());
  }

  async presentCaptureOffer(opts: PresentCaptureOfferOptions): Promise<CaptureOfferHandle> {
    const preflight = await this.checkAvailable();
    if (!preflight.available) {
      return immediateErrorHandle(preflight.error);
    }

    const listener = await createClickListener();
    const groupId = groupIdFor(opts.callId);

    let settled = false;
    let settleOutcome: (outcome: CaptureOfferOutcome) => void = () => {};
    const outcomePromise = new Promise<CaptureOfferOutcome>((resolve) => {
      settleOutcome = resolve;
    });
    const resolveOnce = (outcome: CaptureOfferOutcome): void => {
      if (settled) return;
      settled = true;
      settleOutcome(outcome);
    };

    listener.waitForHit().then(() => {
      resolveOnce({ outcome: 'accepted' });
      listener.close();
    });

    const execCommand = `curl -fsS ${listener.url}`;
    const showResult = await this.runFn([
      '-title',
      opts.title,
      '-message',
      opts.message,
      '-group',
      groupId,
      '-execute',
      execCommand,
    ]);

    if (!showResult.ok) {
      listener.close();
      resolveOnce({ outcome: 'error', message: showResult.error });
    }

    return {
      waitForOutcome: () => outcomePromise,
      expire: async () => {
        if (settled) return;
        settled = true;
        await this.runFn(['-remove', groupId]);
        listener.close();
        settleOutcome({ outcome: 'expired' });
      },
    };
  }
}
