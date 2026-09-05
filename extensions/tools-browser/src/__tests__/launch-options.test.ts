// T3 — `browser.headed` is carried verbatim by config (it refuses to rewrite
// the operator's `auto` per machine), so THIS is where `'auto'` is answered.
// Revert `resolveHeadless` to `{ headless: headed !== true }` and both the
// auto cases and the no-display fallback warning fail.

import { describe, expect, it } from 'vitest';
import { buildLaunchOptions, hasDisplay, resolveHeadless } from '../launch-options';

const NO_DISPLAY: NodeJS.ProcessEnv = {};
const WITH_X11: NodeJS.ProcessEnv = { DISPLAY: ':0' };
const WITH_WAYLAND: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: 'wayland-0' };

describe('hasDisplay', () => {
  it('is always true on macOS and Windows', () => {
    expect(hasDisplay(NO_DISPLAY, 'darwin')).toBe(true);
    expect(hasDisplay(NO_DISPLAY, 'win32')).toBe(true);
  });

  it('follows DISPLAY / WAYLAND_DISPLAY on Linux', () => {
    expect(hasDisplay(NO_DISPLAY, 'linux')).toBe(false);
    expect(hasDisplay(WITH_X11, 'linux')).toBe(true);
    expect(hasDisplay(WITH_WAYLAND, 'linux')).toBe(true);
  });
});

describe("resolveHeadless — 'auto' resolves both ways", () => {
  it('is HEADED on a desktop (display present), with no warning', () => {
    expect(resolveHeadless('auto', WITH_X11, 'linux')).toEqual({ headless: false });
    expect(resolveHeadless('auto', NO_DISPLAY, 'darwin')).toEqual({ headless: false });
  });

  it('is HEADLESS on a server (no display), with no warning — auto asked us to decide', () => {
    expect(resolveHeadless('auto', NO_DISPLAY, 'linux')).toEqual({ headless: true });
  });

  it('treats an absent setting as auto', () => {
    expect(resolveHeadless(undefined, NO_DISPLAY, 'linux')).toEqual({ headless: true });
    expect(resolveHeadless(undefined, WITH_X11, 'linux')).toEqual({ headless: false });
  });
});

describe('resolveHeadless — explicit settings', () => {
  it('honours headed: false everywhere', () => {
    expect(resolveHeadless(false, WITH_X11, 'linux')).toEqual({ headless: true });
    expect(resolveHeadless(false, NO_DISPLAY, 'darwin')).toEqual({ headless: true });
  });

  it('honours headed: true where a display exists, silently', () => {
    expect(resolveHeadless(true, WITH_X11, 'linux')).toEqual({ headless: false });
  });

  // The plan's failure table: headed-on-server with no display must not fail
  // the launch — it degrades, and says so.
  it('falls back to headless WITH a warning for headed: true on a display-less server', () => {
    const resolved = resolveHeadless(true, NO_DISPLAY, 'linux');
    expect(resolved.headless).toBe(true);
    expect(resolved.warning).toContain('no display');
    expect(resolved.warning).toContain('running headless');
  });
});

describe('buildLaunchOptions — profiles (D4) and proxy', () => {
  it('gives each personality its own profile directory', () => {
    const cfg = { profilesEnabled: true, profilesDir: '/data/browser-profiles' };
    expect(buildLaunchOptions(cfg, 'scout').profile).toEqual({
      key: 'scout',
      dir: '/data/browser-profiles/scout',
    });
    expect(buildLaunchOptions(cfg, 'archivist').profile?.dir).toBe(
      '/data/browser-profiles/archivist',
    );
  });

  it('offers no profile when profiles are disabled, or no personality is known', () => {
    expect(
      buildLaunchOptions({ profilesEnabled: false, profilesDir: '/data/p' }, 'scout').profile,
    ).toBeUndefined();
    expect(
      buildLaunchOptions({ profilesEnabled: true, profilesDir: '/data/p' }, undefined).profile,
    ).toBeUndefined();
  });

  // A personality id becomes a directory name. A marketplace personality that
  // called itself `../../.ssh` would otherwise get a Chromium user-data dir
  // written outside the profiles root.
  it('refuses a personality id that is not a safe directory name', () => {
    for (const id of ['../escape', 'a/b', 'dot.dot', '']) {
      expect(
        buildLaunchOptions({ profilesEnabled: true, profilesDir: '/data/p' }, id).profile,
      ).toBeUndefined();
    }
  });

  it('passes the proxy through untouched', () => {
    const proxy = { server: 'http://proxy.example.com:3128', username: 'ethos' };
    expect(buildLaunchOptions({ proxy }).proxy).toEqual(proxy);
  });

  it('carries the no-display fallback out as a one-shot launch notice', () => {
    const opts = buildLaunchOptions({ headed: true }, undefined, NO_DISPLAY, 'linux');
    expect(opts.headless).toBe(true);
    expect(opts.launchWarning).toContain('no display');
  });

  it('attaches no notice when the machine can honour the request', () => {
    expect(
      buildLaunchOptions({ headed: true }, undefined, WITH_X11, 'linux').launchWarning,
    ).toBeUndefined();
    expect(
      buildLaunchOptions({ headed: 'auto' }, undefined, NO_DISPLAY, 'linux').launchWarning,
    ).toBeUndefined();
  });
});
