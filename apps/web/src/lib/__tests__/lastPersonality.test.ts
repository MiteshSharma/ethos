import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLastTeamId, getLastTeamId, setLastTeamId } from '../lastPersonality';

// teams-as-a-scope T1 — the last TEAM the user stood in, next to the last
// personality. Runs in node (no jsdom): `window` is stubbed with just the
// localStorage surface the module touches; `throwing` covers Safari private
// mode and blocked-cookie modes, where touching localStorage raises.
function stubWindow(options: { throwing?: boolean } = {}): Map<string, string> {
  const store = new Map<string, string>();
  const guard = () => {
    if (options.throwing) throw new Error('The operation is insecure.');
  };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => {
        guard();
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        guard();
        store.set(key, value);
      },
      removeItem: (key: string) => {
        guard();
        store.delete(key);
      },
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('last team id', () => {
  it('is null before anything is stored', () => {
    stubWindow();
    expect(getLastTeamId()).toBeNull();
  });

  it('round-trips through localStorage under its own key', () => {
    const store = stubWindow();
    setLastTeamId('marketing');
    expect(store.get('ethos.lastTeamId')).toBe('marketing');
    expect(getLastTeamId()).toBe('marketing');
  });

  it('clears on returning to Independent', () => {
    const store = stubWindow();
    setLastTeamId('marketing');
    clearLastTeamId();
    expect(store.has('ethos.lastTeamId')).toBe(false);
    expect(getLastTeamId()).toBeNull();
  });

  it('does not touch the last personality key', () => {
    const store = stubWindow();
    store.set('ethos.lastPersonalityId', 'engineer');
    setLastTeamId('marketing');
    clearLastTeamId();
    expect(store.get('ethos.lastPersonalityId')).toBe('engineer');
  });

  it('swallows storage errors — no last team, no crash', () => {
    stubWindow({ throwing: true });
    expect(() => setLastTeamId('marketing')).not.toThrow();
    expect(() => clearLastTeamId()).not.toThrow();
    expect(getLastTeamId()).toBeNull();
  });

  it('is inert with no window (SSR / tests without a stub)', () => {
    vi.stubGlobal('window', undefined);
    expect(getLastTeamId()).toBeNull();
    expect(() => setLastTeamId('marketing')).not.toThrow();
    expect(() => clearLastTeamId()).not.toThrow();
  });
});
