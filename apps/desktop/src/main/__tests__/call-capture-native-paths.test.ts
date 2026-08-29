// Focused coverage for `resolveCallCaptureNativeDir()` in `../call-capture` —
// the resolver that fixes the crash reported via the desktop app's crash
// dialog: `mic-detector binary not found at
// .../apps/desktop/dist/native/bin/mic-detector` (a bundled
// `import.meta.dirname`-relative path that never existed) instead of the
// real `extensions/platform-callcapture/native/bin/mic-detector`.
//
// `existsSync` is mocked at the `node:fs` module level so these assertions
// are deterministic regardless of whether the gitignored compiled native
// binaries (`native/bin/*`, `native/vendor/*`) have actually been built on
// the machine running the test — the same principle
// `extensions/platform-callcapture/src/__tests__/preflight.test.ts` applies
// via an injected `existsSync` dependency. `resolveCallCaptureNativePath` in
// `../call-capture` calls the real `node:fs` `existsSync` directly with no
// injectable seam (unlike `checkCallCaptureDependencies`), so the boundary
// is mocked at the module level here instead of via dependency injection.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn<(path: string) => boolean>();
vi.mock('node:fs', () => ({
  existsSync: (path: string) => existsSyncMock(path),
}));

// `../call-capture` transitively imports `./call-capture-notification-gate`
// and `./call-capture-pill`, both of which import `electron` directly —
// mocked the same way `call-capture-notification-gate.test.ts` and
// `call-capture-pill.test.ts` do, since this file only exercises the
// path-resolution helper and never touches a real window. `app` is mutable
// (via `vi.hoisted`) so individual tests can flip `isPackaged` to exercise
// the packaged-app candidate `resolveCallCaptureNativePath()` tries first
// (#3, code review) — mirrors the same
// `app.isPackaged ? process.resourcesPath : app.getAppPath()` branch
// `call-capture-icon.ts`'s `iconAssetPath()` uses.
const electronMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/dev-app-path',
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
  app: electronMock.app,
}));

import { resolveCallCaptureNativeDir } from '../call-capture';

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true });
}

describe('resolveCallCaptureNativeDir', () => {
  let originalResourcesPath: PropertyDescriptor | undefined;

  beforeEach(() => {
    existsSyncMock.mockReset();
    electronMock.app.isPackaged = false;
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    setResourcesPath(undefined);
  });

  afterEach(() => {
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
    }
  });

  it('resolves to the first (packaged-app-relative) candidate when it exists', () => {
    existsSyncMock.mockReturnValue(true);

    const dir = resolveCallCaptureNativeDir();

    expect(dir).toBeDefined();
    expect(dir).toContain('callcapture-native');
    // Only the first candidate should have been probed — the loop must not
    // keep checking once a match is found.
    expect(existsSyncMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the second (dev-mode, two-levels-up) candidate when the packaged-app candidate is absent', () => {
    let call = 0;
    existsSyncMock.mockImplementation(() => {
      call += 1;
      return call === 2; // packaged candidate missing, first dev-tree candidate present
    });

    const dir = resolveCallCaptureNativeDir();

    expect(dir).toBeDefined();
    expect(dir).toContain(join('extensions', 'platform-callcapture', 'native'));
    expect(existsSyncMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the third (dev-mode, four-levels-up) candidate when the first two are absent', () => {
    let call = 0;
    existsSyncMock.mockImplementation(() => {
      call += 1;
      return call === 3;
    });

    const dir = resolveCallCaptureNativeDir();

    expect(dir).toBeDefined();
    expect(dir).toContain(join('extensions', 'platform-callcapture', 'native'));
    expect(existsSyncMock).toHaveBeenCalledTimes(3);
  });

  it('returns undefined when none of the three candidates exist on disk', () => {
    existsSyncMock.mockReturnValue(false);

    const dir = resolveCallCaptureNativeDir();

    expect(dir).toBeUndefined();
    expect(existsSyncMock).toHaveBeenCalledTimes(3);
  });
});

// #3 (severe, code review) — `resolveCallCaptureNativePath()` previously only
// tried two `__dirname`-relative source-tree candidates, both valid only in
// an unbundled dev-mode monorepo checkout. A packaged app (`app.isPackaged
// === true`) has no such source tree next to its bundled main-process
// output, so it could never find the native binaries at all —
// `electron-builder.yml`'s `extraResources` now copies `native/bin` and
// `native/vendor/audiotee` into `callcapture-native/` under
// `process.resourcesPath`, and the packaged candidate below must resolve
// against exactly that path.
describe('resolveCallCaptureNativeDir — packaged app resource path', () => {
  let originalResourcesPath: PropertyDescriptor | undefined;

  beforeEach(() => {
    existsSyncMock.mockReset();
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  });

  afterEach(() => {
    electronMock.app.isPackaged = false;
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
    }
  });

  it('probes under process.resourcesPath/callcapture-native when app.isPackaged is true', () => {
    electronMock.app.isPackaged = true;
    setResourcesPath('/Applications/Ethos.app/Contents/Resources');
    existsSyncMock.mockReturnValue(true);

    const dir = resolveCallCaptureNativeDir();

    expect(dir).toBe(join('/Applications/Ethos.app/Contents/Resources', 'callcapture-native'));
    expect(existsSyncMock).toHaveBeenCalledWith(
      join('/Applications/Ethos.app/Contents/Resources', 'callcapture-native'),
    );
  });

  it('probes under app.getAppPath()/callcapture-native when app.isPackaged is false, ignoring a stale process.resourcesPath', () => {
    electronMock.app.isPackaged = false;
    setResourcesPath('/should-not-be-used');
    existsSyncMock.mockReturnValue(true);

    const dir = resolveCallCaptureNativeDir();

    expect(dir).toBe(join('/dev-app-path', 'callcapture-native'));
  });
});
