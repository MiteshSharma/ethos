// Item 6 — `retention.vacuumAfterPrune` / `retention.minVacuumIntervalDays`.
// `pruneOldSessions` reclaims the freed pages only when the knob is on, the
// prune actually deleted rows, and the throttle interval has elapsed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteSessionStore, type SQLiteSessionStoreOptions } from '../index';

const baseSession = {
  key: 'cli:default',
  platform: 'cli',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  workingDir: '/tmp',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

const DAY_MS = 86_400_000;

describe('SQLiteSessionStore post-prune vacuum', () => {
  const stores: SQLiteSessionStore[] = [];

  const dirs: string[] = [];

  function makeStore(opts?: SQLiteSessionStoreOptions, path = ':memory:') {
    const store = new SQLiteSessionStore(path, opts);
    stores.push(store);
    return store;
  }

  /** A real on-disk db so two stores can share one file, as two processes do. */
  function sharedDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-prune-vacuum-'));
    dirs.push(dir);
    return join(dir, 'sessions.db');
  }

  /** Insert a session and backdate it so a prune at `now` removes it. */
  async function seedStale(store: SQLiteSessionStore, key: string) {
    const session = await store.createSession({ ...baseSession, key });
    // biome-ignore lint/suspicious/noExplicitAny: direct DB access for test setup
    (store as any).db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 7 * DAY_MS).toISOString(), session.id);
    return session;
  }

  const cutoff = () => new Date(Date.now() - DAY_MS);

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('does not vacuum when the knob is unset (default behavior)', async () => {
    const store = makeStore();
    await seedStale(store, 'stale');
    const vacuum = vi.spyOn(store, 'vacuum');

    expect(await store.pruneOldSessions(cutoff())).toBe(1);
    expect(vacuum).not.toHaveBeenCalled();
  });

  it('vacuums after a prune that deleted rows when vacuumAfterPrune is on', async () => {
    const store = makeStore({ vacuumAfterPrune: true });
    await seedStale(store, 'stale');
    const vacuum = vi.spyOn(store, 'vacuum');

    expect(await store.pruneOldSessions(cutoff())).toBe(1);
    expect(vacuum).toHaveBeenCalledTimes(1);
  });

  it('skips the vacuum when the prune deleted nothing', async () => {
    const store = makeStore({ vacuumAfterPrune: true });
    await store.createSession({ ...baseSession, key: 'fresh' });
    const vacuum = vi.spyOn(store, 'vacuum');

    expect(await store.pruneOldSessions(cutoff())).toBe(0);
    expect(vacuum).not.toHaveBeenCalled();
  });

  it('throttles the second vacuum inside minVacuumIntervalDays', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const store = makeStore({
      vacuumAfterPrune: true,
      minVacuumIntervalDays: 7,
      now: () => clock,
    });
    const vacuum = vi.spyOn(store, 'vacuum');

    await seedStale(store, 'stale-1');
    await store.pruneOldSessions(cutoff());
    expect(vacuum).toHaveBeenCalledTimes(1);

    // Three days later — still inside the window.
    clock += 3 * DAY_MS;
    await seedStale(store, 'stale-2');
    await store.pruneOldSessions(cutoff());
    expect(vacuum).toHaveBeenCalledTimes(1);

    // Past the window — vacuums again.
    clock += 5 * DAY_MS;
    await seedStale(store, 'stale-3');
    await store.pruneOldSessions(cutoff());
    expect(vacuum).toHaveBeenCalledTimes(2);
  });

  it('persists the last-vacuum stamp in store_meta so the throttle survives a reopen', async () => {
    const clock = Date.parse('2026-01-01T00:00:00.000Z');
    const store = makeStore({ vacuumAfterPrune: true, minVacuumIntervalDays: 7, now: () => clock });
    await seedStale(store, 'stale');
    await store.pruneOldSessions(cutoff());

    // biome-ignore lint/suspicious/noExplicitAny: direct DB access for assertion
    const row = (store as any).db
      .prepare('SELECT value FROM store_meta WHERE key = ?')
      .get('last_vacuum_at') as { value: string } | undefined;
    expect(row?.value).toBe(String(clock));
  });
  it('lets only one of two concurrent prunes claim the vacuum window', async () => {
    // `ethos run-all` launches gateway and serve as separate processes over one
    // sessions.db. The second prune here starts while the first is still inside
    // its vacuum — the window it must lose is claimed, not merely pending.
    const path = sharedDbPath();
    const clock = Date.parse('2026-01-01T00:00:00.000Z');
    const opts = { vacuumAfterPrune: true, minVacuumIntervalDays: 7, now: () => clock };
    const first = makeStore(opts, path);
    const second = makeStore(opts, path);
    const secondVacuum = vi.spyOn(second, 'vacuum').mockResolvedValue();

    await seedStale(first, 'stale-1');
    let secondPruned = 0;
    const firstVacuum = vi.spyOn(first, 'vacuum').mockImplementation(async () => {
      // The peer's prune has rows of its own to delete, so it reaches its claim.
      await seedStale(second, 'stale-2');
      secondPruned = await second.pruneOldSessions(cutoff());
    });

    expect(await first.pruneOldSessions(cutoff())).toBe(1);
    expect(firstVacuum).toHaveBeenCalledTimes(1);
    expect(secondPruned).toBe(1);
    expect(secondVacuum).not.toHaveBeenCalled();
  });

  it('treats a locked vacuum as a skipped maintenance pass, not a failed prune', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const store = makeStore({
      vacuumAfterPrune: true,
      minVacuumIntervalDays: 7,
      now: () => clock,
    });
    const locked = Object.assign(new Error('database is locked'), { errcode: 5 });
    const vacuum = vi.spyOn(store, 'vacuum').mockRejectedValue(locked);

    await seedStale(store, 'stale-1');
    await expect(store.pruneOldSessions(cutoff())).resolves.toBe(1);
    expect(vacuum).toHaveBeenCalledTimes(1);

    // The window was stamped before the vacuum ran, so the next prune inside
    // the interval does not retry the full-database rewrite.
    clock += DAY_MS;
    await seedStale(store, 'stale-2');
    expect(await store.pruneOldSessions(cutoff())).toBe(1);
    expect(vacuum).toHaveBeenCalledTimes(1);
  });
});
