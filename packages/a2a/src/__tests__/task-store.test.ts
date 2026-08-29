// Task store — lifecycle bookkeeping + SSE pub/sub + idempotency index.

import { describe, expect, it } from 'vitest';
import { type A2aTask, InMemoryA2aTaskStore, isTerminalStatus, newTaskId } from '../task-store';

function seed(overrides: Partial<A2aTask> = {}): A2aTask {
  return {
    id: newTaskId(),
    status: 'submitted',
    createdAt: 1,
    idempotencyKey: 'k',
    traceId: 't',
    peerFingerprint: 'fp',
    ...overrides,
  };
}

describe('isTerminalStatus', () => {
  it('classifies both terminal states and neither non-terminal state', () => {
    for (const s of ['completed', 'failed'] as const) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    expect(isTerminalStatus('submitted')).toBe(false);
    expect(isTerminalStatus('working')).toBe(false);
  });
});

describe('InMemoryA2aTaskStore', () => {
  it('creates, gets, and updates a task', async () => {
    const store = new InMemoryA2aTaskStore();
    const task = seed();
    await store.create(task);
    expect((await store.get(task.id))?.status).toBe('submitted');
    const updated = await store.update(task.id, { status: 'working' });
    expect(updated?.status).toBe('working');
    expect((await store.get(task.id))?.status).toBe('working');
  });

  it('finds by (peerFingerprint, idempotencyKey) and scopes by peer', async () => {
    const store = new InMemoryA2aTaskStore();
    const a = seed({ peerFingerprint: 'fp-a', idempotencyKey: 'k' });
    await store.create(a);
    expect((await store.findByIdempotencyKey('fp-a', 'k'))?.id).toBe(a.id);
    expect(await store.findByIdempotencyKey('fp-b', 'k')).toBeNull();
    expect(await store.findByIdempotencyKey('fp-a', 'other')).toBeNull();
  });

  // The index key is `peerFingerprint \x00 idempotencyKey`. The NUL separator is
  // load-bearing: concatenated without it, `fp` + `a-b` and `fpa` + `-b` are the
  // same key, so one peer's task would answer another peer's replay — a
  // cross-peer idempotency collision.
  it('keys peer and idempotency key separately, so a shifted boundary does not collide', async () => {
    const store = new InMemoryA2aTaskStore();
    const a = seed({ peerFingerprint: 'fp', idempotencyKey: 'a-b' });
    const b = seed({ peerFingerprint: 'fpa', idempotencyKey: '-b' });
    await store.create(a);
    await store.create(b);

    expect((await store.findByIdempotencyKey('fp', 'a-b'))?.id).toBe(a.id);
    expect((await store.findByIdempotencyKey('fpa', '-b'))?.id).toBe(b.id);
  });

  it('notifies subscribers on update until unsubscribed', async () => {
    const store = new InMemoryA2aTaskStore();
    const task = seed();
    await store.create(task);
    const seen: string[] = [];
    const unsub = store.subscribe(task.id, (t) => seen.push(t.status));
    await store.update(task.id, { status: 'working' });
    await store.update(task.id, { status: 'completed', result: 'x' });
    unsub();
    await store.update(task.id, { status: 'failed' });
    expect(seen).toEqual(['working', 'completed']);
  });

  // Bug 2 fix: `create()` returns the CANONICAL row for
  // `(peerFingerprint, idempotencyKey)` — its own argument on a fresh key, or
  // the ALREADY-EXISTING task if one is already indexed under that key. This
  // store has no `await` inside `create()`, so it cannot itself be raced, but
  // it must still answer a second `create()` under the same key the same way
  // the SQLite store does (see `sqlite-task-store.test.ts`'s equivalent test)
  // so `A2aAsyncManager.submit()` behaves identically against either backend.
  it('create() returns the existing row instead of overwriting it on a repeated idempotency key', async () => {
    const store = new InMemoryA2aTaskStore();
    const first = seed({ peerFingerprint: 'fp-a', idempotencyKey: 'dupe' });
    const second = seed({ peerFingerprint: 'fp-a', idempotencyKey: 'dupe' });
    const createdFirst = await store.create(first);
    const createdSecond = await store.create(second);
    expect(createdFirst.id).toBe(first.id);
    expect(createdSecond.id).toBe(first.id); // NOT second.id — first won
    expect(await store.get(second.id)).toBeNull(); // second was never actually inserted
  });

  it('create() on a fresh key returns its own argument', async () => {
    const store = new InMemoryA2aTaskStore();
    const task = seed();
    const created = await store.create(task);
    expect(created.id).toBe(task.id);
  });
});

describe('InMemoryA2aTaskStore — failNonTerminal (Bug 3 boot reconciliation)', () => {
  it('fails every submitted/working task with the given reason and leaves terminal ones untouched', async () => {
    const store = new InMemoryA2aTaskStore();
    const working = seed({ status: 'working', idempotencyKey: 'k-working' });
    const submitted = seed({ status: 'submitted', idempotencyKey: 'k-submitted' });
    const completed = seed({ status: 'completed', result: 'done', idempotencyKey: 'k-completed' });
    const failed = seed({ status: 'failed', error: 'already dead', idempotencyKey: 'k-failed' });
    await store.create(working);
    await store.create(submitted);
    await store.create(completed);
    await store.create(failed);

    const count = await store.failNonTerminal(
      'interrupted: server restarted before this task completed',
    );
    expect(count).toBe(2);

    expect((await store.get(working.id))?.status).toBe('failed');
    expect((await store.get(working.id))?.error).toBe(
      'interrupted: server restarted before this task completed',
    );
    expect((await store.get(submitted.id))?.status).toBe('failed');
    // Terminal tasks are untouched — status AND their original result/error survive.
    expect((await store.get(completed.id))?.status).toBe('completed');
    expect((await store.get(completed.id))?.result).toBe('done');
    expect((await store.get(failed.id))?.error).toBe('already dead');
  });

  it('a subsequent idempotency lookup finds the reconciled failed state, not a perpetual working', async () => {
    const store = new InMemoryA2aTaskStore();
    const stuck = seed({ peerFingerprint: 'fp-a', idempotencyKey: 'stuck-key', status: 'working' });
    await store.create(stuck);

    await store.failNonTerminal('interrupted: server restarted before this task completed');

    const found = await store.findByIdempotencyKey('fp-a', 'stuck-key');
    expect(found?.status).toBe('failed');
    expect(found?.error).toContain('interrupted');
  });

  it('returns 0 when nothing is non-terminal', async () => {
    const store = new InMemoryA2aTaskStore();
    await store.create(seed({ status: 'completed' }));
    expect(await store.failNonTerminal('irrelevant')).toBe(0);
  });
});
