// NotificationGate — the "show + wait for accept" surface (plan/phases/
// call-capture-extension.md, "Phase 2 — Notification + accept gate spike").
// Shows the accept-gate UI (via the compiled `capture-offer-card` binary)
// and resolves a typed outcome once the offer settles.
//
// Fail-closed by construction (decision 5): every path that isn't an
// explicit accept-click resolves a non-`accepted` outcome — `expired`
// (caller's `.expire()`, an explicit Skip/"x" decline, or the card process
// failing to spawn/show) or `error` (preflight failed, or the card itself
// reported a genuine failure). None of these are silent — every outcome is
// an observable, typed result.
//
// SUPERSEDES notification-helper (`UNUserNotificationCenter`): that
// implementation itself superseded `terminal-notifier` (a real user's
// white-on-white banner — see README.md's "Native notification helper"
// section) but ran into a second, OS-version-specific rendering problem
// this package doesn't control either: macOS 26's system-wide "Liquid
// Glass" material washes out ALL notification banners, and
// `UNMutableNotificationContent` has no API surface that touches it. The
// fix this time is to stop asking the system to draw the surface at all:
// `native/capture-offer-card.swift` is a custom-drawn AppKit card (the same
// approach Granola's own "Meeting detected" UI uses), immune to system
// notification chrome by construction. See that file's header comment for
// the full design, and README.md's "native capture-offer card" section for
// the retire-vs-keep-notification-helper writeup. `notification-helper
// .swift` is fully retired from this package's runtime path (kept on disk
// for history, per this file's convention of leaving superseded code
// commented on rather than deleted the first time — this is now the SECOND
// supersession, so it too is being deleted; see README.md).
//
// The spawn boundary is injectable, mirroring `detector.ts`'s
// `SpawnFn`/`SpawnedChild` idiom exactly (one persistent child process per
// offer, NDJSON over stdout, `kill()` to tear down): real code spawns the
// real compiled binary via `defaultSpawn`; tests inject a fake and never
// really spawn it.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/**
 * The minimal shape `NotificationGate` needs from a spawned
 * `capture-offer-card` process. One process per offer (see
 * capture-offer-card.swift's header comment for why) — mirrors
 * `detector.ts`'s `SpawnedChild` idiom (persistent child, NDJSON stdout,
 * `kill()` to tear down), since this binary stays alive waiting for a
 * Start/Skip click.
 */
export interface CaptureOfferCardChild {
  readonly stdout: Readable;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type CaptureOfferCardSpawnFn = (binaryPath: string, args: string[]) => CaptureOfferCardChild;

function defaultBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'bin', 'capture-offer-card');
}

const BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:native';

function defaultSpawn(binaryPath: string, args: string[]): CaptureOfferCardChild {
  if (!existsSync(binaryPath)) {
    throw new Error(
      `capture-offer-card binary not found at ${binaryPath}. Build it with: ${BUILD_COMMAND}`,
    );
  }
  const child = nodeSpawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error('capture-offer-card child process was spawned without a stdout pipe');
  }
  return {
    stdout,
    onExit: (listener) => {
      child.on('exit', listener);
    },
    onError: (listener) => {
      child.on('error', listener);
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

export type CaptureOfferOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'expired' }
  | { outcome: 'error'; message: string };

export interface PresentCaptureOfferOptions {
  /** Identifies the call this offer is for; passed straight through as the
   * card process's `callId` argv so independent offers never collide. */
  callId: string;
  /** Historically the notification's title/body text. The card's own copy
   * ("Meeting detected" / the Skip-Start buttons) is fixed, matching
   * Granola's own fixed card text, so `capture-offer-card` doesn't read
   * these — kept on the options type unchanged so this remains a pure
   * internal implementation swap (`daemon.ts`'s call site is untouched) and
   * because `DesktopNotificationGate`'s own Electron-based card (a sibling
   * implementation of this same contract, see
   * apps/desktop/src/main/call-capture-notification-gate.ts) still renders
   * them. */
  title: string;
  message: string;
  /** The clean source label the daemon already resolved for this call (e.g.
   * `'zoom'` — `daemon.ts`'s `handleCallStarted`, sourced from
   * `process-prefilter.ts`), shown as the card's subtitle the same way
   * `capture-indicator.swift`'s badge shows it. Optional and additive: an
   * absent/empty value just omits the subtitle line. */
  source?: string;
}

export interface CaptureOfferHandle {
  /** Resolves once the offer settles: accepted, expired, or errored. */
  waitForOutcome(): Promise<CaptureOfferOutcome>;
  /**
   * Call when the underlying call has ended with no click yet. Closes the
   * card (SIGTERM — `capture-offer-card` handles this by closing its window
   * before exiting, see native/capture-offer-card.swift) and resolves the
   * outcome as `'expired'`. A no-op if the offer already settled (accepted,
   * declined, or never shown due to a spawn error).
   */
  expire(): Promise<void>;
}

export interface NotificationGateOptions {
  /** Overrides how `capture-offer-card` is actually spawned. Tests must
   * supply this — a fake — instead of really spawning it. */
  spawnFn?: CaptureOfferCardSpawnFn;
  /** Overrides the compiled binary path. Defaults to
   * `native/bin/capture-offer-card` next to this package. */
  binaryPath?: string;
}

function immediateErrorHandle(message: string): CaptureOfferHandle {
  return {
    waitForOutcome: () => Promise.resolve({ outcome: 'error', message }),
    expire: async () => {},
  };
}

export class NotificationGate {
  private readonly spawnFn: CaptureOfferCardSpawnFn;
  private readonly binaryPath: string;

  constructor(options: NotificationGateOptions = {}) {
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.binaryPath = options.binaryPath ?? defaultBinaryPath();
  }

  async presentCaptureOffer(opts: PresentCaptureOfferOptions): Promise<CaptureOfferHandle> {
    // Unlike `UNUserNotificationCenter`, a plain AppKit window needs no OS
    // authorization — there is nothing left to preflight here beyond "did
    // the process actually start," so a synchronous spawn failure (e.g. the
    // binary hasn't been built) is caught directly rather than routed
    // through a separate async `checkAvailable()` step.
    let child: CaptureOfferCardChild;
    try {
      child = this.spawnFn(this.binaryPath, [opts.callId, opts.source ?? '']);
    } catch (err) {
      return immediateErrorHandle(
        `capture-offer-card failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        resolveOnce({
          outcome: 'error',
          message: `capture-offer-card emitted an unparseable line: ${trimmed}`,
        });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        resolveOnce({
          outcome: 'error',
          message: `capture-offer-card emitted a non-object line: ${trimmed}`,
        });
        return;
      }
      const fields = parsed as Record<string, unknown>;
      switch (fields.event) {
        case 'accepted':
          resolveOnce({ outcome: 'accepted' });
          return;
        case 'declined':
          // An explicit Skip/"x" click. Resolved as `'expired'`, the same
          // outcome an unanswered offer settles to on `expire()` — NOT a new
          // `CaptureOfferOutcome` variant. A `'declined'` variant would be
          // more precise, but `daemon.ts`'s `handleCallStarted` narrows this
          // union with `if (outcome.outcome === 'expired') { ... } else {
          // ...outcome.message... }` — adding a third non-`accepted` member
          // would make that `else` branch (which assumes `error`'s
          // `message` field) fail to typecheck, forcing a `daemon.ts`
          // change to add a real branch for it. `daemon.ts`'s reaction is
          // identical either way (log, go idle), so the extra precision
          // isn't worth that cost — see README.md for the fuller writeup.
          resolveOnce({ outcome: 'expired' });
          return;
        case 'error':
          resolveOnce({
            outcome: 'error',
            message:
              typeof fields.message === 'string'
                ? fields.message
                : `capture-offer-card reported an error: ${trimmed}`,
          });
          return;
        case 'ready':
          // Just an ack that the window is on screen — still waiting for
          // Start/Skip or an expire().
          return;
        default:
          resolveOnce({
            outcome: 'error',
            message: `capture-offer-card emitted an unrecognized event: ${trimmed}`,
          });
      }
    });

    child.onError((err) => {
      resolveOnce({
        outcome: 'error',
        message: `capture-offer-card spawn failed: ${err.message}`,
      });
    });
    child.onExit((code) => {
      // A settled outcome (accepted/expired/error) already resolved before
      // its own natural exit in every normal path — this only fires for a
      // genuinely unexpected exit (e.g. a crash with no output).
      resolveOnce({
        outcome: 'error',
        message: `capture-offer-card exited unexpectedly (code=${code})`,
      });
    });

    return {
      waitForOutcome: () => outcomePromise,
      expire: async () => {
        if (settled) return;
        settled = true;
        const exited = new Promise<void>((resolve) => {
          child.onExit(() => resolve());
        });
        // SIGTERM is the whole dismiss protocol — see this file's header
        // comment and capture-offer-card.swift's for why no stdin command
        // channel is needed on top of it. Waiting for the process to
        // actually exit (rather than resolving the instant the signal is
        // sent) confirms the window actually closed, mirroring the
        // predecessor implementations' identical wait-for-exit contract.
        child.kill('SIGTERM');
        await exited;
        settleOutcome({ outcome: 'expired' });
      },
    };
  }
}
