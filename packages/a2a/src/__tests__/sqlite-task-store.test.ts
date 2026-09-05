// SQLiteA2aTaskStore (plan §3 T1.6) — persistence across restart + the
// idempotency dedupe that must survive it. `task-store.test.ts` already
// covers CRUD/pub-sub semantics against InMemoryA2aTaskStore; this file
// covers what only the durable backend can: does state (and, critically, the
// idempotency key) actually survive a process restart, simulated here by
// closing one store instance and opening a fresh one against the same file.

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import type { AgentEvent } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { A2aAsyncManager } from '../async';
import type { A2aTaskRunner } from '../rpc';
import { SQLiteA2aTaskStore } from '../sqlite-task-store';
import type { A2aTask } from '../task-store';

function seed(overrides: Partial<A2aTask> = {}): A2aTask {
  return {
    id: randomUUID(),
    status: 'submitted',
    createdAt: 1,
    idempotencyKey: 'k',
    traceId: 't',
    peerFingerprint: 'fp',
    ...overrides,
  };
}

function scriptRunner(script: AgentEvent[], counter: { runs: number }): A2aTaskRunner {
  return {
    async *run() {
      counter.runs += 1;
      for (const e of script) yield e;
    },
  };
}

const HELLO: AgentEvent[] = [
  { type: 'text_delta', text: 'hello world' },
  { type: 'done', text: 'hello world', turnCount: 1 },
];

describe('SQLiteA2aTaskStore — CRUD + pub/sub (:memory:)', () => {
  it('creates, gets, and updates a task', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const task = seed();
    await store.create(task);
    expect((await store.get(task.id))?.status).toBe('submitted');
    const updated = await store.update(task.id, { status: 'working' });
    expect(updated?.status).toBe('working');
    expect((await store.get(task.id))?.status).toBe('working');
    store.close();
  });

  it('finds by (peerFingerprint, idempotencyKey) and scopes by peer', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const a = seed({ peerFingerprint: 'fp-a', idempotencyKey: 'k' });
    await store.create(a);
    expect((await store.findByIdempotencyKey('fp-a', 'k'))?.id).toBe(a.id);
    expect(await store.findByIdempotencyKey('fp-b', 'k')).toBeNull();
    expect(await store.findByIdempotencyKey('fp-a', 'other')).toBeNull();
    store.close();
  });

  it('round-trips result/error/personalityId, encoding absence as undefined', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const task = seed({ personalityId: 'researcher' });
    await store.create(task);
    const completed = await store.update(task.id, { status: 'completed', result: 'the answer' });
    expect(completed?.result).toBe('the answer');
    expect(completed?.error).toBeUndefined();
    expect(completed?.personalityId).toBe('researcher');
    store.close();
  });

  it('notifies subscribers on update until unsubscribed', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const task = seed();
    await store.create(task);
    const seen: string[] = [];
    const unsub = store.subscribe(task.id, (t) => seen.push(t.status));
    await store.update(task.id, { status: 'working' });
    await store.update(task.id, { status: 'completed', result: 'x' });
    unsub();
    await store.update(task.id, { status: 'failed' });
    expect(seen).toEqual(['working', 'completed']);
    store.close();
  });
});

describe('SQLiteA2aTaskStore — idempotency race (Bug 2 correctness fix)', () => {
  it('create() on a repeated (peerFingerprint, idempotencyKey) returns the winner, not a thrown error', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const first = seed({ id: randomUUID(), peerFingerprint: 'fp-a', idempotencyKey: 'dupe' });
    const second = seed({ id: randomUUID(), peerFingerprint: 'fp-a', idempotencyKey: 'dupe' });
    const createdFirst = await store.create(first);
    const createdSecond = await store.create(second);
    expect(createdFirst.id).toBe(first.id);
    expect(createdSecond.id).toBe(first.id); // NOT second.id — the UNIQUE index picked a winner
    expect(await store.get(second.id)).toBeNull(); // second was never actually inserted
    store.close();
  });

  it('two concurrent A2aAsyncManager.submit() calls on the same key produce exactly one row and one execution', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({ taskStore: store, runner: scriptRunner(HELLO, counter) });
    const args = {
      personalityId: 'researcher',
      peerFingerprint: 'fp-race',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'race-key',
    } as const;

    // Both calls pass `findByIdempotencyKey` before either has inserted (the
    // `await` between the lookup and the insert is exactly the window Bug 2
    // described) — the store's UNIQUE index, not application logic, decides
    // which one actually wins the INSERT.
    const [a, b] = await Promise.all([mgr.submit(args), mgr.submit(args)]);

    expect(a.id).toBe(b.id);
    await mgr.settled(a.id);
    expect(counter.runs).toBe(1); // the loser never executed
    store.close();
  });
});

describe('SQLiteA2aTaskStore — persists across restart (T1.6 acceptance)', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(f + suffix)) rmSync(f + suffix);
      }
    }
    tmpFiles.length = 0;
  });

  function tmpPath(): string {
    const path = join(tmpdir(), `a2a-tasks-${randomUUID()}.db`);
    tmpFiles.push(path);
    return path;
  }

  it('a task submitted before a restart is retrievable after it, with its terminal state intact', async () => {
    const path = tmpPath();
    const store1 = new SQLiteA2aTaskStore(path);
    const task = seed({ id: randomUUID(), idempotencyKey: 'restart-key' });
    await store1.create(task);
    await store1.update(task.id, { status: 'completed', result: 'done before restart' });
    store1.close();

    // Simulate a restart: a fresh store instance, same underlying file.
    const store2 = new SQLiteA2aTaskStore(path);
    const reloaded = await store2.get(task.id);
    expect(reloaded?.status).toBe('completed');
    expect(reloaded?.result).toBe('done before restart');
    store2.close();
  });

  it('a replayed idempotencyKey is found by a fresh store instance against the same file', async () => {
    const path = tmpPath();
    const store1 = new SQLiteA2aTaskStore(path);
    const task = seed({ id: randomUUID(), peerFingerprint: 'fp-a', idempotencyKey: 'replay-key' });
    await store1.create(task);
    await store1.update(task.id, { status: 'completed', result: 'x' });
    store1.close();

    const store2 = new SQLiteA2aTaskStore(path);
    const found = await store2.findByIdempotencyKey('fp-a', 'replay-key');
    expect(found?.id).toBe(task.id);
    expect(found?.status).toBe('completed');
    store2.close();
  });

  it('a replayed idempotencyKey across a restart does NOT re-run the delivery loop', async () => {
    const path = tmpPath();
    const counter = { runs: 0 };
    const args = {
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'no-rerun-key',
    } as const;

    const store1 = new SQLiteA2aTaskStore(path);
    const mgr1 = new A2aAsyncManager({ taskStore: store1, runner: scriptRunner(HELLO, counter) });
    const first = await mgr1.submit(args);
    await mgr1.settled(first.id);
    expect(counter.runs).toBe(1);
    store1.close();

    // Simulate a restart: a fresh store + a fresh manager, same underlying
    // file. The runner is a NEW instance too — if the manager fails to find
    // the prior task via the persisted idempotency index, this counts as a
    // second run.
    const store2 = new SQLiteA2aTaskStore(path);
    const mgr2 = new A2aAsyncManager({ taskStore: store2, runner: scriptRunner(HELLO, counter) });
    const second = await mgr2.submit(args);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('completed');
    expect(counter.runs).toBe(1);
    store2.close();
  });

  it('a task left working before a restart is reconciled to failed, and a replay finds that failed state (Bug 3 fix)', async () => {
    const path = tmpPath();
    const store1 = new SQLiteA2aTaskStore(path);
    const stuck = seed({
      id: randomUUID(),
      peerFingerprint: 'fp-a',
      idempotencyKey: 'stuck-key',
      status: 'working',
    });
    await store1.create(stuck);
    store1.close();

    // Simulate a restart: a fresh store instance, same underlying file, then
    // the boot-time reconciliation pass `serve.ts` runs before serving any
    // traffic.
    const store2 = new SQLiteA2aTaskStore(path);
    const reconciled = await store2.failNonTerminal(
      'interrupted: server restarted before this task completed',
    );
    expect(reconciled).toBe(1);

    const reloaded = await store2.get(stuck.id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.error).toContain('interrupted');

    // A retry replaying the same idempotency key sees the failed state, not
    // a perpetual "working" — it can mint a fresh key and try again cleanly.
    const found = await store2.findByIdempotencyKey('fp-a', 'stuck-key');
    expect(found?.status).toBe('failed');
    store2.close();
  });

  it('failNonTerminal leaves already-terminal tasks untouched', async () => {
    const path = tmpPath();
    const store1 = new SQLiteA2aTaskStore(path);
    const done = seed({ id: randomUUID(), status: 'completed', result: 'already done' });
    await store1.create(done);
    store1.close();

    const store2 = new SQLiteA2aTaskStore(path);
    const reconciled = await store2.failNonTerminal('interrupted: server restarted');
    expect(reconciled).toBe(0);
    expect((await store2.get(done.id))?.status).toBe('completed');
    expect((await store2.get(done.id))?.result).toBe('already done');
    store2.close();
  });

  it('persists across reopen of the same db file (baseline reopen check)', async () => {
    const path = tmpPath();
    const store1 = new SQLiteA2aTaskStore(path);
    const task = seed({ id: randomUUID() });
    await store1.create(task);
    store1.close();

    const store2 = new SQLiteA2aTaskStore(path);
    const reloaded = await store2.get(task.id);
    expect(reloaded?.id).toBe(task.id);
    expect(reloaded?.idempotencyKey).toBe('k');
    store2.close();
  });

  it('a pre-existing v1 db (plain, non-unique idempotency index) is upgraded to enforce uniqueness on open', async () => {
    const path = tmpPath();
    // Hand-build a v1 database — the shape this store shipped with BEFORE the
    // Bug 2 fix: `a2a_tasks_idempotency` is a plain (non-unique) index. This
    // reproduces a real installation that already ran the old code, to prove
    // the v2 migration step actually rebuilds the index rather than relying
    // on `CREATE UNIQUE INDEX IF NOT EXISTS`, which is a no-op once an index
    // of that name already exists.
    const v1db = new Database(path);
    v1db.exec(`
      CREATE TABLE a2a_tasks (
        id               TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        result           TEXT,
        error            TEXT,
        created_at       INTEGER NOT NULL,
        idempotency_key  TEXT NOT NULL,
        trace_id         TEXT NOT NULL,
        peer_fingerprint TEXT NOT NULL,
        personality_id   TEXT
      ) STRICT;
      CREATE INDEX a2a_tasks_idempotency ON a2a_tasks(peer_fingerprint, idempotency_key);
      CREATE INDEX a2a_tasks_status_created ON a2a_tasks(status, created_at);
    `);
    v1db.pragma('user_version = 1');
    v1db.close();

    const store = new SQLiteA2aTaskStore(path);
    const first = seed({ id: randomUUID(), peerFingerprint: 'fp-a', idempotencyKey: 'legacy-key' });
    const second = seed({
      id: randomUUID(),
      peerFingerprint: 'fp-a',
      idempotencyKey: 'legacy-key',
    });
    const createdFirst = await store.create(first);
    const createdSecond = await store.create(second);
    // If the index were still plain, `create()` would insert a SECOND row
    // silently — no exception to catch, no winner to look up.
    expect(createdSecond.id).toBe(createdFirst.id);
    expect(await store.get(second.id)).toBeNull();
    store.close();
  });
});

describe('SQLiteA2aTaskStore — retention pruning', () => {
  it('pruneBodies clears result/error on terminal tasks past the cutoff, keeping the row', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const old = seed({
      id: randomUUID(),
      status: 'completed',
      result: 'stale',
      idempotencyKey: 'old-key',
      createdAt: 1_000,
    });
    const recent = seed({
      id: randomUUID(),
      status: 'completed',
      result: 'fresh',
      idempotencyKey: 'recent-key',
      createdAt: 100_000,
    });
    await store.create(old);
    await store.create(recent);

    const cleared = await store.pruneBodies(50_000);
    expect(cleared).toBe(1);

    const oldAfter = await store.get(old.id);
    expect(oldAfter?.result).toBeUndefined();
    expect(oldAfter?.status).toBe('completed'); // row survives — idempotency lookup still works
    const recentAfter = await store.get(recent.id);
    expect(recentAfter?.result).toBe('fresh');
    store.close();
  });

  it('does not clear bodies on non-terminal tasks regardless of age', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const working = seed({ id: randomUUID(), status: 'working', createdAt: 1 });
    await store.create(working);
    const cleared = await store.pruneBodies(Date.now());
    expect(cleared).toBe(0);
    store.close();
  });

  it('pruneTerminal deletes terminal rows past the cutoff, including their idempotency key', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const old = seed({
      id: randomUUID(),
      status: 'completed',
      peerFingerprint: 'fp-a',
      idempotencyKey: 'old-key',
      createdAt: 1_000,
    });
    await store.create(old);

    const removed = await store.pruneTerminal(50_000);
    expect(removed).toBe(1);
    expect(await store.get(old.id)).toBeNull();
    expect(await store.findByIdempotencyKey('fp-a', 'old-key')).toBeNull();
    store.close();
  });

  it('never deletes non-terminal rows via pruneTerminal', async () => {
    const store = new SQLiteA2aTaskStore(':memory:');
    const working = seed({ id: randomUUID(), status: 'working', createdAt: 1 });
    await store.create(working);
    const removed = await store.pruneTerminal(Date.now());
    expect(removed).toBe(0);
    expect(await store.get(working.id)).not.toBeNull();
    store.close();
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

describe('SQLiteA2aTaskStore — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL` — pinned so a later blanket
    // sweep cannot take it silently.
    //
    // The idempotency key surviving a restart is, in this store's own words,
    // the whole point of it: it is what makes retrying a `message/send` safe.
    // Under NORMAL a power cut can roll back the row a retry would have
    // matched, and the agent loop is re-run for a task that already ran. Task
    // writes happen at task boundaries, not in a loop.
    const store = new SQLiteA2aTaskStore(':memory:');
    // Asserted against the opened database, not the source text.
    expect(syncPragma(store)).toBe(2);
    store.close();
  });
});
