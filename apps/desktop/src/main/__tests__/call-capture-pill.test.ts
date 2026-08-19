import type { DaemonState, TranscriptEntry } from '@ethosagent/platform-callcapture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

/** Minimal fake `BrowserWindow` covering the surface `call-capture-pill.ts`
 * touches: `.showInactive()`, `.hide()`, `.close()`, `.loadURL()`,
 * `.isDestroyed()`, `.setVisibleOnAllWorkspaces()`, `.setAlwaysOnTop()`,
 * `on('closed', ...)`, and — for the transcript popover —
 * `webContents.on('will-navigate', ...)` / `webContents.executeJavaScript(...)`.
 * Built via `vi.hoisted()` so `instances` is a single stable array reference
 * that survives `vi.resetModules()` regardless of whether Vitest re-invokes
 * the `vi.mock('electron', ...)` factory on the next import — a plain
 * module-scoped array declared inside the factory itself was observed to
 * NOT reliably reset across tests, since it is recreated (or not) depending
 * on module-cache epoch timing rather than on this file's own `beforeEach`.
 * `cursor` is the mocked `screen.getCursorScreenPoint()` return value —
 * `call-capture-pill.ts`'s hover/drag are now driven entirely by
 * main-process cursor polling (see its header comment, "TRIGGER"), so tests
 * simulate mouse movement by mutating this instead of firing synthetic
 * `will-navigate` hover URLs (which no longer exist). */
const hoisted = vi.hoisted(() => {
  class FakeBrowserWindow {
    showInactive = vi.fn();
    hide = vi.fn();
    loadURL = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    getBounds = vi.fn(() => ({ x: 100, y: 200, width: 180, height: 44 }));
    setPosition = vi.fn();
    close = vi.fn(() => {
      this.destroyed = true;
      this.fire('closed');
    });
    webContents = {
      on: (event: string, cb: Listener) => this.addListener(this.wcListeners, event, cb),
      once: (event: string, cb: Listener) => this.addListener(this.wcListeners, event, cb),
      executeJavaScript: vi.fn(async (_code: string) => undefined),
    };

    /** The options this instance was constructed with — captured so tests
     * can assert on window-configuration fields (e.g. `focusable`, `type`)
     * without the fake needing bespoke getters for each one. */
    readonly options: Record<string, unknown>;

    private destroyed = false;
    private listeners: Record<string, Listener[]> = {};
    private wcListeners: Record<string, Listener[]> = {};

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      instances.push(this);
    }

    private addListener(bag: Record<string, Listener[]>, event: string, cb: Listener): this {
      const existing = bag[event] ?? [];
      existing.push(cb);
      bag[event] = existing;
      return this;
    }

    on(event: string, cb: Listener) {
      return this.addListener(this.listeners, event, cb);
    }

    once(event: string, cb: Listener) {
      return this.on(event, cb);
    }

    isDestroyed() {
      return this.destroyed;
    }

    fire(event: string, ...args: unknown[]) {
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }

    /** Simulates a `will-navigate` reaching the main process — drag
     * gesture boundaries and the close button still ride this channel (see
     * call-capture-pill.ts's header comment, "TRIGGER"); hover no longer
     * does. Mirrors `call-capture-notification-gate.test.ts`'s
     * `fireWillNavigate` helper. */
    fireWillNavigate(url: string) {
      const event = { preventDefault: vi.fn() };
      for (const cb of this.wcListeners['will-navigate'] ?? []) cb(event, url);
    }
  }

  const instances: FakeBrowserWindow[] = [];
  const cursor = { x: -10000, y: -10000 };

  return { instances, FakeBrowserWindow, cursor };
});

vi.mock('electron', () => ({
  BrowserWindow: hoisted.FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getCursorScreenPoint: () => ({ ...hoisted.cursor }),
  },
  // `call-capture-pill.ts` isolates its windows from `session.defaultSession`
  // (see its "ISOLATED SESSION" header comment) via `session.fromPartition`.
  session: {
    fromPartition: () => ({}),
  },
}));

// A constant, not mutable singleton state — safe to import statically
// alongside the per-test dynamic `import('../call-capture-pill')` calls
// below (see this file's own comment on why those stay dynamic).
import { CURSOR_POLL_INTERVAL_MS } from '../call-capture-pill';

function latestWindow() {
  return hoisted.instances[hoisted.instances.length - 1];
}

/** Moves the mocked cursor — the next `pollCursor()` tick (see `tick()`
 * below) will pick this up via `screen.getCursorScreenPoint()`. */
function setCursor(x: number, y: number): void {
  hoisted.cursor.x = x;
  hoisted.cursor.y = y;
}

/** Advances the fake clock by `times` main-process cursor-poll intervals —
 * see call-capture-pill.ts's header comment, "TRIGGER". */
function tick(times = 1): void {
  vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS * times);
}

/** A pill rectangle distinct from the `FakeBrowserWindow` class default, and
 * from `POPOVER_BOUNDS` below, so hover tests can put the cursor
 * unambiguously "over the pill" without also being "over the popover". */
const PILL_BOUNDS = { x: 0, y: 0, width: 180, height: 44 };
/** A popover rectangle that never overlaps `PILL_BOUNDS`. */
const POPOVER_BOUNDS = { x: 1000, y: 1000, width: 320, height: 240 };
/** Nowhere near either rectangle above. */
const FAR_AWAY = { x: -10000, y: -10000 };

function entry(speaker: TranscriptEntry['speaker'], text: string, at = 0): TranscriptEntry {
  return { speaker, text, at };
}

// `call-capture-pill.ts` keeps its own module-scoped singletons (`pillWindow`,
// `popoverWindow`, `transcriptBuffer`) — reset them between tests via
// `vi.resetModules()` + a fresh dynamic import so each test starts from "no
// window created yet, empty buffer", matching a clean app start.
// `hoisted.instances` is cleared explicitly in the same `beforeEach` since it
// is not tied to module-reset semantics. Fake timers are global for this
// file: `showCallCapturePill()` now starts a real `setInterval` (the cursor
// poll), and letting that run on the wall clock across ~40 tests would leak
// background timers past each test's teardown — fake timers keep it inert
// until a test explicitly calls `tick()`/`vi.advanceTimersByTime()|
// `vi.runAllTimers()` in a `vi.useFakeTimers()`-aware way, and
// `vi.clearAllTimers()` in `afterEach` discards whatever's still pending.
describe('call-capture-pill', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.instances.length = 0;
    hoisted.cursor.x = FAR_AWAY.x;
    hoisted.cursor.y = FAR_AWAY.y;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shows the pill exactly once, only on the transition into capturing', async () => {
    const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
    const handler = createCallCapturePillStateHandler();

    handler({ kind: 'idle' });
    handler({ kind: 'settingUp', callId: 'c1' });
    handler({ kind: 'awaiting', callId: 'c1', handle: {} as never });
    expect(hoisted.instances).toHaveLength(0);

    handler({
      kind: 'capturing',
      callId: 'c1',
      controller: new AbortController(),
      source: 'zoom',
    } satisfies DaemonState);

    expect(hoisted.instances).toHaveLength(1);
    expect(latestWindow().showInactive).toHaveBeenCalledTimes(1);
  });

  it('hides the pill on the transition from capturing back to idle', async () => {
    const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
    const handler = createCallCapturePillStateHandler();

    handler({
      kind: 'capturing',
      callId: 'c1',
      controller: new AbortController(),
      source: 'zoom',
    } satisfies DaemonState);
    const win = latestWindow();
    expect(win.hide).not.toHaveBeenCalled();

    handler({ kind: 'idle' });

    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  it('never creates or shows the pill for settingUp/awaiting states alone', async () => {
    const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
    const handler = createCallCapturePillStateHandler();

    handler({ kind: 'settingUp', callId: 'c1' });
    handler({ kind: 'awaiting', callId: 'c1', handle: {} as never });

    expect(hoisted.instances).toHaveLength(0);
  });

  it('forwards the capturing state source to the pill window content', async () => {
    const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
    const handler = createCallCapturePillStateHandler();

    handler({
      kind: 'capturing',
      callId: 'c1',
      controller: new AbortController(),
      source: 'zoom',
    } satisfies DaemonState);

    const win = latestWindow();
    expect(win.loadURL).toHaveBeenCalledTimes(1);
    const [url] = win.loadURL.mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent('zoom'));
  });

  it('reuses the same window instance across a second capture rather than creating a new one', async () => {
    const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
    const handler = createCallCapturePillStateHandler();

    handler({
      kind: 'capturing',
      callId: 'c1',
      controller: new AbortController(),
      source: 'zoom',
    } satisfies DaemonState);
    handler({ kind: 'idle' });
    handler({
      kind: 'capturing',
      callId: 'c2',
      controller: new AbortController(),
      source: 'teams',
    } satisfies DaemonState);

    expect(hoisted.instances).toHaveLength(1);
    expect(latestWindow().showInactive).toHaveBeenCalledTimes(2);
    expect(latestWindow().loadURL).toHaveBeenCalledTimes(2);
  });

  it('renders above fullscreen apps without stealing focus', async () => {
    const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
    const handler = createCallCapturePillStateHandler();

    handler({
      kind: 'capturing',
      callId: 'c1',
      controller: new AbortController(),
      source: 'zoom',
    } satisfies DaemonState);

    const pill = latestWindow();
    expect(pill.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
    });
    expect(pill.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  });

  describe('non-activating window configuration', () => {
    let originalPlatform: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    });

    afterEach(() => {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    });

    it('uses type: "panel" on darwin instead of focusable: false', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);

      const pill = latestWindow();
      expect(pill.options.type).toBe('panel');
      expect(pill.options.focusable).not.toBe(false);
    });

    it('does not set type: "panel" on non-darwin platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);

      const pill = latestWindow();
      expect(pill.options.type).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Bug fix (#6, should-fix): hover and drag used to ride DOM
  // `mouseenter`/`mouseleave`/`mousemove` events navigating to synthetic
  // `will-navigate` URLs — known-unreliable on unfocused macOS windows
  // (electron/electron#45246) for hover, and a heavy per-mousemove
  // navigation for drag. Both are now driven by the main process polling
  // `screen.getCursorScreenPoint()` against `getBounds()` on a
  // `CURSOR_POLL_INTERVAL_MS` interval (call-capture-pill.ts's header
  // comment, "TRIGGER"/"DRAGGABLE"). These tests simulate cursor movement
  // via `setCursor()` + `tick()` instead of firing hover URLs; drag gesture
  // boundaries (mousedown/mouseup) still ride `will-navigate`, since
  // click-family events are unaffected by #45246.
  // ---------------------------------------------------------------------

  describe('pill dragging', () => {
    it('moves the pill window based on cursor movement while dragging, from its current bounds', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue({ x: 100, y: 200, width: 180, height: 44 });

      setCursor(500, 500);
      pill.fireWillNavigate('ethos-callcapture-pill://drag-start');
      setCursor(512, 493);
      tick();

      expect(pill.setPosition).toHaveBeenCalledTimes(1);
      expect(pill.setPosition).toHaveBeenCalledWith(112, 193);
    });

    it('anchors each poll tick to the CURRENT bounds rather than accumulating from the drag start', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();

      setCursor(0, 0);
      pill.fireWillNavigate('ethos-callcapture-pill://drag-start');

      pill.getBounds.mockReturnValueOnce({ x: 100, y: 200, width: 180, height: 44 });
      setCursor(10, 10);
      tick();
      expect(pill.setPosition).toHaveBeenNthCalledWith(1, 110, 210);

      // The window's bounds have now genuinely moved — the fake reports
      // the new position, matching what a real BrowserWindow would after
      // the first setPosition call actually took effect.
      pill.getBounds.mockReturnValueOnce({ x: 110, y: 210, width: 180, height: 44 });
      setCursor(15, 8);
      tick();
      expect(pill.setPosition).toHaveBeenNthCalledWith(2, 115, 208);
    });

    it('does not move the window on a poll tick where the cursor has not moved', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();

      setCursor(200, 200);
      pill.fireWillNavigate('ethos-callcapture-pill://drag-start');
      tick(); // cursor hasn't moved since drag-start

      expect(pill.setPosition).not.toHaveBeenCalled();
    });

    it('closes an already-open popover when the pill is dragged, instead of leaving it anchored stale', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);

      setCursor(90, 20); // inside PILL_BOUNDS
      tick();
      const popover = latestWindow();
      expect(popover.close).not.toHaveBeenCalled();

      pill.fireWillNavigate('ethos-callcapture-pill://drag-start');
      setCursor(110, 20); // still over the pill, but moved
      tick();

      expect(popover.close).toHaveBeenCalledTimes(1);

      // A second poll tick in the same drag gesture is a no-op — the
      // popover is already gone, `close` isn't called again on it.
      setCursor(130, 20);
      tick();
      expect(popover.close).toHaveBeenCalledTimes(1);

      pill.fireWillNavigate('ethos-callcapture-pill://drag-end');

      // The popover does not reopen on its own just because the drag
      // ended — the cursor never left the pill's bounds, so there is no
      // fresh hover-enter transition to act on (see this file's header
      // comment, "DRAG-WHILE-POPOVER-OPEN").
      expect(hoisted.instances).toHaveLength(2);

      // Re-hovering — the cursor genuinely leaves the pill, then re-enters
      // — opens a fresh popover rather than reusing the closed one.
      setCursor(FAR_AWAY.x, FAR_AWAY.y);
      tick();
      setCursor(90, 20);
      tick();
      expect(hoisted.instances).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------
  // Bug fix: the popover must anchor to the pill's REAL CURRENT bounds
  // (`pillWindow.getBounds()`), not the theoretical default position — and
  // must flip from above-the-pill to below-the-pill when dragged somewhere
  // without enough work-area headroom above it, clamping horizontally so it
  // never runs off the left/right edge either (call-capture-pill.ts's
  // header comment, "POPOVER ANCHORING").
  // ---------------------------------------------------------------------

  describe('popover anchoring', () => {
    it('anchors above the pill using its actual current bounds, not the theoretical default position', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      // Simulates the pill having been dragged away from its default
      // bottom-right position (which the workArea mock computes as
      // x=1244, y=840) to somewhere else entirely.
      pill.getBounds.mockReturnValue({ x: 500, y: 600, width: 180, height: 44 });

      setCursor(550, 620); // inside the mocked bounds above
      tick();

      const popover = latestWindow();
      // Room above (600 - 240 - 8 = 352 >= workArea.y of 0), so it stays
      // above: right-aligned to the pill (500 + 180 - 320 = 360).
      expect(popover.options.x).toBe(360);
      expect(popover.options.y).toBe(352);
    });

    it('flips below the pill when dragged near the top of the screen, where there is no room above', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      // Dragged up near the top of the 900px-tall work area — 240px of
      // popover height plus the 8px gap doesn't fit above y=10.
      pill.getBounds.mockReturnValue({ x: 500, y: 10, width: 180, height: 44 });

      setCursor(550, 30); // inside the mocked bounds above
      tick();

      const popover = latestWindow();
      // Below the pill instead: 10 + 44 (pill height) + 8 (gap) = 62.
      expect(popover.options.y).toBe(62);
    });

    it('clamps horizontally within the work area when the pill is dragged near the left edge', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      // Right-aligning a 320px popover to a pill at x=0 would want x=-140.
      pill.getBounds.mockReturnValue({ x: 0, y: 600, width: 180, height: 44 });

      setCursor(50, 620); // inside the mocked bounds above
      tick();

      const popover = latestWindow();
      expect(popover.options.x).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // P3/P4 — live transcript popover, hover-triggered (plan/phases/
  // call-capture-desktop-ux.md)
  // ---------------------------------------------------------------------

  describe('live transcript popover', () => {
    it('accumulates entries into the buffer without creating a popover window when none is open', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureTranscriptEntry } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      // Exactly one window so far: the pill. Appending entries with no
      // popover open must not create one.
      expect(hoisted.instances).toHaveLength(1);

      appendCallCaptureTranscriptEntry(entry('you', 'hello there'));
      appendCallCaptureTranscriptEntry(entry('other', 'hi, how are you'));

      expect(hoisted.instances).toHaveLength(1);
    });

    it('opens the popover once the cursor hovers the pill and renders the already-accumulated buffer', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureTranscriptEntry } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      appendCallCaptureTranscriptEntry(entry('you', 'hello there'));
      appendCallCaptureTranscriptEntry(entry('other', 'hi, how are you'));

      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();

      // A second window (the popover) was created and shown, without
      // stealing focus, above fullscreen apps.
      expect(hoisted.instances).toHaveLength(2);
      const popover = latestWindow();
      expect(popover.showInactive).toHaveBeenCalledTimes(1);
      expect(popover.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
        visibleOnFullScreen: true,
      });
      expect(popover.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
      // The full buffer (both entries) was rendered into it in one go.
      expect(popover.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      const [script] = popover.webContents.executeJavaScript.mock.calls[0] as [string];
      expect(script).toContain('hello there');
      expect(script).toContain('hi, how are you');
      expect(script).toContain('You:');
      expect(script).toContain('Other participant:');
    });

    it('closes the popover after the hover-close debounce once the cursor leaves the pill and never returns', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();

      setCursor(FAR_AWAY.x, FAR_AWAY.y);
      tick();
      // Not closed immediately — the debounce hasn't elapsed yet.
      expect(popover.close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);
      expect(popover.close).toHaveBeenCalledTimes(1);
    });

    it('keeps the popover open when the cursor moves from the pill into the popover before the debounce fires', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();
      popover.getBounds.mockReturnValue(POPOVER_BOUNDS);

      // Leaves the pill and lands in the popover on the very next tick.
      setCursor(1050, 1050);
      tick();

      vi.advanceTimersByTime(500);
      expect(popover.close).not.toHaveBeenCalled();
    });

    it('closes the popover once the cursor leaves it too, after already leaving the pill', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();
      popover.getBounds.mockReturnValue(POPOVER_BOUNDS);

      setCursor(1050, 1050);
      tick();
      setCursor(FAR_AWAY.x, FAR_AWAY.y);
      tick();

      vi.advanceTimersByTime(200);
      expect(popover.close).toHaveBeenCalledTimes(1);
    });

    it('re-hovering the pill after the popover has closed opens a fresh window rather than reusing the closed one', async () => {
      const { createCallCapturePillStateHandler } = await import('../call-capture-pill');
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);

      setCursor(90, 20);
      tick();
      setCursor(FAR_AWAY.x, FAR_AWAY.y);
      tick();
      vi.advanceTimersByTime(200);
      // Pill + the now-closed popover.
      expect(hoisted.instances).toHaveLength(2);

      setCursor(90, 20);
      tick();
      expect(hoisted.instances).toHaveLength(3);
    });

    it('pushes a live entry into an already-open popover as it arrives', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureTranscriptEntry } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();
      // Nothing buffered yet, so the initial open made no append call.
      expect(popover.webContents.executeJavaScript).toHaveBeenCalledTimes(0);

      appendCallCaptureTranscriptEntry(entry('you', 'live update'));

      expect(popover.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      const [script] = popover.webContents.executeJavaScript.mock.calls[0] as [string];
      expect(script).toContain('live update');
    });

    it('resets the buffer on a fresh idle→capturing transition, dropping the previous call’s entries', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureTranscriptEntry } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      appendCallCaptureTranscriptEntry(entry('you', 'first call text'));
      handler({ kind: 'idle' });

      handler({
        kind: 'capturing',
        callId: 'c2',
        controller: new AbortController(),
        source: 'teams',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();

      // Nothing from the first call should have survived into the second.
      expect(popover.webContents.executeJavaScript).toHaveBeenCalledTimes(0);
    });

    it('closes an open popover and clears the buffer on the capturing→idle transition, bypassing the debounce', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureTranscriptEntry } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      appendCallCaptureTranscriptEntry(entry('you', 'goodbye soon'));
      // Captured once — the pill window is a reused singleton, so after the
      // upcoming idle→capturing round trip `latestWindow()` would no longer
      // point at it (no new pill instance gets pushed on reuse). Fire future
      // cursor moves against this same reference instead of re-fetching it.
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();

      // Call ends while the cursor is still (per the mock) hovering the
      // pill — the idle transition closes the popover immediately, with no
      // debounce wait, regardless of hover state.
      handler({ kind: 'idle' });

      expect(popover.close).toHaveBeenCalledTimes(1);

      // The next call starts with a genuinely empty buffer.
      handler({
        kind: 'capturing',
        callId: 'c2',
        controller: new AbortController(),
        source: 'teams',
      } satisfies DaemonState);
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      // The idle transition reset hover tracking, so this is a fresh
      // false→true transition even though the mocked cursor never moved.
      setCursor(FAR_AWAY.x, FAR_AWAY.y);
      tick();
      setCursor(90, 20);
      tick();
      const popover2 = latestWindow();
      expect(popover2.webContents.executeJavaScript).toHaveBeenCalledTimes(0);
    });
  });

  // ---------------------------------------------------------------------
  // Close button — the pill's own "x", the desktop analog of
  // `capture-indicator.swift`'s native "End" button, wired through
  // `onCallCapturePillCloseRequested` to `CallCaptureDaemon`'s existing
  // `onEndRequested` cancellation path (call-capture-pill.ts's header
  // comment, "CLOSE BUTTON").
  // ---------------------------------------------------------------------

  describe('close button', () => {
    it('invokes the registered callback when the close URL is navigated to', async () => {
      const { createCallCapturePillStateHandler, onCallCapturePillCloseRequested } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();
      const onClose = vi.fn();
      onCallCapturePillCloseRequested(onClose);

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();

      pill.fireWillNavigate('ethos-callcapture-pill://close');

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not invoke the callback for unrelated navigations (drag)', async () => {
      const { createCallCapturePillStateHandler, onCallCapturePillCloseRequested } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();
      const onClose = vi.fn();
      onCallCapturePillCloseRequested(onClose);

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();

      pill.fireWillNavigate('ethos-callcapture-pill://drag-start');
      pill.fireWillNavigate('ethos-callcapture-pill://drag-end');

      expect(onClose).not.toHaveBeenCalled();
    });

    it('forwards every future close click across however many show/hide cycles the pill goes through', async () => {
      const { createCallCapturePillStateHandler, onCallCapturePillCloseRequested } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();
      const onClose = vi.fn();
      onCallCapturePillCloseRequested(onClose);

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();
      pill.fireWillNavigate('ethos-callcapture-pill://close');
      expect(onClose).toHaveBeenCalledTimes(1);

      // Call ends, hides the pill, then a second call reuses the same
      // window singleton (no new instance) — the registration must still
      // be live for it.
      handler({ kind: 'idle' });
      handler({
        kind: 'capturing',
        callId: 'c2',
        controller: new AbortController(),
        source: 'teams',
      } satisfies DaemonState);
      expect(hoisted.instances).toHaveLength(1);

      pill.fireWillNavigate('ethos-callcapture-pill://close');
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------
  // Bug fix: hiding the pill (e.g. via its own close button) must not leave
  // the transcript popover orphaned on screen if it happened to be open at
  // that moment — see call-capture-pill.ts's `hideCallCapturePill()`.
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Audio-level meter (call-capture-pill.ts's header comment, "AUDIO LEVEL
  // METER") — fed by CallCaptureIndicatorPort.updateAudioLevel via
  // appendCallCaptureAudioLevel, pushed straight into the pill window's own
  // DOM (not the popover) via the same executeJavaScript mechanism
  // appendCallCaptureTranscriptEntry already uses for the popover.
  // ---------------------------------------------------------------------

  describe('audio level meter', () => {
    it('pushes a level update into the pill window once it exists', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureAudioLevel } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();

      appendCallCaptureAudioLevel('you', 0.8);

      expect(pill.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      const [script] = pill.webContents.executeJavaScript.mock.calls[0] as [string];
      expect(script).toContain('__ethosUpdateAudioLevel');
      expect(script).toContain('0.8');
    });

    it('is a no-op when no pill window exists yet', async () => {
      const { appendCallCaptureAudioLevel } = await import('../call-capture-pill');

      expect(() => appendCallCaptureAudioLevel('you', 0.5)).not.toThrow();
      expect(hoisted.instances).toHaveLength(0);
    });

    it('clamps the reported level to 0.0-1.0 before forwarding it', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureAudioLevel } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();

      appendCallCaptureAudioLevel('you', 1.5);
      appendCallCaptureAudioLevel('you', -0.4);

      const scripts = pill.webContents.executeJavaScript.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(scripts[0]).toContain('__ethosUpdateAudioLevel(1)');
      expect(scripts[1]).toContain('__ethosUpdateAudioLevel(0)');
    });

    it('displays the louder of the two speakers', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureAudioLevel } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      const pill = latestWindow();

      appendCallCaptureAudioLevel('you', 0.2);
      appendCallCaptureAudioLevel('other', 0.9);

      const [, secondCall] = pill.webContents.executeJavaScript.mock.calls as [string][];
      expect(secondCall[0]).toContain('__ethosUpdateAudioLevel(0.9)');
    });

    it('resets levels on a fresh idle→capturing transition, dropping the previous call’s reading', async () => {
      const { createCallCapturePillStateHandler, appendCallCaptureAudioLevel } = await import(
        '../call-capture-pill'
      );
      const handler = createCallCapturePillStateHandler();

      handler({
        kind: 'capturing',
        callId: 'c1',
        controller: new AbortController(),
        source: 'zoom',
      } satisfies DaemonState);
      appendCallCaptureAudioLevel('you', 0.9);
      handler({ kind: 'idle' });

      handler({
        kind: 'capturing',
        callId: 'c2',
        controller: new AbortController(),
        source: 'teams',
      } satisfies DaemonState);
      // The pill window singleton is reused across the idle→capturing round
      // trip (same reasoning as the other "reuses the same window instance"
      // test above), so this is the second call on the same mock — the
      // first was the earlier call's now-discarded 0.9 reading.
      const pill = latestWindow();
      appendCallCaptureAudioLevel('other', 0.1);

      expect(pill.webContents.executeJavaScript).toHaveBeenCalledTimes(2);
      const [script] = pill.webContents.executeJavaScript.mock.calls[1] as [string];
      expect(script).toContain('__ethosUpdateAudioLevel(0.1)');
    });
  });

  describe('hideCallCapturePill', () => {
    it('closes an open popover instead of leaving it orphaned', async () => {
      const { showCallCapturePill, hideCallCapturePill } = await import('../call-capture-pill');

      showCallCapturePill('zoom');
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();
      expect(popover.close).not.toHaveBeenCalled();

      hideCallCapturePill();

      expect(pill.hide).toHaveBeenCalledTimes(1);
      expect(popover.close).toHaveBeenCalledTimes(1);
    });

    it('is a no-op on the popover when none is open', async () => {
      const { showCallCapturePill, hideCallCapturePill } = await import('../call-capture-pill');

      showCallCapturePill('zoom');
      const pill = latestWindow();

      expect(() => hideCallCapturePill()).not.toThrow();
      expect(pill.hide).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending hover-close debounce so it cannot later act on an already-closed popover', async () => {
      const { showCallCapturePill, hideCallCapturePill } = await import('../call-capture-pill');

      showCallCapturePill('zoom');
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      setCursor(90, 20);
      tick();
      const popover = latestWindow();
      // Cursor leaves the pill, scheduling a debounced close — but the
      // debounce hasn't fired yet.
      setCursor(FAR_AWAY.x, FAR_AWAY.y);
      tick();

      hideCallCapturePill();
      expect(popover.close).toHaveBeenCalledTimes(1);

      // If the stale timer were still live, it would call closeTranscriptPopover()
      // again here — harmless on its own, but exercised to confirm no crash
      // and no extra `close()` call on an already-destroyed window.
      vi.runOnlyPendingTimers();
      expect(popover.close).toHaveBeenCalledTimes(1);
    });

    it('stops the cursor poll, so no further hover/drag polling happens once hidden', async () => {
      const { showCallCapturePill, hideCallCapturePill } = await import('../call-capture-pill');

      showCallCapturePill('zoom');
      const pill = latestWindow();
      pill.getBounds.mockReturnValue(PILL_BOUNDS);
      hideCallCapturePill();

      // A cursor move that would otherwise open the popover has no effect
      // once the pill (and its poll loop) is hidden.
      setCursor(90, 20);
      tick(10);

      expect(hoisted.instances).toHaveLength(1);
    });
  });
});
