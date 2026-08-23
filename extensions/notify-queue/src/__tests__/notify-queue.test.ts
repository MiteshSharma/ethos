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
