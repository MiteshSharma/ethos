import { beforeEach, describe, expect, it } from 'vitest';
import { SQLiteNotifyQueue } from '../index';

function queue() {
  return new SQLiteNotifyQueue(':memory:');
}

describe('SQLiteNotifyQueue', () => {
  let store: SQLiteNotifyQueue;
  beforeEach(() => {
    store = queue();
  });

  it('readAndConsume returns nothing for a personality with no pending rows', async () => {
    const rows = await store.readAndConsume('team-a', 'researcher');
    expect(rows).toEqual([]);
  });

  it('write then readAndConsume returns the row and marks it consumed', async () => {
    await store.write({
      team: 'team-a',
      assigneePersonalityId: 'researcher',
      kind: 'kanban',
      ref: 'task-123',
    });

    const first = await store.readAndConsume('team-a', 'researcher');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      team: 'team-a',
      assigneePersonalityId: 'researcher',
      kind: 'kanban',
      ref: 'task-123',
    });
    expect(typeof first[0].createdAt).toBe('number');

    // Consumed — a second read sees nothing left.
    const second = await store.readAndConsume('team-a', 'researcher');
    expect(second).toEqual([]);
  });

  it('a row with no ref reads back with ref undefined, not null', async () => {
    await store.write({ team: 'team-a', assigneePersonalityId: 'researcher', kind: 'kanban' });
    const rows = await store.readAndConsume('team-a', 'researcher');
    expect(rows).toHaveLength(1);
    expect(rows[0].ref).toBeUndefined();
  });

  it('returns rows oldest-first', async () => {
    await store.write({ team: 'team-a', assigneePersonalityId: 'researcher', kind: 'a', ref: '1' });
    await store.write({ team: 'team-a', assigneePersonalityId: 'researcher', kind: 'b', ref: '2' });
    await store.write({ team: 'team-a', assigneePersonalityId: 'researcher', kind: 'c', ref: '3' });

    const rows = await store.readAndConsume('team-a', 'researcher');
    expect(rows.map((r) => r.ref)).toEqual(['1', '2', '3']);
  });

  it('isolates rows per (team, assigneePersonalityId)', async () => {
    await store.write({ team: 'team-a', assigneePersonalityId: 'researcher', kind: 'kanban' });
    await store.write({ team: 'team-b', assigneePersonalityId: 'researcher', kind: 'kanban' });
    await store.write({ team: 'team-a', assigneePersonalityId: 'engineer', kind: 'kanban' });

    const teamAResearcher = await store.readAndConsume('team-a', 'researcher');
    expect(teamAResearcher).toHaveLength(1);

    // Neither of the other two rows was touched by the read above.
    const teamBResearcher = await store.readAndConsume('team-b', 'researcher');
    expect(teamBResearcher).toHaveLength(1);

    const teamAEngineer = await store.readAndConsume('team-a', 'engineer');
    expect(teamAEngineer).toHaveLength(1);
  });

  it('a second concurrent-style readAndConsume never double-delivers', async () => {
    await store.write({ team: 'team-a', assigneePersonalityId: 'researcher', kind: 'kanban' });
    const [a, b] = await Promise.all([
      store.readAndConsume('team-a', 'researcher'),
      store.readAndConsume('team-a', 'researcher'),
    ]);
    // Exactly one of the two calls sees the row; the other sees nothing.
    const total = a.length + b.length;
    expect(total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see AGENTS.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SQLiteNotifyQueue — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL` — pinned so a later blanket
    // sweep cannot take it silently.
    //
    // A queued notification is work owed to a person: the wake notice that
    // says a background job finished. Losing the enqueue to a power cut is a
    // notice that is never delivered and never retried. The queue is written
    // once per notification, so FULL is not on any hot path.
    const store = new SQLiteNotifyQueue(':memory:');
    // Asserted against the opened database, not the source text.
    expect(syncPragma(store)).toBe(2);
    store.close();
  });
});
