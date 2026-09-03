import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const handlers = new Map<string, (event: unknown, req: unknown) => unknown>();

// Hoisted: `vi.mock` factories run before module-scope initialisers, so these
// spies have to exist before the `electron` / `../keychain` factories close
// over them.
const { appEmit, setResizable, setKeychainValue } = vi.hoisted(() => ({
  appEmit: vi.fn(),
  setResizable: vi.fn(),
  setKeychainValue: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), emit: appEmit, on: () => {} },
  BrowserWindow: {
    fromWebContents: () => ({ setResizable, setSize: () => {}, center: () => {} }),
  },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  session: { defaultSession: { cookies: { set: async () => {} } } },
  shell: {},
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

vi.mock('../keychain', () => ({
  getKeychainValue: async () => null,
  setKeychainValue,
}));
vi.mock('../backend', () => ({ restartBackend: () => {}, startBackend: () => {} }));
vi.mock('../gateway-control', () => ({
  getGatewayLogPath: () => '',
  getGatewayStatus: () => ({ state: 'stopped' }),
  startGateway: async () => {},
  stopGateway: async () => {},
}));
vi.mock('../login-item', () => ({ getLoginItem: () => false, setLoginItem: () => {} }));
vi.mock('../platform-validator', () => ({
  testDiscord: async () => ({ ok: true }),
  testImap: async () => ({ ok: true }),
  testSmtp: async () => ({ ok: true }),
  testTelegram: async () => ({ ok: true }),
}));
vi.mock('../satellite', () => ({
  getSatelliteStatus: () => ({ state: 'stopped' }),
  probeSatellite: async () => ({}),
  setWakeEnabled: async () => {},
  startSatellite: async () => {},
  stopSatellite: async () => {},
}));

import { registerIpcHandlers } from '../ipc';

const dataDir = join(tmpdir(), 'ethos-onboarding-guard-test');

function completeOnboarding(): Promise<{ success: boolean; error?: string }> {
  const handler = handlers.get('onboarding:complete');
  if (!handler) throw new Error('onboarding:complete handler was not registered');
  return handler(
    { sender: {} },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
      personalityId: 'engineer',
    },
  ) as Promise<{ success: boolean; error?: string }>;
}

describe('onboarding:complete in remote mode', () => {
  beforeEach(() => {
    handlers.clear();
    backing.clear();
    appEmit.mockClear();
    setResizable.mockClear();
    setKeychainValue.mockClear();
    rmSync(dataDir, { recursive: true, force: true });
    backing.set('dataDir', dataDir);
    registerIpcHandlers();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses, writes nothing and starts nothing', async () => {
    backing.set('connectionMode', 'remote');

    const result = await completeOnboarding();

    expect(result).toEqual({
      success: false,
      error: 'Connected to a remote server — set up that server, not this Mac.',
    });
    expect(existsSync(dataDir)).toBe(false);
    expect(setKeychainValue).not.toHaveBeenCalled();
    expect(backing.get('onboardingComplete')).toBeUndefined();
    expect(setResizable).not.toHaveBeenCalled();
    expect(appEmit).not.toHaveBeenCalled();
  });

  it('still completes normally in local mode', async () => {
    backing.set('connectionMode', 'local');

    const result = await completeOnboarding();

    expect(result).toEqual({ success: true });
    expect(existsSync(join(dataDir, 'config.yaml'))).toBe(true);
    expect(backing.get('onboardingComplete')).toBe(true);
    expect(appEmit).toHaveBeenCalledWith('ethos:onboarding-complete');
  });
});
