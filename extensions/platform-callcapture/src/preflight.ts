// Dependency-presence preflight for Phase 4's combined preflight (below),
// covering every manual-install/build dependency call capture needs before
// a notification or capture attempt starts (plan/phases/
// call-capture-extension.md decision 5 / "Preflight" §6). Every
// dependency's absence must surface as a typed, named-fix error, never a
// swallowed `spawn ENOENT` or a silent no-op.
//
// This file used to also export `checkNotificationHelperAvailable` — a
// binary-presence + notification-authorization-status check for the (now
// twice-superseded) `terminal-notifier` -> `notification-helper`
// (`UNUserNotificationCenter`) accept-gate implementations. The current
// implementation, `native/capture-offer-card.swift`, is a plain AppKit
// window: it needs no OS authorization at all, so that whole
// authorization-status dimension no longer applies, and it's checked below
// with the same plain `existsSync` presence check every other native
// binary in this package already gets (mirroring
// `micDetectorBinaryPath()`/`micCapturePath()`) rather than a dedicated
// function. See notification.ts and README.md's "native capture-offer
// card" section for the full history.
//
// Mirrors `detector.ts`'s injectable spawn-boundary idiom throughout: real
// code spawns a real process; tests inject a fake and never depend on
// whether `build:native` has actually been run on the machine running the
// test suite.

import { existsSync as nodeExistsSync } from 'node:fs';
import { join } from 'node:path';

const AUDIOTEE_BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:audiotee';
const NATIVE_BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:native';

/** `native/bin/mic-detector` next to this package — same path `detector.ts`'s
 * own `defaultBinaryPath()` resolves, kept in sync deliberately rather than
 * imported, since preflight must be able to name the path without spawning
 * (or failing to spawn) the thing it's checking for. */
function micDetectorBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'bin', 'mic-detector');
}

/** `native/bin/mic-capture` — mirrors `mic-capture.ts`'s `defaultBinaryPath()`. */
function micCaptureBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'bin', 'mic-capture');
}

/** `native/vendor/audiotee/audiotee` — mirrors `tap-capture.ts`'s `defaultBinaryPath()`. */
function audioteeBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'vendor', 'audiotee', 'audiotee');
}

/** `native/bin/capture-offer-card` — mirrors `notification.ts`'s own
 * `defaultBinaryPath()`, kept in sync deliberately rather than imported,
 * same rationale as `micDetectorBinaryPath()` above. */
function captureOfferCardBinaryPath(): string {
  return join(import.meta.dirname, '..', 'native', 'bin', 'capture-offer-card');
}

export interface CheckCallCaptureDependenciesDeps {
  /** Overrides the binary-presence check for the four compiled/vendored
   * binaries. Tests must supply this — a fake — so the check never depends
   * on whether this machine has actually run `build:native`/`build:audiotee`. */
  existsSync?: (path: string) => boolean;
  /** Overrides the capture-offer-card binary path checked for presence.
   * Defaults to `captureOfferCardBinaryPath()`. Needed by bundled callers
   * (e.g. the desktop app's electron-vite main bundle) whose
   * `import.meta.dirname` no longer resolves to the source tree post-
   * bundling — same rationale as `builtinPersonalitiesDir` in
   * `@ethosagent/personalities`. Omitted, this is byte-identical to the
   * existing default. */
  captureOfferCardPath?: string;
  /** Overrides the mic-detector binary path checked for presence. Defaults
   * to `micDetectorBinaryPath()`. Needed by bundled callers (e.g. the
   * desktop app's electron-vite main bundle) whose `import.meta.dirname`
   * no longer resolves to the source tree post-bundling — same rationale as
   * `builtinPersonalitiesDir` in `@ethosagent/personalities`. Omitted, this
   * is byte-identical to the existing default. */
  micDetectorPath?: string;
  /** Overrides the mic-capture binary path checked for presence. Defaults
   * to `micCaptureBinaryPath()`. Same rationale as `micDetectorPath`. */
  micCapturePath?: string;
  /** Overrides the audiotee binary path checked for presence. Defaults to
   * `audioteeBinaryPath()`. Same rationale as `micDetectorPath`. */
  audioteePath?: string;
}

export type CallCaptureDependencyCheckResult =
  | { ok: true }
  | { ok: false; missing: string[]; errors: string[] };

/**
 * The single combined preflight call capture runs before a notification or
 * capture attempt starts (decision 5 / "Preflight" §6): every manual-install
 * or build-time dependency this package needs, checked together so a missing
 * dependency is a typed, named-fix error — never a swallowed `spawn ENOENT`
 * or a silent no-op. `ok: false` never swallows a failure: `missing` carries
 * short names for a one-line summary, `errors` carries every failing
 * dependency's full named message (never just the first).
 */
export async function checkCallCaptureDependencies(
  deps: CheckCallCaptureDependenciesDeps = {},
): Promise<CallCaptureDependencyCheckResult> {
  const existsSync = deps.existsSync ?? nodeExistsSync;

  const missing: string[] = [];
  const errors: string[] = [];

  const captureOfferCardPath = deps.captureOfferCardPath ?? captureOfferCardBinaryPath();
  if (!existsSync(captureOfferCardPath)) {
    missing.push('capture-offer-card');
    errors.push(
      `capture-offer-card binary not found at ${captureOfferCardPath}. Build it with: ${NATIVE_BUILD_COMMAND}`,
    );
  }

  const micDetectorPath = deps.micDetectorPath ?? micDetectorBinaryPath();
  if (!existsSync(micDetectorPath)) {
    missing.push('mic-detector');
    errors.push(
      `mic-detector binary not found at ${micDetectorPath}. Build it with: ${NATIVE_BUILD_COMMAND}`,
    );
  }

  const micCapturePath = deps.micCapturePath ?? micCaptureBinaryPath();
  if (!existsSync(micCapturePath)) {
    missing.push('mic-capture');
    errors.push(
      `mic-capture binary not found at ${micCapturePath}. Build it with: ${NATIVE_BUILD_COMMAND}`,
    );
  }

  const audioteePath = deps.audioteePath ?? audioteeBinaryPath();
  if (!existsSync(audioteePath)) {
    missing.push('audiotee');
    errors.push(
      `audiotee binary not found at ${audioteePath}. Build it with: ${AUDIOTEE_BUILD_COMMAND}`,
    );
  }

  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, errors };
}
