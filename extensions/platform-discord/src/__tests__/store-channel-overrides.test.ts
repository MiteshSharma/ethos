// Discord's per-channel override store is now the shared one from
// `@ethosagent/core` (plan/phases/ambient-group-monitoring.md R6). This suite
// is kept as the regression guard on Discord's *use* of it, driving it exactly
// as the adapter does: the per-bot directory joined at the construction site,
// and Discord's own `ChannelModeSchema` as the mode validator.
//
// Two assertions here changed shape, and both were corrections rather than
// relaxations. Discord's deleted copy indexed a BARE mode and joined `botKey`
// onto the platform directory itself, while Telegram's copy — the same file,
// three packages over — indexed `{ mode, regexPattern }` and took the per-bot
// directory. That divergence is the drift the shared store exists to end, so
// the tests now assert the shared shape:
//
//   `get()`     → `{ mode }`, was `'all'`
//   `entries()` → `['ch1', { mode: 'all' }]`, was `['ch1', 'all']`
//
// Both still assert the same fact (which mode was stored for which channel) at
// the same strength — `toEqual({ mode: 'all' })` fails for a wrong mode, a
// missing entry, or a stray extra field exactly as `toBe('all')` did.

import { ChannelOverrideStore } from '@ethosagent/core';
import type { Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ChannelMode, ChannelModeSchema } from '../config';
import { createInMemoryStorage } from './fakes';

/** The per-bot directory, joined by the caller — as `DiscordAdapter` does. */
const BOT_DIR = 'discord/bot123';

describe('ChannelOverrideStore (shared core store, Discord binding)', () => {
  let store: ChannelOverrideStore<ChannelMode>;
  let storage: Storage;

  beforeEach(() => {
    storage = createInMemoryStorage();
    store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
  });

  it('returns undefined for unknown channels', async () => {
    await store.load();
    expect(store.get('unknown-channel')).toBeUndefined();
  });

  it('stores and retrieves a channel mode override', async () => {
    await store.set('ch1', 'all');
    expect(store.get('ch1')).toEqual({ mode: 'all' });
  });

  it('latest set wins for a given channel', async () => {
    await store.set('ch1', 'mention_only');
    await store.set('ch1', 'thread_follow');
    expect(store.get('ch1')).toEqual({ mode: 'thread_follow' });
  });

  it('persists across store instances', async () => {
    await store.set('ch1', 'all');
    const store2 = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await store2.load();
    expect(store2.get('ch1')).toEqual({ mode: 'all' });
  });

  it('entries returns all channel mode pairs', async () => {
    await store.set('ch1', 'all');
    await store.set('ch2', 'mention_only');
    const entries = store.entries();
    expect(entries).toContainEqual(['ch1', { mode: 'all' }]);
    expect(entries).toContainEqual(['ch2', { mode: 'mention_only' }]);
  });

  it('skips corrupted lines and loads valid ones', async () => {
    const valid = JSON.stringify({ channel: 'ch1', mode: 'all', updatedAt: 1 });
    await storage.write(`${BOT_DIR}/channel-overrides.jsonl`, `garbage\n${valid}\n{nope\n`);
    const freshStore = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await freshStore.load();
    expect(freshStore.get('ch1')).toEqual({ mode: 'all' });
  });

  // Migration safety. The shared store takes the PER-BOT directory where
  // Discord's copy took the platform dir and joined `botKey` itself, so the
  // caller now joins. The on-disk location must not have moved: an existing
  // deployment's overrides live at this exact path, and a store looking
  // somewhere else would silently read none of them.
  it('writes to the same file the pre-migration Discord store used', async () => {
    await store.set('ch1', 'all');
    const written = await storage.read('discord/bot123/channel-overrides.jsonl');
    expect(written).toContain('"channel":"ch1"');
    expect(written).toContain('"mode":"all"');
  });

  it("round-trips 'observe', the mode this widening added", async () => {
    await store.set('ch1', 'observe');
    const reloaded = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await reloaded.load();
    expect(reloaded.get('ch1')).toEqual({ mode: 'observe' });
  });

  it("keeps a mode Discord's enum does not know, rather than dropping it", async () => {
    // Telegram's `regex_match` read back through Discord's enum. It is NOT
    // adopted as a valid Discord mode — nothing in `evaluateChannelMode`'s
    // Discord-reachable table matches it, so it fails closed — but it is kept
    // rather than dropped. Dropping made `get()` return `undefined`, which the
    // adapter could not tell from "no override", so it substituted the
    // ANSWERING `mention_only` default.
    const line = JSON.stringify({ channel: 'ch1', mode: 'regex_match', updatedAt: 1 });
    await storage.write(`${BOT_DIR}/channel-overrides.jsonl`, `${line}\n`);
    const reloaded = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
    await reloaded.load();
    expect(reloaded.get('ch1')).toEqual({ mode: 'regex_match' });
  });
});
