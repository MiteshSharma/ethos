// Gate #9 of `plan/phases/clock-tolerance-pass.md`: the pending-candidate TTL.
//
// A snapshot-and-restore host advances the wall clock while the guest is
// frozen. Without a correction, the first post-resume prune auto-REJECTS
// candidates whose 30-day window was never exhausted in owner-visible time.
// `applyPauseOffset` discounts the known pause from the prune cutoff.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { PendingMemoryStore, TombstoneStore } from '../store';
import type { ProposeInput } from '../types';

const DATA_DIR = '/data';
const SCOPE = 'personality:default';
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 30 * DAY_MS;

function capture(text: string, hash: string): ProposeInput {
  return {
    scopeId: SCOPE,
    update: { action: 'add', key: 'MEMORY.md', content: `\n- ${text}` },
    source: 'capture',
    factHash: hash,
  };
}

describe('PendingMemoryStore.applyPauseOffset', () => {
  let storage: InMemoryStorage;
  let tombstones: TombstoneStore;
  let now: number;

  beforeEach(() => {
    storage = new InMemoryStorage();
    tombstones = new TombstoneStore({ storage, dataDir: DATA_DIR });
    now = 1_800_000_000_000;
  });

  function makeStore(): PendingMemoryStore {
    return new PendingMemoryStore({
      storage,
      dataDir: DATA_DIR,
      tombstones,
      apply: async () => {},
      ttlMs: TTL_MS,
      now: () => now,
    });
  }

  it('a candidate 29 days old survives a prune (baseline)', async () => {
    const store = makeStore();
    await store.propose(capture('user has a dog named Rex', 'h1'));

    now += 29 * DAY_MS;

    expect(await store.list(SCOPE)).toHaveLength(1);
    expect(await tombstones.has(SCOPE, 'h1')).toBe(false);
  });

  it('THE GAP: a 7-day host pause auto-rejects a 29-day-old candidate', async () => {
    const store = makeStore();
    await store.propose(capture('user has a dog named Rex', 'h1'));

    now += 29 * DAY_MS;
    now += 7 * DAY_MS; // host paused — no owner-visible time passed

    expect(await store.list(SCOPE)).toHaveLength(0);
    expect(await tombstones.has(SCOPE, 'h1')).toBe(true);
  });

  it('THE FIX: discounting the pause keeps the same candidate alive', async () => {
    const store = makeStore();
    await store.propose(capture('user has a dog named Rex', 'h1'));

    now += 29 * DAY_MS;
    now += 7 * DAY_MS;
    store.applyPauseOffset(7 * DAY_MS);

    expect(await store.list(SCOPE)).toHaveLength(1);
    expect(await tombstones.has(SCOPE, 'h1')).toBe(false);
  });

  it('still rejects a candidate past 30 days of OWNER-VISIBLE time', async () => {
    const store = makeStore();
    await store.propose(capture('stale fact', 'h2'));

    now += 31 * DAY_MS; // owner-visible
    now += 7 * DAY_MS; // paused
    store.applyPauseOffset(7 * DAY_MS);

    expect(await store.list(SCOPE)).toHaveLength(0);
    expect(await tombstones.has(SCOPE, 'h2')).toBe(true);
  });

  it('successive pauses accumulate', async () => {
    const store = makeStore();
    await store.propose(capture('user has a dog named Rex', 'h1'));

    now += 29 * DAY_MS;
    now += 3 * DAY_MS;
    store.applyPauseOffset(3 * DAY_MS);
    now += 4 * DAY_MS;
    store.applyPauseOffset(4 * DAY_MS);

    // 36 days of wall clock, 29 of them owner-visible.
    expect(await store.list(SCOPE)).toHaveLength(1);
  });

  it('non-positive and non-finite durations are a no-op', async () => {
    const store = makeStore();
    await store.propose(capture('ephemeral fact', 'h3'));

    store.applyPauseOffset(0);
    store.applyPauseOffset(-7 * DAY_MS);
    store.applyPauseOffset(Number.NaN);
    store.applyPauseOffset(Number.POSITIVE_INFINITY);

    now += 36 * DAY_MS;

    expect(await store.list(SCOPE)).toHaveLength(0);
    expect(await tombstones.has(SCOPE, 'h3')).toBe(true);
  });
});

// Codex review finding (same class as the Gateway's): a blanket cutoff shift is
// only equivalent to the plan's per-entry bump for entries that EXISTED when
// the host paused. Applied to candidates proposed after the resume it hands
// them TTL they never lost, and successive pauses compound it without bound.
describe('PendingMemoryStore.applyPauseOffset — bounded by the resume boundary', () => {
  let storage: InMemoryStorage;
  let tombstones: TombstoneStore;
  let now: number;

  beforeEach(() => {
    storage = new InMemoryStorage();
    tombstones = new TombstoneStore({ storage, dataDir: DATA_DIR });
    now = 1_800_000_000_000;
  });

  function makeStore(): PendingMemoryStore {
    return new PendingMemoryStore({
      storage,
      dataDir: DATA_DIR,
      tombstones,
      apply: async () => {},
      ttlMs: TTL_MS,
      now: () => now,
    });
  }

  it('does not extend the TTL of a candidate proposed AFTER the resume', async () => {
    const store = makeStore();

    store.applyPauseOffset(7 * DAY_MS);
    now += 1_000;
    await store.propose(capture('after resume', 'h-after'));

    // One full TTL later, with no further pause. Held unbounded, the week-long
    // pause would have bought this candidate seven days it never lost.
    now += TTL_MS + 1;
    expect(await store.list(SCOPE)).toHaveLength(0);
  });

  it('still discounts the pause for a candidate that predates it', async () => {
    const store = makeStore();

    await store.propose(capture('before pause', 'h-before'));
    now += TTL_MS - DAY_MS; // one day of TTL left...
    now += 7 * DAY_MS; // ...then the host slept a week
    store.applyPauseOffset(7 * DAY_MS);

    expect(await store.list(SCOPE)).toHaveLength(1);
  });
});
