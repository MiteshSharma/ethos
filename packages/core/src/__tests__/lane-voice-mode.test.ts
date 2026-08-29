// Voice V2 Lane 6a — the durable per-lane `/voice` mode.
//
// The acceptance criterion the lane exists for is "`/voice` mode changes
// survive gateway restart", so the restart case below constructs a SECOND
// store over the same storage rather than asserting on an internal cache.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { LaneVoiceModeStore, laneVoiceModePath } from '../voice/lane-voice-mode';

const PATH = '/home/u/.ethos/voice/lane-modes.json';

class FailingWriteStorage extends InMemoryStorage {
  override writeAtomic(): Promise<void> {
    return Promise.reject(new Error('disk full'));
  }
}

describe('LaneVoiceModeStore', () => {
  it('returns the default when there is no storage, and holds a set value', async () => {
    const store = new LaneVoiceModeStore();

    expect(await store.get('telegram:bot:42')).toBe('mirror_inbound');
    await store.set('telegram:bot:42', 'all');
    expect(await store.get('telegram:bot:42')).toBe('all');
  });

  it('survives a restart — a second store over the same document reads the mode', async () => {
    const storage = new InMemoryStorage();
    const before = new LaneVoiceModeStore({ storage, path: PATH });
    await before.set('telegram:bot:42', 'all');

    const after = new LaneVoiceModeStore({ storage, path: PATH });
    expect(await after.get('telegram:bot:42')).toBe('all');
    expect(await after.entries()).toEqual({ 'telegram:bot:42': 'all' });
  });

  it('clear reverts a lane to the default and drops it from entries', async () => {
    const storage = new InMemoryStorage();
    const store = new LaneVoiceModeStore({ storage, path: PATH });
    await store.set('slack:bot:C1', 'off');
    await store.set('slack:bot:C2', 'all');

    await store.clear('slack:bot:C1');

    expect(await store.get('slack:bot:C1')).toBe('mirror_inbound');
    expect(await store.entries()).toEqual({ 'slack:bot:C2': 'all' });

    // And the removal is durable, not just cached.
    const reloaded = new LaneVoiceModeStore({ storage, path: PATH });
    expect(await reloaded.entries()).toEqual({ 'slack:bot:C2': 'all' });
  });

  it('an absent document yields the default without throwing', async () => {
    const store = new LaneVoiceModeStore({ storage: new InMemoryStorage(), path: PATH });

    expect(await store.get('telegram:bot:42')).toBe('mirror_inbound');
    expect(await store.entries()).toEqual({});
  });

  it('corrupt JSON yields the default, does not throw, and does not call onError', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/home/u/.ethos/voice');
    await storage.write(PATH, '{ this is not json');

    const errors: string[] = [];
    const store = new LaneVoiceModeStore({
      storage,
      path: PATH,
      onError: (err) => errors.push(err),
    });

    expect(await store.get('telegram:bot:42')).toBe('mirror_inbound');
    expect(await store.entries()).toEqual({});
    // A hand-edited document is a normal state, not an error to report.
    expect(errors).toEqual([]);
  });

  it('keeps valid entries and drops invalid mode values', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/home/u/.ethos/voice');
    await storage.write(PATH, JSON.stringify({ good: 'all', bad: 'shout', alsoBad: 7 }));

    const store = new LaneVoiceModeStore({ storage, path: PATH });

    expect(await store.entries()).toEqual({ good: 'all' });
    expect(await store.get('bad')).toBe('mirror_inbound');
  });

  it('a failing writeAtomic still updates the in-memory value and reports onError', async () => {
    const errors: string[] = [];
    const store = new LaneVoiceModeStore({
      storage: new FailingWriteStorage(),
      path: PATH,
      onError: (err) => errors.push(err),
    });

    await expect(store.set('telegram:bot:42', 'all')).resolves.toBeUndefined();
    expect(await store.get('telegram:bot:42')).toBe('all');
    expect(errors).toEqual(['disk full']);
  });

  it('honours the defaultMode option', async () => {
    const store = new LaneVoiceModeStore({ defaultMode: 'off' });

    expect(store.defaultMode).toBe('off');
    expect(await store.get('telegram:bot:42')).toBe('off');
  });

  it('laneVoiceModePath names the document under the Ethos home dir', () => {
    expect(laneVoiceModePath('/home/u/.ethos')).toBe('/home/u/.ethos/voice/lane-modes.json');
  });
});
