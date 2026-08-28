import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateBackgroundJobInput } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteJobStore } from '../index';

function baseInput(overrides: Partial<CreateBackgroundJobInput> = {}): CreateBackgroundJobInput {
  return {
    owner: 'proc-A',
    parentSessionKey: 'cli:root',
    rootSessionKey: 'cli:root',
    childSessionKey: 'cli:root:job:build:abcd1234',
    personalityId: 'ada',
    depth: 1,
    label: 'build',
    prompt: 'do the thing',
    maxCostUsd: 2.5,
    originPlatform: 'telegram',
    originBotKey: 'bot-1',
    originChatId: 'chat-9',
    originThreadId: 'thread-3',
    ...overrides,
  };
}

describe('SQLiteJobStore', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(f + suffix)) rmSync(f + suffix);
      }
    }
    tmpFiles.length = 0;
  });

  function tmpStore(): SQLiteJobStore {
    const path = join(tmpdir(), `jobstore-${randomUUID()}.db`);
    tmpFiles.push(path);
    return new SQLiteJobStore(path);
  }

  it('create → get round-trips all fields and records a queued event', async () => {
    const store = new SQLiteJobStore(':memory:');
    const created = await store.create(baseInput());

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.status).toBe('queued');
    expect(created.spendUsd).toBe(0);
    expect(created.cancelRequested).toBe(false);
    expect(created.owner).toBe('proc-A');
    expect(created.parentSessionKey).toBe('cli:root');
    expect(created.rootSessionKey).toBe('cli:root');
    expect(created.childSessionKey).toBe('cli:root:job:build:abcd1234');
    expect(created.personalityId).toBe('ada');
    expect(created.depth).toBe(1);
    expect(created.label).toBe('build');
    expect(created.prompt).toBe('do the thing');
    expect(created.maxCostUsd).toBe(2.5);
    expect(created.originPlatform).toBe('telegram');
    expect(created.originBotKey).toBe('bot-1');
    expect(created.originChatId).toBe('chat-9');
    expect(created.originThreadId).toBe('thread-3');
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.startedAt).toBeUndefined();
    expect(created.finishedAt).toBeUndefined();

    const fetched = await store.get(created.id);
    expect(fetched).toEqual(created);

    const events = await store.getEvents(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('queued');
    store.close();
  });

  it('leaves optional fields undefined when omitted', async () => {
    const store = new SQLiteJobStore(':memory:');
    const created = await store.create({
      owner: 'proc-A',
      parentSessionKey: 'cli:root',
      rootSessionKey: 'cli:root',
      childSessionKey: 'cli:root:job:x:1',
      depth: 0,
      prompt: 'minimal',
    });
    expect(created.personalityId).toBeUndefined();
    expect(created.label).toBeUndefined();
    expect(created.maxCostUsd).toBeUndefined();
    expect(created.originPlatform).toBeUndefined();
    expect(created.summary).toBeUndefined();
    expect(created.error).toBeUndefined();
    expect(created.heartbeatAt).toBeUndefined();
    store.close();
  });

  it('get returns null for a missing id', async () => {
    const store = new SQLiteJobStore(':memory:');
    expect(await store.get('nope')).toBeNull();
    store.close();
  });

  it('claimNextQueued transitions the oldest queued row to running with heartbeat', async () => {
    const store = new SQLiteJobStore(':memory:');
    const first = await store.create(baseInput({ prompt: 'first' }));
    const second = await store.create(baseInput({ prompt: 'second' }));

    const claimed = await store.claimNextQueued('proc-A');
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).toBeGreaterThan(0);
    expect(claimed?.heartbeatAt).toBeGreaterThan(0);

    const events = await store.getEvents(first.id);
    expect(events.map((e) => e.eventType)).toEqual(['queued', 'claimed', 'running']);

    // The second is still queued.
    expect((await store.get(second.id))?.status).toBe('queued');
    store.close();
  });

  it('claimNextQueued returns null when the owner has no queued jobs', async () => {
    const store = new SQLiteJobStore(':memory:');
    expect(await store.claimNextQueued('proc-A')).toBeNull();
    store.close();
  });

  it('claimNextQueued enforces owner isolation', async () => {
    const store = new SQLiteJobStore(':memory:');
    const jobA = await store.create(baseInput({ owner: 'A' }));

    // B cannot claim A's job.
    expect(await store.claimNextQueued('B')).toBeNull();
    expect((await store.get(jobA.id))?.status).toBe('queued');

    // A can.
    const claimed = await store.claimNextQueued('A');
    expect(claimed?.id).toBe(jobA.id);
    store.close();
  });

  it('orders listByRoot deterministically via rowid tie-break on equal created_at', async () => {
    const store = tmpStore();
    // Two fast inserts likely share the same Date.now() millisecond.
    const first = await store.create(baseInput({ prompt: 'first' }));
    const second = await store.create(baseInput({ prompt: 'second' }));

    const list = await store.listByRoot('cli:root');
    expect(list).toHaveLength(2);
    // Newest-first: the second-created row comes first even when created_at ties.
    expect(list[0]?.id).toBe(second.id);
    expect(list[1]?.id).toBe(first.id);
    store.close();
  });

  it('heartbeat updates heartbeat_at on a running job', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    const before = (await store.get(job.id))?.heartbeatAt ?? 0;

    await new Promise((r) => setTimeout(r, 2));
    await store.heartbeat(job.id);
    const after = (await store.get(job.id))?.heartbeatAt ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
    // No event written for a heartbeat.
    const events = await store.getEvents(job.id);
    expect(events.some((e) => e.eventType === 'heartbeat')).toBe(false);
    store.close();
  });

  it('updateSpend sets spend_usd', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.updateSpend(job.id, 1.23);
    expect((await store.get(job.id))?.spendUsd).toBe(1.23);
    // No event written for spend.
    const events = await store.getEvents(job.id);
    expect(events.some((e) => e.eventType === 'spend')).toBe(false);
    store.close();
  });

  it('requestCancel sets cancelRequested and appends an event', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.requestCancel(job.id);
    expect((await store.get(job.id))?.cancelRequested).toBe(true);
    const events = await store.getEvents(job.id);
    expect(events.at(-1)?.eventType).toBe('cancel_requested');
    store.close();
  });

  it('finish from running → done sets summary and finished_at', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    await store.finish(job.id, 'done', { summary: 'all good' });

    const done = await store.get(job.id);
    expect(done?.status).toBe('done');
    expect(done?.summary).toBe('all good');
    expect(done?.finishedAt).toBeGreaterThan(0);

    const events = await store.getEvents(job.id);
    expect(events.at(-1)?.eventType).toBe('done');
    store.close();
  });

  it('finish from stale → done also records a recovered event', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    // reclaimStale(0) marks every running row stale regardless of heartbeat age.
    const stale = await store.reclaimStale(0);
    expect(stale.map((j) => j.id)).toContain(job.id);
    expect((await store.get(job.id))?.status).toBe('stale');

    await store.finish(job.id, 'done', { summary: 'was actually alive' });
    expect((await store.get(job.id))?.status).toBe('done');
    const types = (await store.getEvents(job.id)).map((e) => e.eventType);
    expect(types).toContain('recovered');
    expect(types).toContain('done');
    // recovered precedes done.
    expect(types.indexOf('recovered')).toBeLessThan(types.indexOf('done'));
    store.close();
  });

  it('finish from a terminal status throws', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    await store.finish(job.id, 'done', {});
    await expect(store.finish(job.id, 'failed', {})).rejects.toThrow(/not in running\/stale/);
    store.close();
  });

  // --- blocked (G4 / D21) --------------------------------------------------

  it('markBlocked parks a running row and stamps the question it is parked on', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');

    await store.markBlocked(job.id, 'clarify-77');
    const parked = await store.get(job.id);
    expect(parked?.status).toBe('blocked');
    expect(parked?.blockedRequestId).toBe('clarify-77');
    expect(parked?.blockedSince).toBeGreaterThan(0);

    const last = (await store.getEvents(job.id)).at(-1);
    expect(last?.eventType).toBe('blocked');
    expect(last?.payload).toEqual({ requestId: 'clarify-77' });
    store.close();
  });

  it('markBlocked is a no-op on a row that is not running', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput()); // still queued

    await store.markBlocked(job.id, 'clarify-77');
    expect((await store.get(job.id))?.status).toBe('queued');
    expect((await store.getEvents(job.id)).map((e) => e.eventType)).not.toContain('blocked');
    store.close();
  });

  it('resumeFromBlocked returns the row to running, clears the fields, and re-beats', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    await store.markBlocked(job.id, 'clarify-77');

    await store.resumeFromBlocked(job.id);
    const resumed = await store.get(job.id);
    expect(resumed?.status).toBe('running');
    expect(resumed?.blockedSince).toBeUndefined();
    expect(resumed?.blockedRequestId).toBeUndefined();
    // The heartbeat is bumped by the resume — otherwise a run parked longer than
    // staleMs is swept stale before the executor's next beat.
    expect(resumed?.heartbeatAt).toBeGreaterThan(0);
    expect((await store.getEvents(job.id)).at(-1)?.eventType).toBe('resumed');
    store.close();
  });

  it('resumeFromBlocked is a no-op on a row that is not blocked', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');

    await store.resumeFromBlocked(job.id);
    expect((await store.get(job.id))?.status).toBe('running');
    expect((await store.getEvents(job.id)).map((e) => e.eventType)).not.toContain('resumed');
    store.close();
  });

  it('reclaimStale IGNORES blocked rows — a parked question is not a dead host', async () => {
    const store = new SQLiteJobStore(':memory:');
    const parked = await store.create(baseInput({ prompt: 'parked' }));
    await store.claimNextQueued('proc-A');
    await store.markBlocked(parked.id, 'clarify-77');

    // reclaimStale(0) sweeps every running row regardless of heartbeat age; the
    // blocked row must survive it.
    expect(await store.reclaimStale(0)).toHaveLength(0);
    expect((await store.get(parked.id))?.status).toBe('blocked');
    store.close();
  });

  it('countActive* still count blocked — a parked run holds its slot', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput({ personalityId: 'ada' }));
    await store.claimNextQueued('proc-A');
    await store.markBlocked(job.id, 'clarify-77');

    expect(await store.countActiveByRoot('cli:root')).toBe(1);
    expect(await store.countActiveByPersonality('ada')).toBe(1);
    store.close();
  });

  it('finish from blocked works and clears the blocked fields', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    await store.markBlocked(job.id, 'clarify-77');

    // The blocked card offers Cancel, so blocked → aborted must be reachable.
    await store.finish(job.id, 'aborted', { error: 'cancelled by task_cancel' });
    const done = await store.get(job.id);
    expect(done?.status).toBe('aborted');
    expect(done?.blockedSince).toBeUndefined();
    expect(done?.blockedRequestId).toBeUndefined();
    store.close();
  });

  it('blocked rows are never pruned by the retention GC (not terminal)', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    await store.markBlocked(job.id, 'clarify-77');

    expect(await store.pruneTerminal(Date.now() + 1_000)).toBe(0);
    expect((await store.get(job.id))?.status).toBe('blocked');
    store.close();
  });

  it('reclaimStale transitions only running rows past the threshold', async () => {
    const store = new SQLiteJobStore(':memory:');
    const stale = await store.create(baseInput({ prompt: 'stale' }));
    const fresh = await store.create(baseInput({ prompt: 'fresh' }));
    await store.claimNextQueued('proc-A'); // claims `stale` (oldest)
    await store.claimNextQueued('proc-A'); // claims `fresh`

    // Threshold huge → nothing is old enough.
    expect(await store.reclaimStale(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    expect((await store.get(stale.id))?.status).toBe('running');
    expect((await store.get(fresh.id))?.status).toBe('running');

    // reclaimStale(0): every running row's heartbeat is <= now.
    const transitioned = await store.reclaimStale(0);
    expect(transitioned.map((j) => j.id).sort()).toEqual([stale.id, fresh.id].sort());
    expect((await store.get(stale.id))?.status).toBe('stale');
    expect((await store.get(stale.id))?.error).toBe('stalled — no heartbeat');
    const events = await store.getEvents(stale.id);
    expect(events.at(-1)?.eventType).toBe('stale');
    store.close();
  });

  it('reclaimStale ignores queued rows (no heartbeat)', async () => {
    const store = new SQLiteJobStore(':memory:');
    const queued = await store.create(baseInput());
    expect(await store.reclaimStale(0)).toHaveLength(0);
    expect((await store.get(queued.id))?.status).toBe('queued');
    store.close();
  });

  it('expireQueued transitions only queued rows past the threshold', async () => {
    const store = new SQLiteJobStore(':memory:');
    const queued = await store.create(baseInput());

    // Huge threshold → too new to expire.
    expect(await store.expireQueued(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    expect((await store.get(queued.id))?.status).toBe('queued');

    // ttl 0 → created_at <= now, so it expires.
    const expired = await store.expireQueued(0);
    expect(expired.map((j) => j.id)).toEqual([queued.id]);
    const row = await store.get(queued.id);
    expect(row?.status).toBe('expired');
    expect(row?.error).toContain('queued too long');
    expect((await store.getEvents(queued.id)).at(-1)?.eventType).toBe('expired');
    store.close();
  });

  it('expireQueued ignores running rows', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    expect(await store.expireQueued(0)).toHaveLength(0);
    expect((await store.get(job.id))?.status).toBe('running');
    store.close();
  });

  it('countActiveByRoot counts only queued|running', async () => {
    const store = new SQLiteJobStore(':memory:');
    await store.create(baseInput()); // queued
    const running = await store.create(baseInput());
    const done = await store.create(baseInput());
    await store.claimNextQueued('proc-A'); // first queued becomes running
    // Move `done` to done: claim then finish.
    // (claimNextQueued claims oldest; sequence: 3 created, one claimed above.)
    // Instead, directly finish `running` and `done` after claiming each.
    await store.claimNextQueued('proc-A');
    await store.finish(running.id, 'done', {});
    await store.claimNextQueued('proc-A');
    await store.finish(done.id, 'done', {});

    // Only the very first job (claimed → running, never finished) stays active.
    expect(await store.countActiveByRoot('cli:root')).toBe(1);
    expect(await store.countActiveByRoot('other')).toBe(0);
    store.close();
  });

  it('countActiveByPersonality counts only queued|running', async () => {
    const store = new SQLiteJobStore(':memory:');
    await store.create(baseInput({ personalityId: 'ada' }));
    const running = await store.create(baseInput({ personalityId: 'ada' }));
    await store.create(baseInput({ personalityId: 'linus' }));
    await store.claimNextQueued('proc-A'); // claims first ada (queued)

    expect(await store.countActiveByPersonality('ada')).toBe(2);
    expect(await store.countActiveByPersonality('linus')).toBe(1);

    // Finish the running ada job → count drops.
    await store.claimNextQueued('proc-A');
    await store.finish(running.id, 'done', {});
    expect(await store.countActiveByPersonality('ada')).toBe(1);
    store.close();
  });

  it('countActive counts every non-terminal job, unscoped, and returns to 0', async () => {
    const store = new SQLiteJobStore(':memory:');
    expect(await store.countActive()).toBe(0);

    const first = await store.create(baseInput({ personalityId: 'ada' }));
    const second = await store.create(
      baseInput({ rootSessionKey: 'other', personalityId: 'linus' }),
    );
    // Two different roots and two different personalities — neither scoped
    // count sees both, which is the whole point of the unscoped sibling.
    expect(await store.countActiveByRoot('cli:root')).toBe(1);
    expect(await store.countActiveByPersonality('ada')).toBe(1);
    expect(await store.countActive()).toBe(2);

    // blocked still holds a slot, exactly as the scoped counts treat it.
    await store.claimNextQueued('proc-A');
    await store.markBlocked(first.id, 'clarify-1');
    expect(await store.countActive()).toBe(2);

    await store.finish(first.id, 'done', {});
    expect(await store.countActive()).toBe(1);

    await store.claimNextQueued('proc-A');
    await store.finish(second.id, 'failed', { error: 'boom' });
    expect(await store.countActive()).toBe(0);
    store.close();
  });

  it('getEvents returns events in seq order', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.appendEvent(job.id, 'tool_headline', { tool: 'bash' });
    await store.appendEvent(job.id, 'spend', { usd: 0.5 });

    const events = await store.getEvents(job.id);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.eventType)).toEqual(['queued', 'tool_headline', 'spend']);
    expect(events[1]?.payload).toEqual({ tool: 'bash' });
    store.close();
  });

  // -------------------------------------------------------------------------
  // T23 — bounded tail read (G10/D12). `getEvents` with no opts still returns
  // the whole trail; `limit` takes the NEWEST n; `beforeSeq` pages backwards.
  // -------------------------------------------------------------------------

  it('getEvents({ limit }) returns the newest n, still ordered seq ASC', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput()); // seq 1 = queued
    for (let i = 0; i < 9; i++) await store.appendEvent(job.id, 'text', { text: `t${i}` });

    // 10 rows total; the newest 3 are seq 8, 9, 10 — ascending, not reversed.
    expect((await store.getEvents(job.id, { limit: 3 })).map((e) => e.seq)).toEqual([8, 9, 10]);
    // A limit larger than the trail is not an error, it is just the trail.
    expect(await store.getEvents(job.id, { limit: 999 })).toHaveLength(10);
    // Omitted opts is the old contract, byte for byte.
    expect(await store.getEvents(job.id)).toEqual(await store.getEvents(job.id, { limit: 10 }));
    store.close();
  });

  it('getEvents({ beforeSeq }) pages backwards with no gap and no overlap', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    for (let i = 0; i < 9; i++) await store.appendEvent(job.id, 'text', { text: `t${i}` });

    const page1 = await store.getEvents(job.id, { limit: 4 });
    const oldest = page1[0]?.seq ?? 0;
    const page2 = await store.getEvents(job.id, { limit: 4, beforeSeq: oldest });

    expect(page1.map((e) => e.seq)).toEqual([7, 8, 9, 10]);
    expect(page2.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    // Contiguous across the seam, and the cursor row itself is never repeated.
    expect(page2[page2.length - 1]?.seq).toBe(oldest - 1);

    const page3 = await store.getEvents(job.id, { limit: 4, beforeSeq: page2[0]?.seq });
    expect(page3.map((e) => e.seq)).toEqual([1, 2]);
    expect(await store.getEvents(job.id, { limit: 4, beforeSeq: 1 })).toEqual([]);
    store.close();
  });

  it('T23: a 10k-event job reads its tail and pages back in bounded time', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    const chunk = 'x'.repeat(200);
    // 9_999 + the `queued` row from create() = 10_000.
    for (let i = 0; i < 9_999; i++) await store.appendEvent(job.id, 'text', { text: chunk, i });

    const tStart = performance.now();
    const page1 = await store.getEvents(job.id, { limit: 200 });
    const boundedMs = performance.now() - tStart;

    expect(page1).toHaveLength(200);
    expect(page1.map((e) => e.seq)).toEqual(
      Array.from({ length: 200 }, (_, i) => 10_000 - 199 + i),
    );

    const cursor = page1[0]?.seq;
    const page2 = await store.getEvents(job.id, { limit: 200, beforeSeq: cursor });
    expect(page2).toHaveLength(200);
    expect(page2[page2.length - 1]?.seq).toBe((cursor ?? 0) - 1);
    expect(page2[0]?.seq).toBe((cursor ?? 0) - 200);
    // No overlap: the two pages share nothing.
    const seqs = new Set([...page1, ...page2].map((e) => e.seq));
    expect(seqs.size).toBe(400);

    // …and it is genuinely bounded, not a full scan that happens to slice: the
    // unbounded read of the same trail materializes 50x the rows. Timing is
    // deliberately loose (a 3x margin against a ~50x difference) so this fails
    // on a regression to O(n), not on a slow CI box.
    const tFull = performance.now();
    const all = await store.getEvents(job.id);
    const fullMs = performance.now() - tFull;
    expect(all).toHaveLength(10_000);
    expect(boundedMs * 3).toBeLessThan(fullMs);

    store.close();
  });

  it('persists across reopen of the same db file', async () => {
    const path = join(tmpdir(), `jobstore-${randomUUID()}.db`);
    tmpFiles.push(path);
    const store1 = new SQLiteJobStore(path);
    const job = await store1.create(baseInput());
    store1.close();

    const store2 = new SQLiteJobStore(path);
    const reloaded = await store2.get(job.id);
    expect(reloaded?.id).toBe(job.id);
    expect(reloaded?.prompt).toBe('do the thing');
    store2.close();
  });

  it('refuses to open a db whose user_version is newer than the code', async () => {
    const path = join(tmpdir(), `jobstore-${randomUUID()}.db`);
    tmpFiles.push(path);
    const store = new SQLiteJobStore(path);
    store.close();
    // Bump user_version beyond the code's supported version out-of-band.
    const Database = (await import('@ethosagent/sqlite')).default;
    const raw = new Database(path);
    raw.pragma('user_version = 7');
    raw.close();

    expect(() => new SQLiteJobStore(path)).toThrow(/newer than code/);
  });

  it('create → get round-trips remotePeer / remoteJobId for a proxy row', async () => {
    const store = new SQLiteJobStore(':memory:');
    const created = await store.create(
      baseInput({ remotePeer: 'host:9000', remoteJobId: 'peer-job-42' }),
    );
    expect(created.remotePeer).toBe('host:9000');
    expect(created.remoteJobId).toBe('peer-job-42');

    const fetched = await store.get(created.id);
    expect(fetched?.remotePeer).toBe('host:9000');
    expect(fetched?.remoteJobId).toBe('peer-job-42');
    store.close();
  });

  it('leaves remotePeer / remoteJobId undefined for a local row', async () => {
    const store = new SQLiteJobStore(':memory:');
    const created = await store.create(baseInput());
    expect(created.remotePeer).toBeUndefined();
    expect(created.remoteJobId).toBeUndefined();
    store.close();
  });

  it('listRunningRemote returns only running rows with a remoteJobId', async () => {
    const store = new SQLiteJobStore(':memory:');
    // A running remote proxy row.
    const remote = await store.create(
      baseInput({ remotePeer: 'host:9000', remoteJobId: 'peer-1' }),
    );
    // A running LOCAL row (no remoteJobId).
    const local = await store.create(baseInput());
    // A terminal remote row.
    const terminalRemote = await store.create(
      baseInput({ remotePeer: 'host:9000', remoteJobId: 'peer-2' }),
    );

    await store.claimNextQueued('proc-A'); // claims `remote` (oldest)
    await store.claimNextQueued('proc-A'); // claims `local`
    await store.claimNextQueued('proc-A'); // claims `terminalRemote`
    await store.finish(terminalRemote.id, 'done', {});

    const running = await store.listRunningRemote();
    expect(running.map((j) => j.id)).toEqual([remote.id]);
    // The local running row is excluded.
    expect(running.some((j) => j.id === local.id)).toBe(false);
    store.close();
  });

  it('pruneTerminal deletes old terminal rows and their events, leaving running and recent rows', async () => {
    const store = new SQLiteJobStore(':memory:');
    // An old, finished (terminal) row.
    const oldDone = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    await store.finish(oldDone.id, 'done', { summary: 'old' });
    // A running row (never terminal).
    const running = await store.create(baseInput());
    await store.claimNextQueued('proc-A');

    // Cutoff far in the future → the terminal row's finished_at is < cutoff.
    const deleted = await store.pruneTerminal(Date.now() + 1_000_000);
    expect(deleted).toBe(1);

    expect(await store.get(oldDone.id)).toBeNull();
    expect(await store.getEvents(oldDone.id)).toHaveLength(0);
    // The running row survives.
    expect((await store.get(running.id))?.status).toBe('running');

    // A cutoff in the past leaves everything.
    const deletedNone = await store.pruneTerminal(0);
    expect(deletedNone).toBe(0);
    store.close();
  });

  // -------------------------------------------------------------------------
  // Delivery claim (item 10) — "which finished jobs were never announced?"
  // -------------------------------------------------------------------------

  it('listUndelivered returns only announceable, addressed, owned, unclaimed rows', async () => {
    const store = new SQLiteJobStore(':memory:');
    const finishAs = async (
      input: Partial<CreateBackgroundJobInput>,
      terminal: 'done' | 'failed' | 'aborted',
    ): Promise<string> => {
      const job = await store.create(baseInput(input));
      await store.claimNextQueued('proc-A');
      await store.finish(job.id, terminal, { summary: 's' });
      return job.id;
    };

    const done = await finishAs({}, 'done');
    const failed = await finishAs({}, 'failed');
    // Not announceable: the user asked for it to stop.
    await finishAs({}, 'aborted');
    // Not addressable: no origin lane at all (a CLI-spawned job).
    await finishAs({ originPlatform: undefined, originChatId: undefined }, 'done');
    // Not ours.
    await finishAs({ originBotKey: 'bot-OTHER' }, 'done');
    // Not terminal.
    await store.create(baseInput());

    const rows = await store.listUndelivered(['bot-1']);
    expect(rows.map((r) => r.id).sort()).toEqual([done, failed].sort());
    // Ownership is a hard filter, not a ranking.
    expect(await store.listUndelivered(['bot-OTHER'])).toHaveLength(1);
    expect(await store.listUndelivered([])).toHaveLength(0);
    store.close();
  });

  it('claimDelivery is won exactly once, and a released claim is reclaimable', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    await store.finish(job.id, 'done', { summary: 'ok' });

    expect(await store.claimDelivery(job.id)).toBe(true);
    // Second caller (a peer process at boot) loses.
    expect(await store.claimDelivery(job.id)).toBe(false);
    expect((await store.get(job.id))?.deliveredAt).toBeGreaterThan(0);
    // A claimed row is no longer offered to the sweep.
    expect(await store.listUndelivered(['bot-1'])).toHaveLength(0);

    await store.releaseDelivery(job.id);
    expect((await store.get(job.id))?.deliveredAt).toBeUndefined();
    expect(await store.claimDelivery(job.id)).toBe(true);
    store.close();
  });

  // G5 — the SECOND delivery claim. Two SQLiteJobStore instances on one FILE
  // are two processes sharing a `jobs.db`, which is the only way to prove the
  // claim is atomic rather than a read-then-write race inside one connection.
  it('claimNotice is won exactly once across two connections to the same file, per requestId', async () => {
    const path = join(tmpdir(), `jobstore-${randomUUID()}.db`);
    tmpFiles.push(path);
    const procA = new SQLiteJobStore(path);
    const procB = new SQLiteJobStore(path);
    const job = await procA.create(baseInput());

    expect(await procA.claimNotice('rq-1', job.id)).toBe(true);
    expect(await procB.claimNotice('rq-1', job.id)).toBe(false);
    // A different question on the SAME job gets its own claim — a run parks
    // more than once, and the completion notice's `deliveredAt` is untouched.
    expect(await procB.claimNotice('rq-2', job.id)).toBe(true);
    expect((await procA.get(job.id))?.deliveredAt).toBeUndefined();

    // A released claim (the send could not be made durable) is reclaimable.
    await procA.releaseNotice('rq-1');
    expect(await procB.claimNotice('rq-1', job.id)).toBe(true);

    // Retention GC takes the claims with the job.
    await procA.claimNextQueued('proc-A');
    await procA.finish(job.id, 'done', { summary: 'ok' });
    expect(await procA.pruneTerminal(Date.now() + 1_000_000)).toBe(1);
    expect(await procB.claimNotice('rq-1', job.id)).toBe(true);

    procA.close();
    procB.close();
  });

  it('migrates a v1 database (remote columns + delivered_at + runner + blocked + notices) to v6, preserving rows', async () => {
    const path = join(tmpdir(), `jobstore-${randomUUID()}.db`);
    tmpFiles.push(path);
    // Build a v1 jobs table out-of-band: the full v1 shape minus the remote
    // columns, with user_version = 1.
    const Database = (await import('@ethosagent/sqlite')).default;
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE jobs (
        id                 TEXT PRIMARY KEY,
        owner              TEXT NOT NULL,
        parent_session_key TEXT NOT NULL,
        root_session_key   TEXT NOT NULL,
        child_session_key  TEXT NOT NULL,
        personality_id     TEXT,
        depth              INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'queued',
        label              TEXT,
        prompt             TEXT NOT NULL,
        summary            TEXT,
        error              TEXT,
        spend_usd          REAL NOT NULL DEFAULT 0,
        max_cost_usd       REAL,
        cancel_requested   INTEGER NOT NULL DEFAULT 0,
        heartbeat_at       INTEGER,
        created_at         INTEGER NOT NULL,
        started_at         INTEGER,
        finished_at        INTEGER,
        origin_platform    TEXT,
        origin_bot_key     TEXT,
        origin_chat_id     TEXT,
        origin_thread_id   TEXT
      ) STRICT;
      CREATE TABLE job_events (
        id         INTEGER PRIMARY KEY,
        job_id     TEXT NOT NULL REFERENCES jobs(id),
        seq        INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
    raw.pragma('user_version = 1');
    raw.close();

    // A row written by the OLD code, before either migration existed. It must
    // survive both ALTERs intact — a migration that drops user data is worse
    // than one that never ran.
    const rawSeed = new Database(path);
    rawSeed
      .prepare(
        `INSERT INTO jobs (id, owner, parent_session_key, root_session_key, child_session_key,
           depth, status, prompt, spend_usd, cancel_requested, created_at, finished_at,
           origin_platform, origin_bot_key, origin_chat_id, summary)
         VALUES ('legacy-1','proc-A','cli:root','cli:root','cli:root:child',1,'done','old job',
                 0.25,0,1000,2000,'telegram','bot-1','chat-9','legacy summary')`,
      )
      .run();
    rawSeed.close();

    // Opening with current code migrates v1 -> v6.
    const store = new SQLiteJobStore(path);
    const legacy = await store.get('legacy-1');
    expect(legacy?.summary).toBe('legacy summary');
    expect(legacy?.spendUsd).toBe(0.25);
    expect(legacy?.originBotKey).toBe('bot-1');
    // A pre-existing terminal row has never been announced — which is exactly
    // what the restore sweep must find.
    expect(legacy?.deliveredAt).toBeUndefined();
    expect(await store.listUndelivered(['bot-1'])).toHaveLength(1);

    const created = await store.create(
      baseInput({ remotePeer: 'host:9000', remoteJobId: 'peer-1' }),
    );
    expect(created.remotePeer).toBe('host:9000');
    expect(created.remoteJobId).toBe('peer-1');
    store.close();

    const raw2 = new Database(path);
    const version = (raw2.pragma('user_version') as Array<{ user_version: number }>)[0]
      ?.user_version;
    // The table is still STRICT after ALTER TABLE ... ADD COLUMN — an INTEGER
    // column rejects a TEXT value rather than coercing it.
    expect(() =>
      raw2.prepare(`UPDATE jobs SET delivered_at = 'not-a-number' WHERE id = 'legacy-1'`).run(),
    ).toThrow();
    raw2.close();
    expect(version).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Host-pause tolerance — bumpRunningHeartbeats
//
// A suspended VM stops the executor's heartbeat loop without killing the job.
// The gate (`reclaimStale`) is left exactly as it is; only the timestamps it
// compares get corrected, once, at the resume boundary.
// ---------------------------------------------------------------------------

describe('SQLiteJobStore.bumpRunningHeartbeats', () => {
  const SIX_HOURS = 6 * 3_600_000;
  const STALE_MS = 90_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('WITHOUT a bump, a job alive across a 6h host pause is swept stale on the first post-resume sweep', async () => {
    vi.useFakeTimers();
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');

    // The host is suspended for 6h. The job is still in flight, but nothing
    // beat while the clock was stopped.
    vi.setSystemTime(Date.now() + SIX_HOURS);

    const swept = await store.reclaimStale(STALE_MS);
    expect(swept.map((j) => j.id)).toEqual([job.id]);
    expect((await store.get(job.id))?.status).toBe('stale');
    store.close();
  });

  it('bumping by the pause duration first keeps that job running', async () => {
    vi.useFakeTimers();
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');

    vi.setSystemTime(Date.now() + SIX_HOURS);

    expect(await store.bumpRunningHeartbeats(SIX_HOURS)).toBe(1);
    expect(await store.reclaimStale(STALE_MS)).toEqual([]);
    expect((await store.get(job.id))?.status).toBe('running');
    store.close();
  });

  it('a job that genuinely stopped beating BEFORE the pause is still swept after the bump', async () => {
    vi.useFakeTimers();
    const store = new SQLiteJobStore(':memory:');
    const dead = await store.create(baseInput({ owner: 'proc-dead', prompt: 'dead' }));
    const alive = await store.create(baseInput({ owner: 'proc-alive', prompt: 'alive' }));
    await store.claimNextQueued('proc-dead');
    await store.claimNextQueued('proc-alive');

    // Ten minutes of uptime in which only `alive` keeps beating.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await store.heartbeat(alive.id);

    // Then the 6h pause.
    vi.setSystemTime(Date.now() + SIX_HOURS);
    expect(await store.bumpRunningHeartbeats(SIX_HOURS)).toBe(2);

    // The bump moves both clocks by the same amount, so it cannot blind the
    // gate to a stall that predates the pause.
    const swept = await store.reclaimStale(STALE_MS);
    expect(swept.map((j) => j.id)).toEqual([dead.id]);
    expect((await store.get(alive.id))?.status).toBe('running');
    store.close();
  });

  it('leaves queued, blocked, stale and terminal rows untouched', async () => {
    const store = new SQLiteJobStore(':memory:');
    const queued = await store.create(baseInput({ owner: 'proc-queued' }));
    const blocked = await store.create(baseInput({ owner: 'proc-blocked' }));
    const stale = await store.create(baseInput({ owner: 'proc-stale' }));
    const done = await store.create(baseInput({ owner: 'proc-done' }));
    const running = await store.create(baseInput({ owner: 'proc-running' }));

    await store.claimNextQueued('proc-blocked');
    await store.markBlocked(blocked.id, 'clarify-1');
    await store.claimNextQueued('proc-stale');
    await store.reclaimStale(0);
    await store.claimNextQueued('proc-done');
    await store.finish(done.id, 'done', { summary: 'ok' });
    await store.claimNextQueued('proc-running');

    const before = new Map(
      await Promise.all(
        [queued, blocked, stale, done].map(
          async (j) => [j.id, (await store.get(j.id))?.heartbeatAt] as const,
        ),
      ),
    );

    // Only the one running row is bumped.
    expect(await store.bumpRunningHeartbeats(SIX_HOURS)).toBe(1);

    for (const [id, heartbeatAt] of before) {
      expect((await store.get(id))?.heartbeatAt).toBe(heartbeatAt);
    }
    expect((await store.get(queued.id))?.heartbeatAt).toBeUndefined();
    expect((await store.get(running.id))?.heartbeatAt).toBeGreaterThan(Date.now());
    store.close();
  });

  it('writes nothing for a zero, negative or non-finite pause', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await store.create(baseInput());
    await store.claimNextQueued('proc-A');
    const before = (await store.get(job.id))?.heartbeatAt;

    for (const bogus of [0, -SIX_HOURS, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await store.bumpRunningHeartbeats(bogus)).toBe(0);
    }
    expect((await store.get(job.id))?.heartbeatAt).toBe(before);
    store.close();
  });
});
