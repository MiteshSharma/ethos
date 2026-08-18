// Coarse process-based prefilter for call capture (plan/phases/
// call-capture-extension.md, decision 1): "Treat [process/app detection] as
// a coarse prefilter at best, not the detection signal itself." Mic-in-use
// (detector.ts) remains the actual detection trigger. This module answers a
// narrower, additional question — is at least one KNOWN calling app
// currently running? — so that any mic activity at all (Dictation, Siri,
// Voice Memos, a random website's getUserMedia() permission grant, ...)
// doesn't alone trigger a capture offer. `CallCaptureDaemon` requires BOTH
// signals to agree before offering a capture (see daemon.ts).
//
// Deliberate, documented limitation, carried over verbatim from decision 1:
// this checks process NAMES via `pgrep -x`, which cannot distinguish a
// browser tab running a web-based call (e.g. Google Meet in Chrome) from any
// other tab — Chrome/Safari/etc. are not calling-app-specific processes.
// `extensions/watchers`' own `process` differ notes the identical gap. A
// Meet call running in a browser will therefore NOT pass this prefilter and
// will not offer a capture, even though the mic-activity signal (decision
// 1's actual detection trigger) correctly fires for it. This is an accepted,
// pre-existing limitation of process-name detection — not something this
// module attempts to solve — see this package's README.md for the
// user-facing note.
//
// Mirrors extensions/watchers/src/differs.ts's `pgrepAlive` exactly (same
// `pgrep -x <name>` approach), but is deliberately NOT imported from
// `@ethosagent/watchers` — daemon.ts's header comment already establishes
// this package takes no dependency on that package (structural ports only,
// mirroring `detector.ts`/`notification.ts`'s idiom). This is a small, local
// equivalent, kept in sync by hand rather than shared.

import { execFile } from 'node:child_process';

/** Injectable process-alive check — mirrors `extensions/watchers/src/
 * differs.ts`'s `pgrepAlive` port pattern. Tests must supply this as a fake;
 * real code never shells out to `pgrep` in a test. */
export type CheckProcessRunning = (name: string) => Promise<boolean>;

/** `pgrep -x <name>` — true if a process with exactly that name is running. */
export function defaultCheckProcessRunning(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', name], (err) => resolve(!err));
  });
}

/**
 * Known macOS calling-app process names, checked via `pgrep -x`. A plain,
 * easily-extended array — no new config surface for this pass. Best-effort
 * coverage of common native calling apps, not an exhaustive registry.
 * Deliberately excludes browser processes (Chrome, Safari, ...) since those
 * cannot be distinguished from a non-calling tab — see this file's header
 * comment.
 */
export const KNOWN_CALLING_APP_PROCESSES: readonly string[] = [
  'zoom.us',
  'Microsoft Teams',
  'Discord',
  'Skype',
  'FaceTime',
  'Webex',
  'GoToMeeting',
];

/**
 * True if ANY of `processNames` is currently running. Short-circuits on the
 * first match; returns that match's raw process name, or `null` if none
 * matched. Defaults to `KNOWN_CALLING_APP_PROCESSES` checked via the real
 * `pgrep`-backed probe; both are overridable for tests.
 *
 * Returns the RAW process name (e.g. `'zoom.us'`, `'Microsoft Teams'`), not
 * a cleaned-up label — callers that need a filename-safe/human-readable
 * source (capture artifact keys, digest lines) should pass the result
 * through `sourceLabelForProcessName` below. Kept separate so this
 * function's job stays "which known process matched," not "how should that
 * be displayed."
 */
export async function checkAnyCallingAppRunning(
  processNames: readonly string[] = KNOWN_CALLING_APP_PROCESSES,
  checkProcessRunning: CheckProcessRunning = defaultCheckProcessRunning,
): Promise<string | null> {
  for (const name of processNames) {
    if (await checkProcessRunning(name)) return name;
  }
  return null;
}

/**
 * Maps a raw `KNOWN_CALLING_APP_PROCESSES` process name to a clean,
 * human-readable source label for capture artifact filenames and digest
 * lines (decision 7's `<source>-<date>-<time>.md` naming). Deliberately a
 * small explicit lookup table rather than running the raw name through
 * `sanitizeSource` (`extensions/tools-callcapture/src/artifact.ts`)
 * unmapped — `sanitizeSource('zoom.us')` alone would produce `'zoomus'`, not
 * the recognizable `'zoom'`. Any process name not in this table (there
 * shouldn't be one, since the only inputs are `KNOWN_CALLING_APP_PROCESSES`
 * members) falls back to the raw name, which `sanitizeSource` still cleans
 * up downstream.
 */
const CALLING_APP_SOURCE_LABELS: Readonly<Record<string, string>> = {
  'zoom.us': 'zoom',
  'Microsoft Teams': 'teams',
  Discord: 'discord',
  Skype: 'skype',
  FaceTime: 'facetime',
  Webex: 'webex',
  GoToMeeting: 'gotomeeting',
};

/** See `CALLING_APP_SOURCE_LABELS` above. */
export function sourceLabelForProcessName(processName: string): string {
  return CALLING_APP_SOURCE_LABELS[processName] ?? processName;
}
