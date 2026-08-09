import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getFavouritePersonalityId,
  nextFavouriteId,
  parseFavouritePersonalityId,
  resolvePersonalityId,
  setFavouritePersonalityId,
} from '../favouritePersonality';

// The suite runs in node (no jsdom), so `window` is stubbed with just the
// surface the module touches. `throwing` covers Safari private mode and
// blocked-cookie modes, where touching localStorage raises.
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
    dispatchEvent: () => true,
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolvePersonalityId', () => {
  const available = ['researcher', 'engineer'];

  it('prefers an explicit session choice over everything else', () => {
    expect(
      resolvePersonalityId({
        selectedId: 'engineer',
        favouriteId: 'researcher',
        defaultId: 'coach',
        available,
      }),
    ).toBe('engineer');
  });

  it('prefers the favourite over the server default', () => {
    expect(
      resolvePersonalityId({
        selectedId: null,
        favouriteId: 'researcher',
        defaultId: 'coach',
        available,
      }),
    ).toBe('researcher');
  });

  it('falls back to the server default with no favourite', () => {
    expect(
      resolvePersonalityId({ selectedId: null, favouriteId: null, defaultId: 'coach', available }),
    ).toBe('coach');
  });

  it('resolves to null when there is no choice, favourite, or default', () => {
    expect(
      resolvePersonalityId({ selectedId: null, favouriteId: null, defaultId: null, available }),
    ).toBeNull();
  });

  it('ignores a favourite that is not in the list, without clearing it', () => {
    const store = stubWindow();
    setFavouritePersonalityId('deleted-one');

    expect(
      resolvePersonalityId({
        selectedId: null,
        favouriteId: 'deleted-one',
        defaultId: 'coach',
        available,
      }),
    ).toBe('coach');
    // A personality is also "absent" while the list query is in flight —
    // dropping the preference on a slow load would be worse than ignoring it.
    expect(getFavouritePersonalityId()).toBe('deleted-one');
    expect(store.size).toBe(1);
  });

  it('ignores the favourite while the list is still empty', () => {
    expect(
      resolvePersonalityId({
        selectedId: null,
        favouriteId: 'researcher',
        defaultId: null,
        available: [],
      }),
    ).toBeNull();
  });
});

describe('parseFavouritePersonalityId', () => {
  it('accepts an id-shaped value', () => {
    expect(parseFavouritePersonalityId('personality-architect_2')).toBe('personality-architect_2');
  });

  it.each([
    ['absent', null],
    ['empty', ''],
    ['whitespace', '  '],
    ['JSON', '{"id":"researcher"}'],
    ['path traversal', '../../etc/passwd'],
  ])('degrades %s to no favourite', (_label, raw) => {
    expect(parseFavouritePersonalityId(raw)).toBeNull();
  });
});

describe('getFavouritePersonalityId', () => {
  it('returns null when nothing is stored', () => {
    stubWindow();
    expect(getFavouritePersonalityId()).toBeNull();
  });

  it('returns null for a corrupt stored value rather than throwing', () => {
    const store = stubWindow();
    store.set('ethos:favouritePersonalityId', '{"id":"researcher"}');
    expect(getFavouritePersonalityId()).toBeNull();
  });

  it('returns null when storage itself throws', () => {
    stubWindow({ throwing: true });
    expect(() => getFavouritePersonalityId()).not.toThrow();
    expect(getFavouritePersonalityId()).toBeNull();
  });

  it('returns null with no window at all (SSR / test env)', () => {
    vi.stubGlobal('window', undefined);
    expect(getFavouritePersonalityId()).toBeNull();
  });
});

describe('nextFavouriteId', () => {
  it('sets a favourite when there is none', () => {
    expect(nextFavouriteId(null, 'researcher')).toBe('researcher');
  });

  it('replaces the previous favourite — it is one value, not a set', () => {
    expect(nextFavouriteId('researcher', 'engineer')).toBe('engineer');
  });

  it('clears the favourite when the favourited one is clicked again', () => {
    expect(nextFavouriteId('researcher', 'researcher')).toBeNull();
  });
});

describe('setFavouritePersonalityId', () => {
  it('round-trips a single favourite through storage', () => {
    const store = stubWindow();

    setFavouritePersonalityId('researcher');
    expect(getFavouritePersonalityId()).toBe('researcher');

    setFavouritePersonalityId(nextFavouriteId(getFavouritePersonalityId(), 'engineer'));
    expect(getFavouritePersonalityId()).toBe('engineer');
    expect(store.size).toBe(1);

    setFavouritePersonalityId(nextFavouriteId(getFavouritePersonalityId(), 'engineer'));
    expect(getFavouritePersonalityId()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('does not throw when storage refuses the write', () => {
    stubWindow({ throwing: true });
    expect(() => setFavouritePersonalityId('researcher')).not.toThrow();
  });
});
