import { beforeEach, describe, expect, it, vi } from 'vitest';

// One backing map per file, mutated per test, so `needsLocalOnboarding` is
// asked the same question the app asks it: read the live store, not a value the
// test handed back.
const backing = new Map<string, unknown>();

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string, fallback?: unknown) {
      return backing.has(key) ? backing.get(key) : fallback;
    }
    set(key: string, value: unknown) {
      backing.set(key, value);
    }
  },
}));

// `index.ts` wires the whole app at module scope. `whenReady` never resolves so
// the bootstrap callback does not run; everything else is stubbed to whatever
// lets the module graph load.
vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise(() => {}),
    on: () => {},
    quit: () => {},
    getPath: () => '/tmp/ethos-test',
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  session: {
    defaultSession: {
      cookies: { set: async () => {} },
      webRequest: { onHeadersReceived: () => {}, onCompleted: () => {} },
    },
  },
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

vi.mock('@ethosagent/web-api', () => ({
  WebTokenRepository: class {
    async getOrCreate() {
      return 'test-token';
    }
  },
}));

vi.mock('../auto-update', () => ({ initAutoUpdater: () => {} }));
vi.mock('../backend', () => ({
  restartBackendAsync: async () => 3001,
  startBackend: () => {},
  startBackendAsync: async () => 3001,
  stopBackend: () => {},
}));
vi.mock('../connection-window', () => ({ showConnectionWindow: async () => null }));
vi.mock('../error-window', () => ({ showErrorWindow: async () => 'quit' }));
vi.mock('../global-shortcut', () => ({
  registerGlobalShortcuts: () => {},
  unregisterGlobalShortcuts: () => {},
}));
vi.mock('../ipc', () => ({ registerIpcHandlers: () => {} }));
vi.mock('../keychain', () => ({
  getKeychainValue: async () => null,
  setKeychainValue: async () => {},
}));
vi.mock('../notifications', () => ({ showMinimizeNotification: () => {} }));
vi.mock('../protocol-handler', () => ({ registerProtocolHandler: () => {} }));
vi.mock('../quick-chat-window', () => ({
  registerQuickChatIpc: () => {},
  showQuickChat: () => {},
}));
vi.mock('../satellite', () => ({
  onSatelliteStatus: () => {},
  setWakeEnabled: async () => {},
  startSatellite: async () => {},
  stopSatellite: async () => {},
}));
vi.mock('../startup-mode', () => ({
  isBackgroundMode: () => false,
  logBackgroundStartup: () => {},
}));
vi.mock('../tray', () => ({
  createTray: () => null,
  destroyTray: () => {},
  setTrayState: () => {},
  setWakeTray: () => {},
}));

import { needsLocalOnboarding } from '../index';

describe('needsLocalOnboarding', () => {
  beforeEach(() => {
    backing.clear();
  });

  it('is true in local mode when the flag is false', () => {
    backing.set('connectionMode', 'local');
    backing.set('onboardingComplete', false);
    expect(needsLocalOnboarding()).toBe(true);
  });

  it('is true when neither mode nor flag has been set (first local run)', () => {
    expect(needsLocalOnboarding()).toBe(true);
  });

  it('is false in remote mode even when the flag is false', () => {
    backing.set('connectionMode', 'remote');
    backing.set('onboardingComplete', false);
    expect(needsLocalOnboarding()).toBe(false);
  });

  it('is false in remote mode when the flag was never written at all', () => {
    backing.set('connectionMode', 'remote');
    expect(needsLocalOnboarding()).toBe(false);
  });

  it('is false in local mode once onboarding completed', () => {
    backing.set('connectionMode', 'local');
    backing.set('onboardingComplete', true);
    expect(needsLocalOnboarding()).toBe(false);
  });
});
