import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `hoisted.FakeBrowserWindow` is the mocked `BrowserWindow` constructor,
// capturing the options it was constructed with — used only by the "offer
// window configuration" tests below, which exercise the real (uninjected)
// `createOfferWindow()` default rather than the manual `fakeWindow()` used
// by every other test in this file. Built via `vi.hoisted()` for the same
// reason `call-capture-pill.test.ts`'s identical pattern documents: a plain
// module-scoped array declared inside the `vi.mock` factory is not reliably
// what the factory closure captures once Vitest hoists the `vi.mock` call
// above this import.
const hoisted = vi.hoisted(() => {
  class FakeBrowserWindow {
    readonly options: Record<string, unknown>;
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    showInactive = vi.fn();
    loadURL = vi.fn();
    close = vi.fn();
    isDestroyed = () => false;
    webContents = { on: vi.fn() };
    on = vi.fn();
    once = vi.fn();

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      instances.push(this);
    }
  }
  const instances: FakeBrowserWindow[] = [];
  return { instances, FakeBrowserWindow };
});

vi.mock('electron', () => ({
  BrowserWindow: hoisted.FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
}));

import { DesktopNotificationGate } from '../call-capture-notification-gate';

type Listener = (...args: unknown[]) => void;

/** Minimal fake `BrowserWindow` covering only the surface this file touches:
 * `webContents.on('will-navigate', ...)`, `.loadURL(...)`, `on('blur', ...)`,
 * `once('ready-to-show', ...)`, `.showInactive()`, `.close()`,
 * `.isDestroyed()`, `.setVisibleOnAllWorkspaces(...)`, `.setAlwaysOnTop(...)`. */
function addListener(listeners: Record<string, Listener[]>, event: string, cb: Listener): void {
  const existing = listeners[event] ?? [];
  existing.push(cb);
  listeners[event] = existing;
}

function fakeWindow() {
  const listeners: Record<string, Listener[]> = {};
  let destroyed = false;
  const win = {
    webContents: {
      on: (event: string, cb: Listener) => addListener(listeners, event, cb),
    },
    on: (event: string, cb: Listener) => addListener(listeners, event, cb),
    once: (event: string, cb: Listener) => addListener(listeners, event, cb),
    loadURL: vi.fn(),
    showInactive: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
  };
  return { win, listeners };
}

function fireWillNavigate(listeners: Record<string, Listener[]>, url: string): void {
  const handlers = listeners['will-navigate'] ?? [];
  const event = { preventDefault: vi.fn() };
  for (const handler of handlers) handler(event, url);
}

function fireReadyToShow(listeners: Record<string, Listener[]>): void {
  for (const handler of listeners['ready-to-show'] ?? []) handler();
}

const OFFER = { callId: 'call-1', title: 'Ethos', message: 'Call detected — click to start.' };

describe('DesktopNotificationGate', () => {
  it('resolves accepted when Start is clicked', async () => {
    const { win, listeners } = fakeWindow();
    const gate = new DesktopNotificationGate({ createWindow: () => win as never });

    const handle = await gate.presentCaptureOffer(OFFER);
    fireWillNavigate(listeners, 'ethos-callcapture://start');

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });
    expect(win.close).toHaveBeenCalled();
  });

  it('resolves expired when Skip is clicked, without an external expire() call', async () => {
    const { win, listeners } = fakeWindow();
    const gate = new DesktopNotificationGate({ createWindow: () => win as never });

    const handle = await gate.presentCaptureOffer(OFFER);
    fireWillNavigate(listeners, 'ethos-callcapture://skip');

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
    expect(win.close).toHaveBeenCalled();
  });

  it('resolves expired when expire() is called while still pending', async () => {
    const { win } = fakeWindow();
    const gate = new DesktopNotificationGate({ createWindow: () => win as never });

    const handle = await gate.presentCaptureOffer(OFFER);
    await handle.expire();

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
    expect(win.close).toHaveBeenCalled();
  });

  it('is a no-op when expire() is called after Skip already settled the offer', async () => {
    const { win, listeners } = fakeWindow();
    const gate = new DesktopNotificationGate({ createWindow: () => win as never });

    const handle = await gate.presentCaptureOffer(OFFER);
    fireWillNavigate(listeners, 'ethos-callcapture://skip');
    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });

    await expect(handle.expire()).resolves.toBeUndefined();
    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
  });

  it('shows without stealing focus and renders above fullscreen apps', async () => {
    const { win, listeners } = fakeWindow();
    const gate = new DesktopNotificationGate({ createWindow: () => win as never });

    await gate.presentCaptureOffer(OFFER);

    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');

    fireReadyToShow(listeners);
    expect(win.showInactive).toHaveBeenCalledTimes(1);
  });

  it('falls back to the injected gate when window creation fails', async () => {
    const fallbackHandle = {
      waitForOutcome: vi.fn(async () => ({ outcome: 'expired' as const })),
      expire: vi.fn(async () => {}),
    };
    const fallback = {
      presentCaptureOffer: vi.fn(async () => fallbackHandle),
    };
    const gate = new DesktopNotificationGate({
      createWindow: () => {
        throw new Error('window creation failed');
      },
      fallback,
    });

    const handle = await gate.presentCaptureOffer(OFFER);

    expect(fallback.presentCaptureOffer).toHaveBeenCalledWith(OFFER);
    expect(handle).toBe(fallbackHandle);
  });

  // ---------------------------------------------------------------------
  // Bug fix (#2, severe): `blur` used to close the window WITHOUT settling
  // the offer, silently stranding the daemon in `awaiting` state — because
  // the offer card wasn't `type: 'panel'`, a genuine Start/Skip click
  // activated the Ethos app, and the NEXT click elsewhere fired `blur`
  // mid-interaction (see `createOfferWindow`'s "NON-ACTIVATING PANEL"
  // comment). `type: 'panel'` (below) closes off the trigger; this block
  // covers the `blur` handler's own documented behavior directly, since it
  // previously had no test coverage at all.
  // ---------------------------------------------------------------------

  describe('blur (defensive fallback only, per "NON-ACTIVATING PANEL")', () => {
    it('leaves the offer pending — does not resolve — when the window merely loses focus', async () => {
      const { win, listeners } = fakeWindow();
      const gate = new DesktopNotificationGate({ createWindow: () => win as never });

      const handle = await gate.presentCaptureOffer(OFFER);
      for (const handler of listeners.blur ?? []) handler();

      expect(win.close).toHaveBeenCalled();

      const settled = await Promise.race([
        handle.waitForOutcome().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ]);
      expect(settled).toBe(false);
    });

    it('still resolves via a later expire() after blur left the offer pending', async () => {
      const { win, listeners } = fakeWindow();
      const gate = new DesktopNotificationGate({ createWindow: () => win as never });

      const handle = await gate.presentCaptureOffer(OFFER);
      for (const handler of listeners.blur ?? []) handler();
      await handle.expire();

      await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
    });

    it('still resolves accepted if Start is somehow clicked after a blur already fired', async () => {
      const { win, listeners } = fakeWindow();
      const gate = new DesktopNotificationGate({ createWindow: () => win as never });

      const handle = await gate.presentCaptureOffer(OFFER);
      for (const handler of listeners.blur ?? []) handler();
      fireWillNavigate(listeners, 'ethos-callcapture://start');

      await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });
    });
  });

  // ---------------------------------------------------------------------
  // Bug fix (#2, severe), root cause: without `type: 'panel'`, a genuine
  // click to reach Start/Skip activates the Ethos app, and the next click
  // elsewhere fires `blur` — which used to close the window without ever
  // settling the offer. `type: 'panel'` mirrors `call-capture-pill.ts`'s
  // `createPillWindow()`, whose own "non-activating window configuration"
  // tests this mirrors.
  // ---------------------------------------------------------------------

  describe('offer window configuration', () => {
    let originalPlatform: PropertyDescriptor | undefined;

    beforeEach(() => {
      hoisted.instances.length = 0;
      originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    });

    afterEach(() => {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    });

    it('uses type: "panel" on darwin, so a Start/Skip click cannot activate the app and later blur mid-interaction', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const gate = new DesktopNotificationGate();

      await gate.presentCaptureOffer(OFFER);

      expect(hoisted.instances).toHaveLength(1);
      expect(hoisted.instances[0]?.options.type).toBe('panel');
    });

    it('does not set type: "panel" on non-darwin platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const gate = new DesktopNotificationGate();

      await gate.presentCaptureOffer(OFFER);

      expect(hoisted.instances).toHaveLength(1);
      expect(hoisted.instances[0]?.options.type).toBeUndefined();
    });
  });
});
