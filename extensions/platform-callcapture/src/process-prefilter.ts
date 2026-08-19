// Known-calling-app registry for call capture. Originally (Phase 4) a
// process-based coarse prefilter checked via `pgrep -x` alongside the
// mic-in-use signal (decision 1) — that pgrep-based check has since been
// REMOVED (see below), and this module now serves a narrower purpose: the
// canonical list of known calling-app process names (mirrored by hand into
// `native/mic-detector.swift`, which now does its own per-process app
// tracking natively — see that file's header comment) and the raw-process-
// name-to-clean-source-label lookup `detector.ts` uses when the native
// detector reports which app triggered a `call_started` event.
//
// WHY THE PGREP-BASED CHECK WAS REMOVED: the native detector now only ever
// watches known calling apps in the first place (via `NSWorkspace` +
// per-process CoreAudio properties — see native/mic-detector.swift). A
// `call_started` event is therefore ALREADY scoped to a known calling app by
// construction; there is no longer a separate "mic active but no known app
// running" case for a downstream process check to filter out (Dictation,
// Siri, Voice Memos, and a browser tab's `getUserMedia()` grant were never
// being watched by the new detector in the first place, so they never
// produce a `call_started` event at all). `checkAnyCallingAppRunning` /
// `CheckProcessRunning` / `defaultCheckProcessRunning` (the pgrep-based
// pieces) are gone; `CallCaptureDaemon` no longer takes a separate
// `checkCallingAppRunning` port — see daemon.ts.
//
// Deliberate, documented limitation, carried over from the original
// decision 1 design and UNCHANGED by this fold-in: this can only ever match
// known NATIVE app processes, so a browser tab running a web-based call
// (e.g. Google Meet in Chrome) is still not detected — Chrome/Safari/etc.
// are not calling-app-specific processes, and neither the old pgrep check
// nor the new per-process CoreAudio approach can distinguish a calling tab
// from any other tab. See this package's README.md for the user-facing
// note.

/**
 * Known macOS calling-app process (executable) names. A plain,
 * easily-extended array — no new config surface. Best-effort coverage of
 * common native calling apps, not an exhaustive registry. Deliberately
 * excludes browser processes (Chrome, Safari, ...) — see this file's header
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
