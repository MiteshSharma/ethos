// CallCapturePill — the P2 recording-state pill (plan/phases/
// call-capture-desktop-ux.md). A small, non-interactive, always-on-top
// indicator shown while a call capture is in progress, sourced directly from
// `CallCaptureDaemon`'s `onStateChange` hook (`@ethosagent/platform-
// callcapture`) rather than by polling or duplicating the daemon's state
// machine.
//
// Lazy-created singleton window, mirroring `quick-chat-window.ts`'s and
// `call-capture-notification-gate.ts`'s idiom: `showCallCapturePill()`
// creates it on first use, then hides-and-reuses it across every subsequent
// call for the life of the app. It is never explicitly destroyed by this
// module's own logic — only Electron's own `closed` event (a safety net, not
// a normal code path here) clears the module-level reference so a later
// `showCallCapturePill()` call recreates it if that ever fires.
//
// --- P3/P4: live transcript popover (plan/phases/call-capture-desktop-ux.md) ---
//
// TRIGGER — hover, not click: an earlier version of this file used a click
// trigger, reasoning that Electron's `BrowserWindow` exposes no native hover
// event. A later version used DOM `mouseenter`/`mouseleave` listeners on the
// loaded page's own content, observed from the main process via the same
// `will-navigate` interception `call-capture-notification-gate.ts` uses for
// click. That was dropped too: Electron has a filed report —
// electron/electron#45246, closed "not planned" (i.e. acknowledged, not
// going to be fixed, so it still applies to the Electron version this app is
// on) — of `mouseenter`/`mouseleave`/`mouseover`/`mouseout` misbehaving
// specifically in unfocused windows on macOS: a spurious `mouseleave` right
// after `mouseenter`, and no `mouseleave` at all on genuine cursor-exit. Both
// this pill and its popover are always shown via `showInactive()` and never
// become key, so they hit this bug on every real use.
//
// The current implementation instead drives hover from the MAIN process:
// `pollCursor()` runs on a `CURSOR_POLL_INTERVAL_MS` interval (started in
// `showCallCapturePill()`, stopped in `hideCallCapturePill()`) and compares
// `screen.getCursorScreenPoint()` against `pillWindow.getBounds()` /
// `popoverWindow.getBounds()` via `syncHoverState()`. This sidesteps
// #45246 entirely — it never goes through the renderer's mouse-event
// pipeline the bug lives in, so it works identically whether the window is
// focused or not. `handlePillHoverEnter`/`handlePillHoverLeave`/
// `handlePopoverHoverEnter`/`handlePopoverHoverLeave` keep their original
// bodies (open/close the popover, manage the debounce below); only their
// caller changed, from `will-navigate` URL routing to `syncHoverState`'s
// transition detection. The close button (see "CLOSE BUTTON" below) still
// rides `will-navigate`, since `click`/`mousedown`/`mouseup` are not part of
// the #45246 report and remain reliable on an unfocused window.
//
// COMBINED HOVER REGION — the popover stays open as long as the cursor is
// over the pill OR the popover (`pillHovered || popoverHovered`), so moving
// the mouse across the small gap between them (to read/scroll the
// transcript) doesn't flicker it shut. Opening is always immediate; closing
// is debounced by `HOVER_CLOSE_DEBOUNCE_MS` to absorb the brief moment
// neither region reports hovered while the cursor crosses that gap.
//
// FULL-HEIGHT LAYOUT — `buildPillHtml`/`buildPopoverHtml` set `height: 100%`
// on `html, body` so the `height: 100%` already declared on their content
// containers (`.pill`, `#transcript`) resolves against a real number instead
// of CSS's default `height: auto`, which is what actually vertically centers
// `.pill`'s icon/label/meter/close-button row and lets `#transcript` fill the
// popover for scrolling. This used to also be load-bearing for hover
// hit-testing (a collapsed `<body>` meant most of the pill had no DOM
// hover coverage); it no longer is, now that hover is driven by
// `pollCursor()` comparing the cursor against the window's own
// `getBounds()` rather than by DOM mouse events at all (see "TRIGGER"
// above) — but the layout reason for keeping `height: 100%` stands on its
// own.
//
// DRAGGABLE (pill only, plan/phases/call-capture-desktop-ux.md) —
// `-webkit-app-region: drag` was the first thing tried, since it is
// Electron's documented mechanism for a frameless window's move-by-
// background region. It was dropped: Electron's own docs state plainly that
// "draggable areas ignore all pointer events" — including "mouse enter/exit
// events" — for anything inside them, and it would have collided with the
// pill's own hover/drag tracking (see below) even before that. This is the
// same shape of fix `capture-indicator.swift`'s "DRAGGABLE" comment
// documents for the native indicator: a framework-provided "should just
// work" drag mechanism (`isMovableByWindowBackground` there,
// `-webkit-app-region: drag` here) turned out not to, once actually checked
// against what it needed to coexist with.
//
// Dragging is tracked from the MAIN process, the same `pollCursor()` loop
// "TRIGGER" above describes for hover. The renderer's only job is signaling
// gesture boundaries: `mousedown` on the pill navigates to
// `ethos-callcapture-pill://drag-start`, `mouseup` navigates to
// `.../drag-end` — both plain click-family events, unaffected by #45246, so
// this stays reliable on an unfocused window. In between, `pollCursor()`
// diffs each tick's `screen.getCursorScreenPoint()` against the PREVIOUS
// tick's (not the drag's start) and applies that delta to the window's
// CURRENT frame (`applyPillDrag`) — anchoring to the current frame each tick
// is what keeps a multi-step drag from drifting, same principle as the old
// per-`mousemove` implementation, just computed from OS-level cursor polling
// instead of a DOM event fired once per raw mouse-move. This is a deliberate
// improvement over the earlier per-`mousemove` `window.location.href`
// navigation: a drag could fire dozens of navigations a second; polling at
// `CURSOR_POLL_INTERVAL_MS` bounds that to a fixed, low-overhead cadence
// regardless of how fast the mouse actually moves, and — like hover — it
// no longer depends on mouse-move events reaching an unfocused renderer at
// all.
//
// DOM-UPDATE APPROACH — `webContents.executeJavaScript()` from the main
// process, no preload script, per the plan's own suggested approach. Every
// transcript entry is pushed into the popover's DOM via `textContent`
// assignment (built with `document.createElement`/`createTextNode`, never
// `innerHTML` or string-concatenated markup), so untrusted call-participant
// speech can never be interpreted as HTML — the same "never let untrusted
// content get parsed" discipline `tools-callcapture/src/artifact.ts`'s
// `wrapUntrusted()` applies to the saved transcript file.
//
// BUFFER OWNERSHIP — the accumulated transcript for the current call lives
// in this module (`transcriptBuffer`), not in the popover window's own DOM.
// Closing and reopening the popover mid-call re-renders the full buffer
// instead of starting empty, and the buffer survives even while no popover
// window exists at all (the common case — most of a call happens with the
// popover closed). Reset on every idle→capturing transition (a fresh call
// starts clean) and cleared again on the capturing→idle transition (so nothing
// leaks into the next call).
//
// POPOVER ANCHORING — `getPopoverWindowPosition()` reads the pill window's
// REAL CURRENT bounds (`pillWindow.getBounds()`), not the theoretical
// default position `getPillWindowPosition()` computes. The pill is
// user-draggable (see "DRAGGABLE" above); anchoring to the default position
// instead of the live one meant the popover kept appearing wherever the
// pill started, not wherever it had actually been dragged to. It also picks
// above-vs-below relative to the pill: directly above is preferred (the
// original behavior, which reads fine when the pill sits in its default
// bottom-right corner), but if the pill has been dragged somewhere without
// enough work-area headroom above it — e.g. near the top of the screen —
// it flips to showing the popover snug below the pill instead, rather than
// letting it run off-screen or leaving an awkward gap. It also horizontally
// clamps within the work area, since the popover is right-aligned to the
// pill by default and a pill dragged near the left edge would otherwise put
// the popover's left edge off-screen.
//
// DRAG-WHILE-POPOVER-OPEN — dragging the pill while the popover is open
// closes the popover immediately (`applyPillDrag`) rather than
// live-repositioning it on every poll tick with a nonzero delta.
// Continuously re-deriving and re-applying the popover's position on each
// one would either flicker it around or leave it visibly lagging behind the
// pill — both worse than just closing it. It does not reopen automatically
// just because the drag ends: `pillHovered` stays continuously true for the
// duration of a typical drag (the cursor doesn't leave the pill's bounds
// mid-drag), so `pollCursor()`'s per-tick `syncHoverState()` — which keeps
// running throughout the drag, not just after it — never sees a false→true
// transition to act on. A genuine re-hover (the cursor leaves the pill,
// then re-enters) is what reopens it, at the correct, up-to-date position
// via the anchoring fix below, same as any other hover-enter.
//
// CLOSE BUTTON — a small "x" in the pill's top-right corner, the desktop
// analog of `capture-indicator.swift`'s native "End" button, both ultimately
// wired to the same `CallCaptureDaemon.handleCallEnded()` cancellation path
// via `CallCaptureIndicatorPort.onEndRequested`. It rides the same
// `will-navigate` URL-interception channel as hover/drag above (no preload,
// no contextBridge). The tricky part is coexisting with "DRAGGABLE" above:
// `document.body`'s own `mousedown` listener starts a drag on ANY mousedown
// inside the pill, including on this button, unless the button's own
// bubble-phase `mousedown` listener calls `event.stopPropagation()` first —
// since the button is a descendant of body, its listener runs before body's
// in the bubble phase, so this reliably suppresses the drag-start. This
// module tracks the registered callback the same single-slot way
// `indicator.ts` tracks `endRequestedCallback` for the native indicator's
// "End" button — one pill singleton, so no per-instance factory is needed.
//
// AUDIO LEVEL METER — a small 3-bar meter sitting in the pill's flex row,
// after `.label` and before the absolutely-positioned `.close-btn` (per the
// user's own placement request: "right section after zoom"). Fed by
// `CallCaptureIndicatorPort.updateAudioLevel`, wired in `call-capture.ts`
// exactly like `updateTranscript`, at roughly the daemon's ~100-200ms
// cadence — much faster than the first transcript line (one per ~8s STT
// window), so it's the fast "yes, capture is actually running" signal.
// Pushed into the ALREADY-LOADED pill window's DOM the same
// `webContents.executeJavaScript()` main→renderer mechanism the transcript
// popover's `buildAppendScript` already established (see "DOM-UPDATE
// APPROACH" below) — this is a different direction than hover/drag/close,
// which flow renderer→main over `will-navigate`, but the same direction
// `appendCallCaptureTranscriptEntry` already solves, so it reuses that exact
// pattern rather than inventing a second one.
//
// The daemon reports levels per speaker (`Speaker = 'you' | 'other'`), but
// the meter itself is a single combined indicator, not two — "a voice
// movement UI", singular, was the ask. `audioLevels` (module-level, mirrors
// `transcriptBuffer`'s ownership) tracks the latest reading per speaker; the
// meter always displays the louder of the two, so it moves whenever EITHER
// party is talking. Reset on both the idle→capturing and capturing→idle
// transitions for the same "nothing leaks into the next call" reason
// `transcriptBuffer` is reset there — though in practice a fresh
// `showCallCapturePill()` reload already zeroes the rendered bars, since
// they're rebuilt from scratch HTML each time.
//
// No buffer-replay concern like the transcript popover has: the meter lives
// in the PILL itself, which is already visible for the entire capturing
// window (unlike the popover, which opens/closes on hover), so there is
// never a "reopen and catch up" case to handle.
//
// Smoothing is CSS-only (`transition` on each bar's `height`/`opacity`) —
// simpler than a JS exponential-moving-average and sufficient to keep a
// 100-200ms update cadence from looking jittery, per this file's existing
// bias toward the simplest mechanism that reads cleanly.

import type { DaemonState, Speaker, TranscriptEntry } from '@ethosagent/platform-callcapture';
import { BrowserWindow, screen, session } from 'electron';
import { resolveCallCaptureIconDataUri } from './call-capture-icon';

// ISOLATED SESSION — `index.ts`'s `setupSpaCsp()` installs a global
// `script-src 'self'` CSP on `session.defaultSession` (protecting the main
// chat SPA window), which every `BrowserWindow` uses by default. That CSP
// has no `'unsafe-inline'`, so it silently blocks the inline `<script>` this
// file's `data:` pages rely on for all of their interactivity (hover, drag,
// close button, audio meter). Both windows below use this dedicated,
// non-persistent partition instead, so the default session's CSP never
// applies to them. Looked up lazily (not at module load) since `session`
// APIs require `app` to be ready. Same partition name for both — Electron
// returns the same in-memory session instance for repeated `fromPartition()`
// calls with the same name, avoiding two redundant sessions.
function pillSession() {
  return session.fromPartition('call-capture-pill', { cache: false });
}

// Fixed, opaque colors — same "FORCED LIGHT APPEARANCE, FIXED COLORS"
// reasoning `capture-offer-card.swift`'s header comment documents, applied
// here to the pill/popover's dark surface instead of a light one: a
// translucent system material (the `vibrancy: 'hud'` this file used to set)
// washes out unpredictably depending on what's behind the window and the
// OS's Light/Dark Mode setting. Drawing one fixed, solid background
// ourselves — the same near-black tone the popover already used, just
// without the alpha channel that relied on vibrancy showing through it —
// is what makes both windows legible unconditionally.
const SURFACE_BACKGROUND = '#1c1c1e';
const PRIMARY_BLUE = '#2f7dfa';

const PILL_WIDTH = 180;
const PILL_HEIGHT = 44;
/** Small inset from the primary display's work-area edges. */
const SCREEN_MARGIN = 16;

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 240;
/** Gap between the pill and the popover anchored above it. */
const POPOVER_GAP = 8;

/** Cadence for the main-process `pollCursor()` loop driving hover and drag
 * (see this file's header comment, "TRIGGER") — reasonably responsive
 * without polling `screen.getCursorScreenPoint()` wastefully often. 75ms
 * (~13 checks/sec) sits inside the file's own "if hover-close over 150ms
 * still reads as responsive" precedent (`HOVER_CLOSE_DEBOUNCE_MS`): a
 * hover/drag update lands within one poll tick, well under half that
 * debounce window, so it never reads as lag. */
export const CURSOR_POLL_INTERVAL_MS = 75;

/** Resting vs. fully-loud bar height for the audio-level meter — see this
 * file's header comment ("AUDIO LEVEL METER"). The MIN/MAX gap (the
 * "swing") is what determines how much the meter visibly moves for a given
 * input level; it was widened from an original 4-16px (12px swing) to
 * roughly 1.6x that (19px swing) per user feedback that the original swing
 * read as too subtle, WITHOUT touching the already-tuned sqrt(level)*1.1
 * perceptual curve in `window.__ethosUpdateAudioLevel` below (increasing
 * that gain further risks saturating/pinning the meter at max for
 * realistic speech volumes — this widens the PHYSICAL pixel range the same
 * curve output maps onto instead). MIN stays unchanged (a meter invisible
 * at rest is a regression); 23px still sits comfortably inside the 44px-
 * tall pill (vertically centered via `.pill`'s `align-items: center`), and
 * the bars' fixed 3px width means this height change doesn't affect their
 * horizontal footprint next to the label or close button. */
const METER_MIN_HEIGHT = 4;
const METER_MAX_HEIGHT = 23;

let pillWindow: BrowserWindow | null = null;
let popoverWindow: BrowserWindow | null = null;

/** The current call's accumulated transcript — see this file's header
 * comment ("BUFFER OWNERSHIP") for why it lives here rather than in the
 * popover window's own DOM state. */
let transcriptBuffer: TranscriptEntry[] = [];

/** Latest reported level per speaker for the current call — see this file's
 * header comment ("AUDIO LEVEL METER"). The meter always displays the
 * louder of the two. Reset alongside `transcriptBuffer` on every
 * idle→capturing/capturing→idle transition. */
let audioLevels: Record<Speaker, number> = { you: 0, other: 0 };

/** Combined hover-region tracking — see this file's header comment
 * ("COMBINED HOVER REGION"). */
let pillHovered = false;
let popoverHovered = false;
let closeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** The `pollCursor()` interval driving hover/drag — see this file's header
 * comment ("TRIGGER"). Running only while the pill exists (started in
 * `showCallCapturePill()`, stopped in `hideCallCapturePill()`), not for the
 * whole app lifetime. */
let cursorPollTimer: ReturnType<typeof setInterval> | null = null;
/** Whether a pill drag gesture is currently in progress — set by
 * `handlePillDragStart`/`handlePillDragEnd`, consumed by `pollCursor()`. */
let dragging = false;
/** The cursor's screen position as of the last poll tick (or drag-start) —
 * `pollCursor()` diffs against this to compute each drag step, and
 * `handlePillDragStart` re-syncs it so the drag's first step is only the
 * movement since mousedown, not since the previous, possibly-stale tick. */
let lastCursorPoint = { x: 0, y: 0 };
/** How long to wait, after the cursor leaves both the pill and the popover,
 * before actually closing — long enough to cross the `POPOVER_GAP` between
 * them, short enough that lingering after a genuine mouse-away still reads
 * as responsive. */
const HOVER_CLOSE_DEBOUNCE_MS = 150;

/** The pill's close-button callback — see this file's header comment
 * ("CLOSE BUTTON"). Single module-level slot, not a factory: there is
 * exactly one pill window singleton, not one per daemon instance. */
let closeRequestedCallback: (() => void) | null = null;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPillHtml(source: string): string {
  const label = escapeHtml(source);
  const iconDataUri = resolveCallCaptureIconDataUri();
  // Real Ethos branding, clipped to a circle — matching
  // `capture-indicator.swift`'s `BadgeView` icon treatment — rather than the
  // plain colored dot this used to be. Falls back to a brand-blue circle
  // (never the bare red dot) when the icon asset can't be resolved, the same
  // "decoration, never load-bearing" fallback that file's own header comment
  // describes for its badge.
  //
  // BACKGROUND-IMAGE, NOT <img> — `icon-1024.png` is not itself circular: it's
  // a rounded-square glyph inset from the canvas edges by an opaque WHITE
  // margin (not transparent — the PNG has an alpha channel, but every pixel
  // in it is fully opaque). A plain `<img>` with `border-radius: 50%` clips a
  // circle whose diameter equals the full image width, which is tangent to
  // the image's own edges at the four compass points — exactly where that
  // white margin lives, since the icon's rounded-square silhouette is inset
  // from the edge there. The result, confirmed by pixel-level inspection of a
  // real render at the pill's actual ~22px display size: solid white pixels
  // leaking through right on the circle boundary at 12/3/6/9 o'clock, which
  // reads as jagged/rough edges against the dark pill background. A
  // `background-image` on the already-circular `.icon` element, sized larger
  // than its own box (`background-size`), crops that margin away before the
  // circular clip is applied — same fix shape as physically zooming a photo
  // in before cropping it to a circle.
  const icon = iconDataUri
    ? `<div class="icon" style="background-image: url('${iconDataUri}')"></div>`
    : `<div class="icon-fallback"></div>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: ${SURFACE_BACKGROUND};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #f5f5f5;
    user-select: none;
  }
  .pill {
    box-sizing: border-box;
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 100%;
    padding: 0 14px;
  }
  .icon,
  .icon-fallback {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
  }
  .icon {
    /* 112% (not 100%) zooms past the source PNG's own white margin before
       the circular clip above is applied — see this function's "BACKGROUND-
       IMAGE, NOT <img>" comment for why 100% leaks white pixels onto the
       circle's edge at the pill's actual display size. */
    background-size: 112% 112%;
    background-position: center;
    background-repeat: no-repeat;
  }
  .icon-fallback {
    background: ${PRIMARY_BLUE};
  }
  .label {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meter {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .meter-bar {
    width: 3px;
    height: ${METER_MIN_HEIGHT}px;
    border-radius: 1.5px;
    background: ${PRIMARY_BLUE};
    opacity: 0.35;
    transition: height 120ms ease-out, opacity 120ms ease-out;
  }
  .close-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    font-size: 11px;
    color: #f5f5f5;
    background: rgba(255, 255, 255, 0.12);
    cursor: pointer;
  }
  .close-btn:hover {
    background: rgba(255, 255, 255, 0.24);
  }
</style>
</head>
<body>
  <div class="pill">
    ${icon}
    <div class="label">${label}</div>
    <div class="meter" id="level-meter" aria-hidden="true">
      <div class="meter-bar"></div>
      <div class="meter-bar"></div>
      <div class="meter-bar"></div>
    </div>
    <button type="button" class="close-btn" aria-label="End capture">&times;</button>
  </div>
  <script>
    // Audio-level meter — see this file's header comment ("AUDIO LEVEL
    // METER"). Each bar scales by its own multiplier off the same level so
    // the three don't move in perfect lockstep, then relies on this
    // element's own CSS \`transition\` (not JS) for the update-to-update
    // smoothing. window.__ethosUpdateAudioLevel is invoked from the main
    // process via executeJavaScript, mirroring how buildAppendScript reaches
    // into the popover's DOM.
    var meterBars = Array.prototype.slice.call(document.querySelectorAll('.meter-bar'));
    var METER_BAR_SCALES = [0.55, 1, 0.8];
    window.__ethosUpdateAudioLevel = function (level) {
      var clamped = Math.max(0, Math.min(1, level));
      // Perceptual curve — raw RMS levels for normal conversational speech
      // sit low relative to full-scale/clipping audio, so mapping them
      // linearly onto bar height barely moves the meter. sqrt() compresses
      // the low-to-mid range outward (typical speech reads as visibly
      // larger) while still saturating at 1.0 for genuinely loud audio; the
      // 1.1x gain on top gives typical speech a further nudge without
      // routinely pinning the meter at max. Same curve/constants as
      // capture-indicator.swift's updateAudioLevel, so both platforms read
      // the same for the same input level.
      var perceptual = Math.min(1, Math.sqrt(clamped) * 1.1);
      meterBars.forEach(function (bar, i) {
        var scaled = Math.min(1, perceptual * (METER_BAR_SCALES[i] || 1));
        bar.style.height = (${METER_MIN_HEIGHT} + scaled * (${METER_MAX_HEIGHT} - ${METER_MIN_HEIGHT})) + 'px';
        bar.style.opacity = String(0.35 + scaled * 0.65);
      });
    };

    // Hover is driven from the main process (\`pollCursor()\` against
    // \`getBounds()\`), not from DOM mouseenter/mouseleave — see this file's
    // header comment ("TRIGGER") for why. This page reports nothing for it.

    // Drag gesture boundaries only — see this file's header comment
    // ("DRAGGABLE") for why -webkit-app-region: drag isn't used here, and
    // why the actual drag delta is computed by the main process's cursor
    // polling rather than a per-mousemove report from this page.
    document.body.addEventListener('mousedown', function () {
      window.location.href = 'ethos-callcapture-pill://drag-start';
    });
    document.addEventListener('mouseup', function () {
      window.location.href = 'ethos-callcapture-pill://drag-end';
    });

    // Close button — see this file's header comment ("CLOSE BUTTON").
    // stopPropagation() runs before document.body's own mousedown listener
    // above (bubble-phase order), so clicking this button never starts a
    // drag.
    var closeBtn = document.querySelector('.close-btn');
    closeBtn.addEventListener('mousedown', function (event) {
      event.stopPropagation();
      event.preventDefault();
    });
    closeBtn.addEventListener('click', function () {
      window.location.href = 'ethos-callcapture-pill://close';
    });
  </script>
</body>
</html>`;
}

function buildPopoverHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: ${SURFACE_BACKGROUND};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #f5f5f5;
    user-select: none;
  }
  #transcript {
    box-sizing: border-box;
    height: 100%;
    overflow-y: auto;
    padding: 10px 12px;
  }
  #transcript:empty::after {
    content: "Waiting for speech…";
    font-size: 12px;
    opacity: 0.5;
  }
  .entry {
    font-size: 12px;
    line-height: 1.4;
    margin-bottom: 6px;
    word-break: break-word;
  }
  .speaker {
    font-weight: 600;
    opacity: 0.75;
  }
</style>
  <!-- Hover is driven from the main process (\`pollCursor()\` against
       \`getBounds()\`), not from DOM mouseenter/mouseleave — see
       call-capture-pill.ts's header comment ("TRIGGER"). This page needs no
       script of its own. -->
</head>
<body>
  <div id="transcript"></div>
</body>
</html>`;
}

function getPillWindowPosition(width: number, height: number): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(workArea.x + workArea.width - width - SCREEN_MARGIN);
  const y = Math.round(workArea.y + workArea.height - height - SCREEN_MARGIN);
  return { x, y };
}

/**
 * Anchored to the pill's REAL CURRENT bounds — see this file's header
 * comment ("POPOVER ANCHORING") for why not the theoretical default
 * position, and for the above-vs-below / horizontal-clamp behavior below.
 * Falls back to the default position only when no pill window exists yet
 * (shouldn't happen in practice — the popover only ever opens in response
 * to a hover event on the already-created pill), as a defensive floor
 * rather than an assumption the invariant always holds.
 */
function getPopoverWindowPosition(): { x: number; y: number } {
  const anchor =
    pillWindow && !pillWindow.isDestroyed()
      ? pillWindow.getBounds()
      : {
          ...getPillWindowPosition(PILL_WIDTH, PILL_HEIGHT),
          width: PILL_WIDTH,
          height: PILL_HEIGHT,
        };
  const workArea = screen.getPrimaryDisplay().workArea;

  // Prefer directly above the pill; flip below if that would run past the
  // top of the work area (e.g. the pill was dragged up near the top of the
  // screen).
  const above = anchor.y - POPOVER_HEIGHT - POPOVER_GAP;
  const below = anchor.y + anchor.height + POPOVER_GAP;
  const y = above >= workArea.y ? above : below;

  // Right-aligned to the pill by default, clamped within the work area so a
  // pill dragged near the left/right edge doesn't push the popover off-screen.
  const rightAligned = anchor.x + anchor.width - POPOVER_WIDTH;
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - POPOVER_WIDTH;
  const x = Math.min(Math.max(rightAligned, minX), maxX);

  return { x: Math.round(x), y: Math.round(y) };
}

function createPillWindow(): BrowserWindow {
  const { x, y } = getPillWindowPosition(PILL_WIDTH, PILL_HEIGHT);
  const win = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    // The pill must never steal keyboard focus or become the frontmost app.
    // This used to be `focusable: false`, but Electron documents no macOS
    // behavior for that flag beyond the flag itself (its documented side
    // effects — `skipTaskbar` implication, WM interaction — are Windows/
    // Linux-only), so the previous claim that it's harmless for mouse/hover
    // delivery here was never actually verified. `type: 'panel'` is
    // Electron's documented, purpose-built mechanism for exactly this case
    // on macOS — it adds `NSWindowStyleMaskNonactivatingPanel`, the same
    // style mask `capture-indicator.swift`'s native equivalent already uses
    // via `NSPanel` + `.nonactivatingPanel` — so a click here can bring the
    // window forward without activating the Ethos app, while
    // `showInactive()` below still shows it without activating anything up
    // front. macOS-only: `'panel'` isn't a valid `type` value on the other
    // platforms this option supports.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    // Fixed, opaque background on every platform — no `vibrancy`, no
    // `transparent`. See this file's top-of-file comment ("FORCED LIGHT
    // APPEARANCE, FIXED COLORS") for why a translucent system material is
    // the bug, not a look worth keeping.
    backgroundColor: SURFACE_BACKGROUND,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Isolated session — see this file's header comment ("ISOLATED
      // SESSION") for why this must not use `session.defaultSession`.
      session: pillSession(),
    },
  });
  // Render above a fullscreen app's own macOS Space (e.g. Zoom running
  // fullscreen) — same recipe as `call-capture-notification-gate.ts`.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Hover is no longer reported over `will-navigate` — see this file's
  // header comment ("TRIGGER") — so this only handles drag gesture
  // boundaries and the close button, both plain click-family events.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith('ethos-callcapture-pill://drag-start')) {
      handlePillDragStart();
    } else if (url.startsWith('ethos-callcapture-pill://drag-end')) {
      handlePillDragEnd();
    } else if (url.startsWith('ethos-callcapture-pill://close')) {
      handlePillCloseRequested();
    }
  });
  return win;
}

function createPopoverWindow(): BrowserWindow {
  const { x, y } = getPopoverWindowPosition();
  const win = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // Read-only display — no interaction beyond scrolling — but focusable
    // (unlike the pill) so the popover can actually receive scroll input.
    show: false,
    // Fixed, opaque background — same reasoning as the pill window above.
    backgroundColor: SURFACE_BACKGROUND,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Isolated session — see this file's header comment ("ISOLATED
      // SESSION").
      session: pillSession(),
    },
  });
  // Same fullscreen-Space + no-focus-steal recipe as the pill above. No
  // `will-navigate` listener: the popover's page has no script of its own
  // (see its "Hover is driven from the main process" comment in
  // `buildPopoverHtml`) — hover is polled against `getBounds()` from
  // `pollCursor()` instead.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  return win;
}

function speakerLabel(speaker: TranscriptEntry['speaker']): string {
  return speaker === 'you' ? 'You:' : 'Other participant:';
}

/**
 * Builds one `executeJavaScript` snippet appending `entries` to the
 * popover's `#transcript` container and scrolling to the latest one. Every
 * piece of transcript text is assigned via `textContent` — see this file's
 * header comment ("DOM-UPDATE APPROACH") for why it never touches
 * `innerHTML` or gets concatenated into an HTML string.
 */
function buildAppendScript(entries: TranscriptEntry[]): string {
  const appends = entries
    .map(
      (entry) => `(function () {
    var container = document.getElementById('transcript');
    if (!container) return;
    var row = document.createElement('div');
    row.className = 'entry';
    var speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.textContent = ${JSON.stringify(speakerLabel(entry.speaker))};
    row.appendChild(speaker);
    row.appendChild(document.createTextNode(${JSON.stringify(` ${entry.text}`)}));
    container.appendChild(row);
  })();`,
    )
    .join('\n');
  return `${appends}
(function () {
  var container = document.getElementById('transcript');
  if (container) container.scrollTop = container.scrollHeight;
})();`;
}

/**
 * Builds one `executeJavaScript` snippet invoking the pill's own
 * `window.__ethosUpdateAudioLevel` (defined in `buildPillHtml`'s inline
 * script) with `level`, clamped to 0.0-1.0. Guarded with a `typeof` check in
 * case this ever races the pill's own HTML load — best-effort, matching
 * `buildAppendScript`'s `if (!container) return;` guard for the same class
 * of race.
 */
function buildAudioLevelScript(level: number): string {
  const clamped = Math.max(0, Math.min(1, level));
  return `(function () {
  if (typeof window.__ethosUpdateAudioLevel === 'function') {
    window.__ethosUpdateAudioLevel(${JSON.stringify(clamped)});
  }
})();`;
}

export function showCallCapturePill(source: string): void {
  if (!pillWindow || pillWindow.isDestroyed()) {
    const win = createPillWindow();
    win.on('closed', () => {
      pillWindow = null;
    });
    pillWindow = win;
  }

  // Show immediately after loadURL rather than waiting for 'ready-to-show':
  // this window is reused across the app's lifetime, and repeated loadURL
  // calls on an already-shown/existing window don't reliably re-fire
  // 'ready-to-show'. Showing immediately is simpler, correct, and keeps this
  // module easily testable.
  pillWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildPillHtml(source))}`);
  // `showInactive()`, not `show()` — the pill must appear without activating
  // the Ethos app or stealing focus from whatever is frontmost (e.g. Zoom).
  pillWindow.showInactive();
  // Starts (idempotently — a no-op if already running, e.g. across a
  // hide/show cycle of the reused singleton) the main-process cursor poll
  // driving hover/drag — see this file's header comment ("TRIGGER").
  startCursorPolling();
}

export function hideCallCapturePill(): void {
  if (pillWindow && !pillWindow.isDestroyed()) {
    pillWindow.hide();
  }
  // Hiding the pill (e.g. via its own close button — see this file's header
  // comment, "CLOSE BUTTON") must not leave the popover orphaned on screen
  // if it happened to be open (or mid-hover) at that moment: the popover is
  // anchored to the pill and has nothing else closing it once the pill is
  // gone. Cancel any pending hover-close debounce first and reset hover
  // tracking so a timer scheduled before this call can't later fire against
  // an already-closed popover or a hidden pill — then close the popover
  // outright. `closeTranscriptPopover()` is a no-op when no popover exists,
  // so this is safe to call unconditionally, including from
  // `createCallCapturePillStateHandler()`'s own idle transition, which
  // already closes the popover itself before calling this.
  //
  // Also stops the cursor poll — no pill on screen means nothing left for
  // it to track — via `stopCursorPolling()`, which also clears `dragging`
  // so a drag gesture that was somehow still in progress can't resume
  // against a hidden pill on the next `showCallCapturePill()`.
  cancelCloseDebounce();
  pillHovered = false;
  popoverHovered = false;
  closeTranscriptPopover();
  stopCursorPolling();
}

function closeTranscriptPopover(): void {
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    popoverWindow.close();
  }
  popoverWindow = null;
}

/** Opens the popover, freshly rendering whatever is already in
 * `transcriptBuffer` — reopening mid-call never loses already-arrived text
 * (see this file's header comment, "BUFFER OWNERSHIP"). */
function openTranscriptPopover(): void {
  const win = createPopoverWindow();
  win.on('closed', () => {
    if (popoverWindow === win) popoverWindow = null;
  });
  popoverWindow = win;

  // Same "show immediately, don't gate on a lifecycle event" simplification
  // showCallCapturePill above already makes, for the same reason (this
  // window is short-lived and this keeps the module easily testable).
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildPopoverHtml())}`);
  // `showInactive()`, not `show()` — same no-focus-steal reasoning as the
  // pill.
  win.showInactive();
  if (transcriptBuffer.length > 0) {
    void win.webContents.executeJavaScript(buildAppendScript(transcriptBuffer)).catch(() => {
      // Best-effort — a failed live update just means the popover shows a
      // stale/partial view until the next entry arrives or it's reopened.
    });
  }
}

function cancelCloseDebounce(): void {
  if (closeDebounceTimer) {
    clearTimeout(closeDebounceTimer);
    closeDebounceTimer = null;
  }
}

/** Closes the popover after `HOVER_CLOSE_DEBOUNCE_MS`, unless the cursor has
 * re-entered the pill or the popover by then — see this file's header
 * comment ("COMBINED HOVER REGION"). */
function scheduleCloseIfUnhovered(): void {
  cancelCloseDebounce();
  closeDebounceTimer = setTimeout(() => {
    closeDebounceTimer = null;
    if (!pillHovered && !popoverHovered) {
      closeTranscriptPopover();
    }
  }, HOVER_CLOSE_DEBOUNCE_MS);
}

function handlePillHoverEnter(): void {
  pillHovered = true;
  cancelCloseDebounce();
  if (!popoverWindow || popoverWindow.isDestroyed()) {
    openTranscriptPopover();
  }
}

function handlePillHoverLeave(): void {
  pillHovered = false;
  scheduleCloseIfUnhovered();
}

function pointInBounds(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

/**
 * Re-derives hover state for both the pill and the popover from `point`
 * (the cursor's current screen position) against each window's own
 * `getBounds()`, and fires the same `handlePillHoverEnter`/
 * `handlePillHoverLeave`/`handlePopoverHoverEnter`/`handlePopoverHoverLeave`
 * transition handlers a DOM mouseenter/mouseleave used to — see this file's
 * header comment ("TRIGGER"). Called on every `pollCursor()` tick, and once
 * more immediately from `handlePillDragEnd` so the popover doesn't wait for
 * the next tick to reappear.
 */
function syncHoverState(point: { x: number; y: number }): void {
  if (!pillWindow || pillWindow.isDestroyed()) return;

  const overPill = pointInBounds(point, pillWindow.getBounds());
  if (overPill && !pillHovered) {
    handlePillHoverEnter();
  } else if (!overPill && pillHovered) {
    handlePillHoverLeave();
  }

  const overPopover = Boolean(
    popoverWindow &&
      !popoverWindow.isDestroyed() &&
      pointInBounds(point, popoverWindow.getBounds()),
  );
  if (overPopover && !popoverHovered) {
    handlePopoverHoverEnter();
  } else if (!overPopover && popoverHovered) {
    handlePopoverHoverLeave();
  }
}

/**
 * Moves the pill window by `(dx, dy)` from its CURRENT position, not the
 * drag's starting position, so a multi-step drag doesn't drift — same
 * anchoring principle the old per-`mousemove` implementation used, now fed
 * by `pollCursor()`'s cursor diff instead of a renderer-reported delta.
 */
function applyPillDrag(win: BrowserWindow, dx: number, dy: number): void {
  const bounds = win.getBounds();
  win.setPosition(bounds.x + dx, bounds.y + dy);

  // See this file's header comment ("DRAG-WHILE-POPOVER-OPEN") — close
  // rather than live-reposition. Idempotent within one drag gesture: after
  // the first delta closes it, `popoverWindow` is null, so the remaining
  // ticks in the same drag are cheap no-ops.
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    cancelCloseDebounce();
    popoverHovered = false;
    closeTranscriptPopover();
  }
}

/** Starts a drag gesture (pill `mousedown`) — see this file's header
 * comment ("DRAGGABLE"). Re-syncs `lastCursorPoint` right now rather than
 * relying on whatever `pollCursor()` last recorded, so the drag's first
 * step is only the movement since this `mousedown`, not since the previous,
 * possibly up-to-`CURSOR_POLL_INTERVAL_MS`-stale tick. */
function handlePillDragStart(): void {
  dragging = true;
  lastCursorPoint = screen.getCursorScreenPoint();
}

/** Ends a drag gesture (pill `mouseup`). No hover re-sync of its own:
 * `pollCursor()`'s per-tick `syncHoverState()` (see this file's header
 * comment, "DRAG-WHILE-POPOVER-OPEN") already runs unconditionally
 * regardless of `dragging`, so this only needs to flip the flag back off. */
function handlePillDragEnd(): void {
  dragging = false;
}

/**
 * The main-process cursor poll driving hover and drag — see this file's
 * header comment ("TRIGGER"). Runs on `CURSOR_POLL_INTERVAL_MS` while the
 * pill exists (started in `showCallCapturePill()`, stopped in
 * `hideCallCapturePill()`).
 */
function pollCursor(): void {
  const pill = pillWindow;
  if (!pill || pill.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();

  if (dragging) {
    const dx = point.x - lastCursorPoint.x;
    const dy = point.y - lastCursorPoint.y;
    if (dx !== 0 || dy !== 0) {
      applyPillDrag(pill, dx, dy);
    }
  }
  lastCursorPoint = point;

  syncHoverState(point);
}

function startCursorPolling(): void {
  if (cursorPollTimer) return;
  lastCursorPoint = screen.getCursorScreenPoint();
  cursorPollTimer = setInterval(pollCursor, CURSOR_POLL_INTERVAL_MS);
}

function stopCursorPolling(): void {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
  }
  dragging = false;
}

/**
 * Registers the callback fired when the user clicks the pill's own close
 * ("x") button — the desktop analog of `indicator.ts`'s `onEndRequested`
 * for the native Swift indicator's "End" button. Registered once by
 * `call-capture.ts`'s indicator wiring; forwards every future click across
 * however many show/hide cycles the pill goes through.
 */
export function onCallCapturePillCloseRequested(callback: () => void): void {
  closeRequestedCallback = callback;
}

function handlePillCloseRequested(): void {
  closeRequestedCallback?.();
}

function handlePopoverHoverEnter(): void {
  popoverHovered = true;
  cancelCloseDebounce();
}

function handlePopoverHoverLeave(): void {
  popoverHovered = false;
  scheduleCloseIfUnhovered();
}

/**
 * Appends one transcript entry to the current call's buffer (P3). Called
 * from `apps/desktop/src/main/call-capture.ts` as each `TranscriptEntry` is
 * yielded during capture, via `runCallCapture`'s `onEntry` callback. If the
 * popover is currently open, the entry is also pushed live into its DOM;
 * otherwise it just accumulates for the next time the popover opens.
 */
export function appendCallCaptureTranscriptEntry(entry: TranscriptEntry): void {
  transcriptBuffer.push(entry);
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    void popoverWindow.webContents.executeJavaScript(buildAppendScript([entry])).catch(() => {
      // Best-effort — see openTranscriptPopover's identical rationale.
    });
  }
}

/**
 * Pushes one live audio-level reading into the pill's meter (see this
 * file's header comment, "AUDIO LEVEL METER"). Called from
 * `apps/desktop/src/main/call-capture.ts` via
 * `CallCaptureIndicatorPort.updateAudioLevel`, at roughly the daemon's
 * ~100-200ms cadence — mirrors `appendCallCaptureTranscriptEntry`'s shape:
 * always records the reading (so the meter reflects the true latest state
 * once the pill exists), no-ops the DOM push when there's no live pill
 * window to push into.
 */
export function appendCallCaptureAudioLevel(speaker: Speaker, level: number): void {
  audioLevels[speaker] = level;
  if (!pillWindow || pillWindow.isDestroyed()) return;
  const displayLevel = Math.max(audioLevels.you, audioLevels.other);
  void pillWindow.webContents.executeJavaScript(buildAudioLevelScript(displayLevel)).catch(() => {
    // Best-effort — see openTranscriptPopover's identical rationale.
  });
}

/**
 * Returns a fresh onStateChange handler with its own private "was I
 * capturing last time" tracking — a factory (not a bare module-level
 * function) so each call gets independent transition-tracking state, which
 * also makes this trivially testable without cross-test leakage.
 */
export function createCallCapturePillStateHandler(): (state: DaemonState) => void {
  let previousKind: DaemonState['kind'] = 'idle';
  return (state: DaemonState) => {
    if (state.kind === 'capturing' && previousKind !== 'capturing') {
      // A fresh call starts with a clean transcript buffer and zeroed audio
      // levels.
      transcriptBuffer = [];
      audioLevels = { you: 0, other: 0 };
      showCallCapturePill(state.source);
    } else if (state.kind !== 'capturing' && previousKind === 'capturing') {
      // Call ended — close the popover and clear the buffer so nothing
      // leaks into the next call. Also reset hover tracking: the windows
      // that reported it are about to be hidden/destroyed, so a stale
      // "still hovered" flag must not survive into the next call.
      closeTranscriptPopover();
      transcriptBuffer = [];
      audioLevels = { you: 0, other: 0 };
      hideCallCapturePill();
      pillHovered = false;
      popoverHovered = false;
      cancelCloseDebounce();
    }
    previousKind = state.kind;
  };
}
