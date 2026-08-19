// DesktopNotificationGate — a sibling implementation of the
// `CaptureOfferHandle`/`CallCaptureNotificationGatePort` contract defined in
// `extensions/platform-callcapture/src/notification.ts` and `daemon.ts`, NOT
// a modification of it. `notification.ts`'s public contract
// (`NotificationGate`, `CaptureOfferHandle`) is unchanged here; its own
// internal implementation now shows the offer via the native
// `capture-offer-card` binary (a custom AppKit window, see that file's
// header comment) rather than a system notification, but that's an
// implementation swap this file doesn't need to know about — it just uses a
// real `NotificationGate` as this file's own fallback when the custom
// Electron window can't be created (see `presentCaptureOffer` below).
//
// Shows a small frameless/alwaysOnTop `BrowserWindow` (same pattern as
// `quick-chat-window.ts`) with real "Start"/"Skip" links instead of relying
// on the OS notification's generic system "Show" chrome. No preload/
// contextBridge is needed — the renderer content is static, self-contained
// HTML with two plain `<a href="ethos-callcapture://...">` links. Clicks are
// observed from the main process via `webContents`'s `will-navigate` event,
// which Electron fires only for renderer-initiated navigation (a link
// click) — never for the initial programmatic `loadURL()` call made from
// main — so no first-load special-casing is required.

import type {
  CallCaptureNotificationGatePort,
  CaptureOfferHandle,
  CaptureOfferOutcome,
  PresentCaptureOfferOptions,
} from '@ethosagent/platform-callcapture';
import { NotificationGate } from '@ethosagent/platform-callcapture';
import { BrowserWindow, screen } from 'electron';
import { resolveCallCaptureIconDataUri } from './call-capture-icon';

const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 130;
/** Small inset from the primary display's work-area edges. */
const SCREEN_MARGIN = 16;

// Fixed RGB values, not semantic/dynamic colors — same "FORCED LIGHT
// APPEARANCE, FIXED COLORS" reasoning `capture-offer-card.swift`'s header
// comment documents: this card must always look the same regardless of the
// OS's Dark Mode setting or any translucent system material, which is the
// exact bug (`vibrancy: 'hud'` washing out a near-white-on-near-white card)
// this file used to have. `primaryBlue`/`headlineColor`/`subtitleColor` are
// the literal values that Swift file defines, kept identical here for
// genuine cross-platform visual consistency.
const PRIMARY_BLUE = '#2f7dfa';
const HEADLINE_COLOR = '#171717';
const SUBTITLE_COLOR = '#737373';
const SKIP_BACKGROUND = '#e5e5ea';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capitalizeFirst(input: string): string {
  const first = input.charAt(0);
  return first ? first.toUpperCase() + input.slice(1) : input;
}

function buildOfferHtml(opts: { source?: string }): string {
  // Headline is fixed, matching `capture-offer-card.swift`'s own fixed copy
  // verbatim — not derived from `PresentCaptureOfferOptions.title`/`message`
  // any more (see that file's doc comment for why those fields still exist
  // on the type: other implementations of this port still render them).
  const subtitle = opts.source ? escapeHtml(capitalizeFirst(opts.source)) : '';
  const iconDataUri = resolveCallCaptureIconDataUri();
  const icon = iconDataUri
    ? `<img class="icon" src="${iconDataUri}" alt="">`
    : `<div class="icon-fallback"></div>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: ${HEADLINE_COLOR};
    user-select: none;
  }
  .offer {
    box-sizing: border-box;
    height: 100%;
    padding: 14px 16px;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .icon,
  .icon-fallback {
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: 7px;
  }
  .icon-fallback {
    background: ${PRIMARY_BLUE};
  }
  .title {
    font-size: 13px;
    font-weight: 700;
  }
  .subtitle {
    font-size: 12px;
    color: ${SUBTITLE_COLOR};
    margin-top: 2px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  a {
    display: inline-block;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    text-decoration: none;
  }
  .skip {
    background: ${SKIP_BACKGROUND};
    color: ${HEADLINE_COLOR};
  }
  .start {
    background: ${PRIMARY_BLUE};
    color: #ffffff;
    font-weight: 700;
  }
</style>
</head>
<body>
  <div class="offer">
    <div class="header">
      ${icon}
      <div>
        <div class="title">Meeting detected</div>
        ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
      </div>
    </div>
    <div class="actions">
      <a class="skip" href="ethos-callcapture://skip">Skip</a>
      <a class="start" href="ethos-callcapture://start">Start</a>
    </div>
  </div>
</body>
</html>`;
}

function getOfferWindowPosition(width: number): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(workArea.x + workArea.width - width - SCREEN_MARGIN);
  const y = workArea.y + SCREEN_MARGIN;
  return { x, y };
}

function createOfferWindow(): BrowserWindow {
  const { x, y } = getOfferWindowPosition(WINDOW_WIDTH);
  return new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    // NON-ACTIVATING PANEL — this window used to be plain `showInactive()`
    // with no `type`, which only avoids stealing focus on its FIRST
    // appearance. A genuine Start/Skip click still activated/focused the
    // Ethos app (there is no non-activating flag on a normal window), so the
    // NEXT click back to whatever call app was frontmost (Zoom, etc.) fired
    // `blur` on this window mid-interaction, before the click even reached
    // Start/Skip — and `blur` below closes the window WITHOUT settling the
    // offer, silently stranding the daemon in `awaiting` state for the rest
    // of the call. `type: 'panel'` is Electron's documented mechanism for a
    // click that can bring a macOS window forward without activating the
    // app (`NSWindowStyleMaskNonactivatingPanel`) — mirrors
    // `call-capture-pill.ts`'s `createPillWindow()`, which already carries
    // the same fix (and the same rejected `focusable: false` alternative;
    // see that file's comment for why). macOS-only: `'panel'` isn't a valid
    // `type` value on the other platforms this option supports.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    // Fixed, opaque background — same platform on every OS. No `vibrancy`,
    // no `transparent`: see this file's "FORCED LIGHT APPEARANCE, FIXED
    // COLORS" comment above `buildOfferHtml` for why a translucent system
    // material is the bug this fixes, not a look worth keeping.
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

export interface DesktopNotificationGateOptions {
  /** Overrides window construction — tests inject a minimal fake instead of
   * a real Electron `BrowserWindow`. Defaults to the real window above. */
  createWindow?: () => BrowserWindow;
  /** Overrides the fallback gate used when window creation fails. Defaults
   * to a real `NotificationGate` (the native `capture-offer-card` binary). */
  fallback?: CallCaptureNotificationGatePort;
}

export class DesktopNotificationGate implements CallCaptureNotificationGatePort {
  private readonly createWindow: () => BrowserWindow;
  private readonly fallback: CallCaptureNotificationGatePort;

  constructor(options: DesktopNotificationGateOptions = {}) {
    this.createWindow = options.createWindow ?? createOfferWindow;
    this.fallback = options.fallback ?? new NotificationGate();
  }

  async presentCaptureOffer(opts: PresentCaptureOfferOptions): Promise<CaptureOfferHandle> {
    try {
      return this.presentViaWindow(opts);
    } catch (err) {
      // Defensive fallback for window-creation failure (e.g. Electron unable
      // to create a window in a headless/CI-like environment) — NOT the
      // "another process already owns the lock" case. That case never
      // reaches here at all: `CallCaptureOwnershipManager` only invokes
      // `onOwnershipClaimed` (and therefore only ever constructs this gate)
      // in the one process that actually won the ownership claim.
      console.warn(
        `[call-capture] desktop notification window failed to create, falling back to the native capture-offer-card: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallback.presentCaptureOffer(opts);
    }
  }

  private presentViaWindow(opts: PresentCaptureOfferOptions): CaptureOfferHandle {
    const win = this.createWindow();

    // Render above a fullscreen app's own macOS Space (e.g. Zoom running
    // fullscreen) — the standard Electron/macOS overlay recipe. Paired with
    // `showInactive()` below (never steals focus) and mirrored on the
    // pill/popover windows in `call-capture-pill.ts`.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, 'screen-saver');

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

    const closeWindow = (): void => {
      if (!win.isDestroyed()) win.close();
    };

    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url.startsWith('ethos-callcapture://start')) {
        resolveOnce({ outcome: 'accepted' });
        closeWindow();
      } else if (url.startsWith('ethos-callcapture://skip')) {
        // Design decision: an explicit Skip click proactively settles the
        // offer as 'expired' immediately, rather than leaving it pending
        // until the daemon later calls `expire()` on `call_ended`. A user
        // who clicked Skip has already made the decision — there's no
        // reason to leave the daemon sitting in `awaiting` state for the
        // rest of the call. This stays consistent with the
        // `CaptureOfferHandle` contract: `expire()` still routes through the
        // same `resolveOnce` guard below, so a later daemon-triggered
        // `expire()` call is a no-op here, exactly like any other
        // already-settled offer.
        resolveOnce({ outcome: 'expired' });
        closeWindow();
      }
    });

    win.on('blur', () => {
      // Defensive fallback only, now that `type: 'panel'` above (macOS)
      // means a genuine Start/Skip click can no longer activate this window
      // and trigger `blur` mid-interaction — see `createOfferWindow`'s
      // "NON-ACTIVATING PANEL" comment for the bug this closes off. Kept
      // rather than removed: some OTHER window could still become key for
      // an unrelated reason (e.g. the user manually switches apps), and on
      // non-darwin platforms this window isn't a panel at all. Either way,
      // losing focus is NOT an explicit decision — close the window but
      // leave the offer pending. Only a later `expire()` call (driven by the
      // daemon observing `call_ended`) settles it.
      closeWindow();
    });

    win.once('ready-to-show', () => {
      // `showInactive()`, not `show()` — this window must appear without
      // activating the Ethos app or stealing focus from whatever is
      // frontmost (e.g. Zoom).
      win.showInactive();
    });

    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildOfferHtml({ source: opts.source }))}`,
    );

    return {
      waitForOutcome: () => outcomePromise,
      expire: async () => {
        resolveOnce({ outcome: 'expired' });
        closeWindow();
      },
    };
  }
}
