// Desktop-owned CallCaptureDaemon lifecycle (plan/phases/
// call-capture-desktop-ux.md, P1). Mirrors `apps/ethos/src/commands/
// serve.ts`'s call-capture wiring block: same `CallCaptureOwnershipManager`
// + `CallCaptureDaemon` shape, same 10s heartbeat/retry cadence — but wired
// for the desktop main process, using `DesktopNotificationGate` instead of
// the bare native-helper `NotificationGate` (used only as its fallback), and
// with no `wake` callback (the desktop main process has no `WatcherManager`
// to source one from).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CallCaptureDaemon,
  type CallCaptureDaemonLogger,
  type CallCaptureIndicatorPort,
  CallCaptureOwnershipManager,
  callCaptureHealthPath,
  callCaptureLockPath,
  checkCallCaptureDependencies,
  MicActivityDetector,
  NotificationGate,
} from '@ethosagent/platform-callcapture';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CreateAgentLoopResult, WiringConfig } from '@ethosagent/wiring';
import { app } from 'electron';
import { DesktopNotificationGate } from './call-capture-notification-gate';
import {
  appendCallCaptureAudioLevel,
  appendCallCaptureTranscriptEntry,
  createCallCapturePillStateHandler,
  onCallCapturePillCloseRequested,
} from './call-capture-pill';

/**
 * Satisfies `CallCaptureDaemon`'s `CallCaptureIndicatorPort` so the daemon's
 * existing `onEndRequested` cancellation path (`handleCallEnded()`, shared
 * with `call_ended` and the max-duration safety net) also covers the pill's
 * own close button — the desktop analog of `capture-indicator.swift`'s
 * native "End" button.
 *
 * `show`/`hide` are no-ops: `createCallCapturePillStateHandler()`'s
 * `onStateChange` handler already shows/hides the pill window at
 * effectively the same moments (the capturing transition in/out) AND owns
 * `transcriptBuffer` reset and hover-state reset, which have no equivalent
 * on this port. Keeping it as the single source of truth for pill
 * visibility avoids two handlers racing to show/hide the same window.
 *
 * `updateTranscript` is a real delegate — the daemon's own `onEntry` relay
 * now flows through here instead of the direct closure `runCapture` used to
 * build (see the `runCapture` option below). `updateAudioLevel` is the same
 * shape of delegate for the daemon's `onAudioLevel` relay, feeding the
 * pill's own audio-level meter (`call-capture-pill.ts`'s "AUDIO LEVEL
 * METER" — the desktop analog of the native indicator's own in-progress
 * equivalent); the `at` timestamp isn't needed by the pill's meter, so it's
 * dropped here the same way this port's other delegates ignore arguments
 * they don't use.
 *
 * Exported (module-level, not behind `startCallCaptureDesktop`'s heavier
 * darwin/ownership-manager gate) so `__tests__/call-capture.test.ts` can
 * unit-test this wiring in isolation.
 */
export const desktopCallCaptureIndicator: CallCaptureIndicatorPort = {
  show: () => {},
  hide: () => {},
  updateTranscript: (entry) => appendCallCaptureTranscriptEntry(entry),
  updateAudioLevel: (speaker, level) => appendCallCaptureAudioLevel(speaker, level),
  onEndRequested: (callback) => onCallCapturePillCloseRequested(callback),
};

/**
 * Resolves an absolute path under call-capture's native-binaries root for
 * `relativeSuffix` (e.g. `'bin/mic-detector'`; `''` resolves the root
 * directory itself). Tries three candidates, in order:
 *
 * 1. The packaged app: `electron-builder.yml`'s `extraResources` copies
 *    `extensions/platform-callcapture/native/bin` and
 *    `extensions/platform-callcapture/native/vendor/audiotee` into
 *    `callcapture-native/` under `process.resourcesPath` — same convention
 *    `web-dist`/`assets/tray`/`assets/brand` already use there, and the same
 *    `app.isPackaged ? process.resourcesPath : app.getAppPath()` branch
 *    `call-capture-icon.ts`'s `iconAssetPath()` uses. Without this
 *    candidate, a packaged desktop build could never find these binaries at
 *    all — the two dev-tree candidates below only resolve inside an
 *    unbundled monorepo checkout, which a packaged app is not.
 * 2 & 3. Dev, unbundled monorepo checkout — the same two-candidate
 *    `__dirname`-relative technique `serve.ts` uses for
 *    `builtinPersonalitiesDir`. Needed because `import.meta.dirname`-based
 *    resolution inside the native binary wrappers (`detector.ts`,
 *    `mic-capture.ts`, `tap-capture.ts`, and `preflight.ts`'s mirrored
 *    helpers) points at the bundled main-process output dir after
 *    electron-vite, not the source tree.
 */
function resolveCallCaptureNativePath(relativeSuffix = ''): string | undefined {
  const candidates = [
    join(
      app.isPackaged ? (process.resourcesPath ?? '') : app.getAppPath(),
      'callcapture-native',
      relativeSuffix,
    ),
    join(__dirname, '..', '..', 'extensions', 'platform-callcapture', 'native', relativeSuffix),
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'extensions',
      'platform-callcapture',
      'native',
      relativeSuffix,
    ),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Root directory containing call-capture's native binaries, resolved the
 * same way `builtinPersonalitiesDir` is in `serve.ts`. `serve.ts` calls this
 * once and forwards the result both to `createAgentLoop()`'s
 * `callCaptureNativeDir` option (so the `TapCapture`/`MicCapture` instances
 * constructed inside `packages/wiring` resolve to the real binaries too) and
 * to `startCallCaptureDesktop()` below (for the `MicActivityDetector` and
 * `checkDependencies` this module constructs directly). Returns `undefined`
 * when the source tree isn't reachable (should not happen in a real bundled
 * or unbundled run, but a caller that omits it just gets each dependency's
 * own unchanged default).
 */
export function resolveCallCaptureNativeDir(): string | undefined {
  return resolveCallCaptureNativePath();
}

/** Same cadence `apps/ethos/src/commands/serve.ts` uses for both the
 * ownership-claim retry interval and the liveness heartbeat — reused here
 * rather than inventing a second interval (P0, plan/phases/
 * call-capture-desktop-ux.md). */
const CALL_CAPTURE_HEARTBEAT_INTERVAL_MS = 10_000;

const logger: CallCaptureDaemonLogger = {
  info: (msg) => console.log(`[call-capture] ${msg}`),
  warn: (msg) => console.warn(`[call-capture] ${msg}`),
  error: (msg) => console.error(`[call-capture] ${msg}`),
};

export interface CallCaptureDesktopHandle {
  stop(): Promise<void>;
}

/**
 * Constructs and starts the desktop-owned call-capture daemon when gated on
 * (`darwin` + `wiringConfig.callCapture.personalityId` set + `runCallCapture`
 * present — mirrors `serve.ts`'s gate exactly). Returns `null` and
 * constructs nothing otherwise.
 */
export function startCallCaptureDesktop(options: {
  wiringConfig: WiringConfig;
  runCallCapture: CreateAgentLoopResult['runCallCapture'];
  /** Root native-binaries dir, from `resolveCallCaptureNativeDir()` above.
   * Omitted, `MicActivityDetector` and `checkCallCaptureDependencies` both
   * fall back to their own unchanged `import.meta.dirname`-relative
   * defaults. */
  callCaptureNativeDir?: string;
  /**
   * This desktop instance's actual data directory, from `serve.ts`'s
   * `getDataDir()` (`store.get('dataDir') ?? ~/.ethos`) — threaded through
   * to `callCaptureLockPath()`/`callCaptureHealthPath()` so the ownership
   * lock and liveness heartbeat land wherever THIS install's data actually
   * lives, not unconditionally under `~/.ethos`. Omitted, both fall back to
   * their own unchanged `~/.ethos`-based default.
   */
  dataDir?: string;
}): CallCaptureDesktopHandle | null {
  const { wiringConfig, runCallCapture, callCaptureNativeDir, dataDir } = options;
  if (
    process.platform !== 'darwin' ||
    !wiringConfig.callCapture?.personalityId ||
    !runCallCapture
  ) {
    return null;
  }
  const boundPersonalityId = wiringConfig.callCapture.personalityId;
  const captureRunner = runCallCapture;
  const micDetectorPath = callCaptureNativeDir
    ? join(callCaptureNativeDir, 'bin', 'mic-detector')
    : undefined;
  const micCapturePath = callCaptureNativeDir
    ? join(callCaptureNativeDir, 'bin', 'mic-capture')
    : undefined;
  const audioteePath = callCaptureNativeDir
    ? join(callCaptureNativeDir, 'vendor', 'audiotee', 'audiotee')
    : undefined;
  // `capture-offer-card` is a bare binary, same as mic-detector/mic-capture
  // (no app-bundle wrapping — see capture-offer-card.swift's header comment
  // for why that's unique to `UNUserNotificationCenter`, which this doesn't
  // use) — same bundled-path-resolution problem `micDetectorPath`/
  // `micCapturePath`/`audioteePath` already solve.
  const captureOfferCardPath = callCaptureNativeDir
    ? join(callCaptureNativeDir, 'bin', 'capture-offer-card')
    : undefined;

  const ownershipManager = new CallCaptureOwnershipManager({
    lockPath: callCaptureLockPath(dataDir),
    retryIntervalMs: CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
    logger,
    // #4 (code review) — a LaunchAgent-hosted `ethos serve`/`ethos gateway`
    // is meant to run continuously, so in that common, intentional
    // deployment shape desktop loses the ownership claim on every startup
    // and its capture UI (offer card / pill) never activates. That's
    // expected, not a bug — but it must be observable, not silent
    // (ARCHITECTURE.md §V S7). `logger` above already logs a generic
    // "already running under PID X" line; this adds the desktop-specific
    // consequence once, on the initial claim only (never repeated on later
    // retry ticks — see `onClaimFailed`'s doc comment in `ownership.ts`).
    onClaimFailed: (ownerPid) => {
      logger.warn(
        `this desktop app's call-capture UI (offer card / pill) will not activate — PID ${ownerPid} ` +
          "(an 'ethos serve'/'ethos gateway' host, likely running as a LaunchAgent) already owns " +
          'call-capture ownership. Stop that process, or unset callCapturePersonalityId for this ' +
          'desktop instance, if you want desktop to own call-capture instead.',
      );
    },
    onOwnershipClaimed: () => {
      const daemon = new CallCaptureDaemon({
        detector: new MicActivityDetector(micDetectorPath ? { binaryPath: micDetectorPath } : {}),
        notificationGate: new DesktopNotificationGate({
          fallback: new NotificationGate(
            captureOfferCardPath ? { binaryPath: captureOfferCardPath } : {},
          ),
        }),
        checkDependencies: () =>
          checkCallCaptureDependencies({
            ...(micDetectorPath ? { micDetectorPath } : {}),
            ...(micCapturePath ? { micCapturePath } : {}),
            ...(audioteePath ? { audioteePath } : {}),
            ...(captureOfferCardPath ? { captureOfferCardPath } : {}),
          }),
        personalityId: boundPersonalityId,
        onStateChange: createCallCapturePillStateHandler(),
        indicator: desktopCallCaptureIndicator,
        runCapture: async (abortSignal, source, onEntry, onAudioLevel) => {
          const result = await captureRunner(boundPersonalityId, {
            abortSignal,
            source,
            // P3 — feeds each transcript entry into the pill's popover buffer
            // live, as it's yielded, rather than only after the call ends.
            // Forwards the daemon's own `onEntry` relay (which calls
            // `desktopCallCaptureIndicator.updateTranscript` above) instead
            // of a second direct closure to the same place.
            onEntry,
            // Forwards the daemon's own `onAudioLevel` relay (which calls
            // `desktopCallCaptureIndicator.updateAudioLevel` above), same
            // pattern as `onEntry` immediately above.
            onAudioLevel,
          });
          if (!result.ok) {
            logger.error(`capture failed: ${result.error}`);
            return;
          }
          if (result.warning) logger.warn(result.warning);
          logger.info(`saved transcript to ${result.artifactKey}`);
        },
        logger,
      });
      daemon.start();

      const storage = new FsStorage();
      const writeHeartbeat = async () => {
        try {
          await storage.writeAtomic(
            callCaptureHealthPath(dataDir),
            JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }),
          );
        } catch {
          // Best-effort — a missed tick is harmless; the consumer treats
          // stale/absent data as degraded.
        }
      };
      void writeHeartbeat();
      const heartbeatTimer = setInterval(
        () => void writeHeartbeat(),
        CALL_CAPTURE_HEARTBEAT_INTERVAL_MS,
      );
      heartbeatTimer.unref?.();

      return async () => {
        daemon.stop();
        clearInterval(heartbeatTimer);
        await storage.remove(callCaptureHealthPath(dataDir)).catch(() => {});
      };
    },
  });
  ownershipManager.start();

  return {
    stop: () => ownershipManager.stop(),
  };
}
