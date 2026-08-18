// Dependency-presence preflight for Phase 2's notification mechanism, and
// (below) Phase 4's combined preflight covering every manual-install/build
// dependency call capture needs before a notification or capture attempt
// starts (plan/phases/call-capture-extension.md decision 5 / "Preflight"
// §6). Every dependency's absence must surface as a typed, named-fix error,
// never a swallowed `spawn ENOENT` or a silent no-op.
//
// Mirrors `detector.ts`'s injectable spawn-boundary idiom: real code spawns
// a real process via `defaultPreflightSpawn`; tests inject a fake and never
// depend on whether terminal-notifier happens to be installed on the
// machine running the test suite.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import { join } from 'node:path';

const TERMINAL_NOTIFIER_BIN = 'terminal-notifier';
const INSTALL_HINT = 'brew install terminal-notifier';

export type PreflightResult = { available: true } | { available: false; error: string };

export interface PreflightSpawnResult {
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (err: NodeJS.ErrnoException) => void): void;
}

export type PreflightSpawnFn = (command: string, args: string[]) => PreflightSpawnResult;

function defaultPreflightSpawn(command: string, args: string[]): PreflightSpawnResult {
  const child = nodeSpawn(command, args, { stdio: 'ignore' });
  return {
    onExit: (listener) => {
      child.on('exit', (code) => listener(code));
    },
    onError: (listener) => {
      child.on('error', listener);
    },
  };
}

/**
 * Checks whether `terminal-notifier` is present on `PATH`, by running its
 * side-effect-free `-help` flag (prints usage, exits 0 — never shows a real
 * notification). Resolves, never throws: a missing binary or any other
 * spawn failure comes back as a typed `{ available: false; error }` naming
 * the fix, not an unhandled `ENOENT`.
 */
export function checkTerminalNotifierAvailable(
  spawnFn: PreflightSpawnFn = defaultPreflightSpawn,
): Promise<PreflightResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnFn(TERMINAL_NOTIFIER_BIN, ['-help']);

    child.onError((err) => {
      if (settled) return;
      settled = true;
      if (err.code === 'ENOENT') {
        resolve({
          available: false,
          error: `${TERMINAL_NOTIFIER_BIN} not found on PATH. Install it with: ${INSTALL_HINT}`,
        });
        return;
      }
      resolve({
        available: false,
        error: `${TERMINAL_NOTIFIER_BIN} check failed: ${err.message}`,
      });
    });

    child.onExit((code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ available: true });
        return;
      }
      resolve({
        available: false,
        error: `${TERMINAL_NOTIFIER_BIN} -help exited with code ${code}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Phase 4 — combined dependency-presence preflight (T5)
// ---------------------------------------------------------------------------

const NATIVE_BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:native';
const AUDIOTEE_BUILD_COMMAND = 'pnpm --filter @ethosagent/platform-callcapture run build:audiotee';

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

export interface CheckCallCaptureDependenciesDeps {
  /** Overrides the `terminal-notifier` availability check. */
  checkTerminalNotifier?: () => Promise<PreflightResult>;
  /** Overrides the binary-presence check for the three compiled/vendored
   * binaries. Tests must supply this — a fake — so the check never depends
   * on whether this machine has actually run `build:native`/`build:audiotee`. */
  existsSync?: (path: string) => boolean;
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
  const checkTerminalNotifier = deps.checkTerminalNotifier ?? checkTerminalNotifierAvailable;
  const existsSync = deps.existsSync ?? nodeExistsSync;

  const missing: string[] = [];
  const errors: string[] = [];

  const notifier = await checkTerminalNotifier();
  if (!notifier.available) {
    missing.push('terminal-notifier');
    errors.push(notifier.error);
  }

  const micDetectorPath = micDetectorBinaryPath();
  if (!existsSync(micDetectorPath)) {
    missing.push('mic-detector');
    errors.push(
      `mic-detector binary not found at ${micDetectorPath}. Build it with: ${NATIVE_BUILD_COMMAND}`,
    );
  }

  const micCapturePath = micCaptureBinaryPath();
  if (!existsSync(micCapturePath)) {
    missing.push('mic-capture');
    errors.push(
      `mic-capture binary not found at ${micCapturePath}. Build it with: ${NATIVE_BUILD_COMMAND}`,
    );
  }

  const audioteePath = audioteeBinaryPath();
  if (!existsSync(audioteePath)) {
    missing.push('audiotee');
    errors.push(
      `audiotee binary not found at ${audioteePath}. Build it with: ${AUDIOTEE_BUILD_COMMAND}`,
    );
  }

  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, errors };
}
