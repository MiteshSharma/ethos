import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifyStore, ClarifySurfaceType, PendingClarify } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClarifyBridge,
  type ClarifyBridgeOptions,
  ClarifyNoSurfaceError,
  ClarifyTimedOutNoDefaultError,
} from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';

function makeRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'r1',
    sessionId: 's1',
    surfaceType: 'cli',
    surfaceContext: {},
    question: 'Which database?',
    answerableBy: 'anyone',
    createdAt: '2026-05-15T00:00:00.000Z',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    presentedAt: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('FileClarifyStore', () => {
  it('round-trips add / get / list / remove', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await store.add(makeRow({ requestId: 'a', sessionId: 's1' }));
    await store.add(makeRow({ requestId: 'b', sessionId: 's2' }));

    expect((await store.get('a'))?.requestId).toBe('a');
    expect(await store.get('missing')).toBeNull();
    expect(await store.list()).toHaveLength(2);
    expect(await store.list({ sessionId: 's2' })).toHaveLength(1);

    await store.remove('a');
    expect(await store.get('a')).toBeNull();
    expect(await store.list()).toHaveLength(1);
  });

  it('add replaces a row with the same requestId', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await store.add(makeRow({ requestId: 'a', question: 'first' }));
    await store.add(makeRow({ requestId: 'a', question: 'second' }));
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.question).toBe('second');
  });

  it('list() filters by jobId', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await store.add(makeRow({ requestId: 'a', jobId: 'job-1' }));
    await store.add(makeRow({ requestId: 'b', jobId: 'job-2' }));
    await store.add(makeRow({ requestId: 'c' }));
    expect((await store.list({ jobId: 'job-1' })).map((r) => r.requestId)).toEqual(['a']);
  });

  it('expired() returns only rows past the deadline', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await store.add(makeRow({ requestId: 'old', defaultDeadlineAt: '2026-05-15T00:00:00.000Z' }));
    await store.add(makeRow({ requestId: 'new', defaultDeadlineAt: '2026-05-15T01:00:00.000Z' }));
    const expired = await store.expired(new Date('2026-05-15T00:30:00.000Z'));
    expect(expired.map((r) => r.requestId)).toEqual(['old']);
  });

  // D2/T17 — a still-queued row (never presented) persists with a null
  // deadline. It must never be treated as expired, no matter how far `now`
  // has advanced, because it has no timer running.
  it('expired() never returns a row with a null defaultDeadlineAt', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await store.add(makeRow({ requestId: 'queued', defaultDeadlineAt: null, presentedAt: null }));
    const expired = await store.expired(new Date('2099-01-01T00:00:00.000Z'));
    expect(expired).toEqual([]);
  });

  it('tolerates a corrupt pending file', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/ethos/clarify');
    await storage.write('/ethos/clarify/pending.json', '{ not json');
    const store = new FileClarifyStore(storage, '/ethos/clarify');
    expect(await store.list()).toEqual([]);
  });

  // The Telegram surface needs to write back the platform message id after
  // sending the prompt, so a force-reply or restart sweep can find the row.
  it('update() patches an existing row by requestId', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await store.add(makeRow({ requestId: 'r1', surfaceContext: { chatId: 42 } }));
    await store.update('r1', { surfaceContext: { chatId: 42, messageId: 99 } });
    const row = await store.get('r1');
    expect(row?.surfaceContext).toEqual({ chatId: 42, messageId: 99 });
  });

  it('update() is a no-op for a missing requestId', async () => {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    await expect(store.update('missing', { surfaceContext: { x: 1 } })).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

/**
 * A deterministic queue over a surface's presentations — avoids guessing how
 * many microtask ticks `request()` takes (it now awaits `resolveRouting()`
 * and `store.add()`, both real async hops) by awaiting an actual signal
 * instead of a fixed number of `Promise.resolve()` flushes.
 */
function makePresentedQueue(bridge: ClarifyBridge, surfaceType: ClarifySurfaceType) {
  const items: PendingClarify[] = [];
  const waiting: Array<(v: PendingClarify) => void> = [];
  bridge.registerPresenter(surfaceType, (req) => {
    const waiter = waiting.shift();
    if (waiter) waiter(req);
    else items.push(req);
  });
  return {
    all: items,
    next(): Promise<PendingClarify> {
      const item = items.shift();
      if (item) return Promise.resolve(item);
      return new Promise<PendingClarify>((resolve) => waiting.push(resolve));
    },
  };
}

describe('ClarifyBridge', () => {
  function makeBridge(opts?: ClarifyBridgeOptions) {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    return { bridge: new ClarifyBridge(store, opts), store };
  }

  const baseInput = {
    question: 'Which database for the migration?',
    timeoutMs: 900_000,
    answerableBy: 'anyone' as const,
    sessionId: 's1',
    surfaceType: 'cli' as const,
  };

  it('rejects with CLARIFY_NO_SURFACE when no presenter is registered', async () => {
    const { bridge } = makeBridge();
    await expect(bridge.request(baseInput)).rejects.toBeInstanceOf(ClarifyNoSurfaceError);
  });

  // G2 — a presenter registered for one surface type must never be invoked
  // for a request resolved to a different surface type.
  it('rejects with CLARIFY_NO_SURFACE when a presenter exists for a different surface', async () => {
    const { bridge } = makeBridge();
    bridge.registerPresenter('telegram', () => {});
    await expect(bridge.request(baseInput)).rejects.toBeInstanceOf(ClarifyNoSurfaceError);
  });

  it('presents the request and resolves with the user answer', async () => {
    const { bridge, store } = makeBridge();
    const queue = makePresentedQueue(bridge, 'cli');

    const pending = bridge.request({ ...baseInput, options: ['postgres', 'sqlite'] });
    const row = await queue.next();
    await bridge.respond({ requestId: row.requestId, answer: 'postgres', source: 'user' });

    const res = await pending;
    expect(res.answer).toBe('postgres');
    expect(res.source).toBe('user');
    expect(row.question).toBe(baseInput.question);
    // Presented rows carry a deadline derived at present time (D2).
    expect(row.presentedAt).not.toBeNull();
    expect(row.defaultDeadlineAt).not.toBeNull();
    // Persisted before presenting, removed on resolve.
    expect(await store.list()).toHaveLength(0);
  });

  it('persists the pending row before presenting', async () => {
    const { bridge, store } = makeBridge();
    let rowsAtPresentTime = -1;
    let capturedId = '';
    const presented = new Promise<void>((resolve) => {
      bridge.registerPresenter('cli', async (req) => {
        capturedId = req.requestId;
        rowsAtPresentTime = (await store.list()).length;
        resolve();
      });
    });
    const pending = bridge.request(baseInput);
    await presented;
    await bridge.respond({ requestId: capturedId, answer: 'x', source: 'user' });
    await pending;
    expect(rowsAtPresentTime).toBe(1);
  });

  // Fix 3 (pi-delegation.md §1b) — the presented/deadline transition must be
  // durable BEFORE the presenter is invoked, not fire-and-forget after. A
  // crash between "shown in memory" and "persisted to disk" used to leave a
  // permanently null-deadline row: sweep-immune by design (D2) but never
  // re-presented either (its in-memory queue entry died with the process) —
  // a permanent leak. Assert the disk state is already correct by the time
  // the presenter runs.
  it('the presented/deadline transition is durable BEFORE the presenter is invoked (Fix 3)', async () => {
    const { bridge, store } = makeBridge();
    let deadlineOnDiskAtPresentTime: string | null | undefined;
    let capturedId = '';
    const presented = new Promise<void>((resolve) => {
      bridge.registerPresenter('cli', async (req) => {
        capturedId = req.requestId;
        const persisted = await store.get(req.requestId);
        deadlineOnDiskAtPresentTime = persisted?.defaultDeadlineAt;
        resolve();
      });
    });

    const pending = bridge.request(baseInput);
    await presented;

    expect(deadlineOnDiskAtPresentTime).not.toBeNull();
    expect(deadlineOnDiskAtPresentTime).toBeDefined();

    await bridge.respond({ requestId: capturedId, answer: 'x', source: 'user' });
    await pending;
  });

  // G2 — only the presenter for the resolved surface type is ever invoked;
  // a differently-registered surface never sees the row.
  it('only invokes the presenter for the resolved surface type', async () => {
    const { bridge } = makeBridge();
    const cliQueue = makePresentedQueue(bridge, 'cli');
    const telegramPresented: PendingClarify[] = [];
    bridge.registerPresenter('telegram', (req) => {
      telegramPresented.push(req);
    });

    const pending = bridge.request(baseInput);
    const row = await cliQueue.next();
    await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
    await pending;

    expect(telegramPresented).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // G1/D22 — per-job FIFO lanes (Phase 1 I1, done-when #1 and #2)
  // ---------------------------------------------------------------------------

  describe('per-job lanes (G1/D22)', () => {
    it('presents both immediately when two different jobIds share a session (no queueing)', async () => {
      const { bridge } = makeBridge();
      const queue = makePresentedQueue(bridge, 'cli');

      const p1 = bridge.request({ ...baseInput, jobId: 'job-1' });
      const p2 = bridge.request({ ...baseInput, jobId: 'job-2' });

      // Both present — different lanes, neither waits on the other.
      const rowA = await queue.next();
      const rowB = await queue.next();
      expect([rowA.jobId, rowB.jobId].sort()).toEqual(['job-1', 'job-2']);

      await bridge.respond({ requestId: rowA.requestId, answer: 'a', source: 'user' });
      await bridge.respond({ requestId: rowB.requestId, answer: 'b', source: 'user' });
      await expect(p1).resolves.toBeDefined();
      await expect(p2).resolves.toBeDefined();
    });

    it('queues a second request for the same job behind the first (no CLARIFY_BUSY)', async () => {
      const { bridge } = makeBridge();
      const queue = makePresentedQueue(bridge, 'cli');

      const first = bridge.request({ ...baseInput, jobId: 'job-1' });
      const second = bridge.request({ ...baseInput, jobId: 'job-1', question: 'second question' });

      const row1 = await queue.next();
      expect(row1.question).toBe(baseInput.question);

      // The second must not have presented yet — it's queued behind the
      // first. Race the (still-pending) next presentation against a short
      // real timeout; racing doesn't cancel it, so it can still be awaited
      // below once the first resolves and the queue actually drains.
      const secondPresentedPromise = queue.next();
      const notYetSentinel = Symbol('not-yet-presented');
      const raced = await Promise.race([
        secondPresentedPromise,
        new Promise((resolve) => setTimeout(() => resolve(notYetSentinel), 20)),
      ]);
      expect(raced).toBe(notYetSentinel);
      expect(bridge.listPending(undefined, 'job-1')).toHaveLength(2); // one presented, one queued

      await bridge.respond({ requestId: row1.requestId, answer: 'a', source: 'user' });
      await first;

      // Resolving the first drains the queue — the second now presents.
      const row2 = await secondPresentedPromise;
      expect(row2.question).toBe('second question');

      await bridge.respond({ requestId: row2.requestId, answer: 'b', source: 'user' });
      await expect(second).resolves.toMatchObject({ answer: 'b' });
    });

    it('a foreground clarify with no jobId keeps the per-session lane (unchanged today)', async () => {
      const { bridge } = makeBridge();
      const queue = makePresentedQueue(bridge, 'cli');

      const first = bridge.request(baseInput);
      const row1 = await queue.next();

      const second = bridge.request(baseInput);
      // Same session, no jobId on either — second queues behind the first;
      // it must not present until the first resolves.
      expect(bridge.hasPending('s1')).toBe(true);
      await vi.waitFor(() => {
        expect(bridge.listPending('s1')).toHaveLength(2); // one presented, one queued
      });

      await bridge.respond({ requestId: row1.requestId, answer: 'a', source: 'user' });
      await first;
      const row2 = await queue.next();
      await bridge.respond({ requestId: row2.requestId, answer: 'b', source: 'user' });
      await expect(second).resolves.toMatchObject({ answer: 'b' });
    });

    // T16 — a question queued behind a 15-minute question gets its own full
    // window, measured from when IT is presented, not from when it was requested.
    it('a queued request gets its own full timeout window from its own present time (T16)', async () => {
      vi.useFakeTimers();
      try {
        const { bridge } = makeBridge();
        const queue = makePresentedQueue(bridge, 'cli');
        const FIFTEEN_MIN = 15 * 60_000;

        bridge.request({ ...baseInput, jobId: 'job-1', timeoutMs: FIFTEEN_MIN });
        const row1 = await queue.next();
        const second = bridge.request({
          ...baseInput,
          jobId: 'job-1',
          timeoutMs: FIFTEEN_MIN,
          question: 'second',
        });

        // Burn 10 of the first request's 15 minutes before it resolves.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await bridge.respond({ requestId: row1.requestId, answer: 'a', source: 'user' });

        // The second request is now presented — its window starts fresh.
        const row2 = await queue.next();
        expect(row2.question).toBe('second');

        // Advance 14 of its 15 minutes — it must NOT have timed out yet,
        // proving its deadline was derived at presentation, not at the
        // original request (which was ~10 minutes ago).
        await vi.advanceTimersByTimeAsync(14 * 60_000);
        let secondSettled = false;
        second
          .catch(() => {})
          .finally(() => {
            secondSettled = true;
          });
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        // Advance past its own full window — now it times out (no default).
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await expect(second).rejects.toBeInstanceOf(ClarifyTimedOutNoDefaultError);
      } finally {
        vi.useRealTimers();
      }
    });

    // T17 — a queued row (in-memory, mirroring the persisted null-deadline
    // row) survives sweep() without being expired.
    it('sweep() does not expire a still-queued request (T17)', async () => {
      const { bridge, store } = makeBridge();
      const queue = makePresentedQueue(bridge, 'cli');

      const first = bridge.request({ ...baseInput, jobId: 'job-1', timeoutMs: 900_000 });
      const row1 = await queue.next();
      const second = bridge.request({ ...baseInput, jobId: 'job-1', timeoutMs: 900_000 });

      // Wait for the second (queued) row to actually land in the store —
      // `request()` persists it asynchronously before queueing.
      await vi.waitFor(async () => {
        expect(await store.list()).toHaveLength(2);
      });

      // The queued row is persisted with a null deadline — a sweep run "at
      // boot" must leave it alone.
      await bridge.sweep(new Date('2099-01-01T00:00:00.000Z'));
      expect(await store.list()).toHaveLength(2); // both rows still persisted

      await bridge.respond({ requestId: row1.requestId, answer: 'a', source: 'user' });
      await first;
      const row2 = await queue.next(); // drained after sweep, unaffected

      await bridge.respond({ requestId: row2.requestId, answer: 'b', source: 'user' });
      await expect(second).resolves.toMatchObject({ answer: 'b' });
    });

    it('a still-queued request can be cancelled without disturbing the lane', async () => {
      const { bridge } = makeBridge();
      const queue = makePresentedQueue(bridge, 'cli');

      const controller = new AbortController();
      const first = bridge.request({ ...baseInput, jobId: 'job-1' });
      const row1 = await queue.next();
      const second = bridge.request({
        ...baseInput,
        jobId: 'job-1',
        abortSignal: controller.signal,
      });

      controller.abort();
      await expect(second).resolves.toMatchObject({ source: 'cancel' });

      // Resolving the first should still drive the (now-empty) queue cleanly.
      await bridge.respond({ requestId: row1.requestId, answer: 'a', source: 'user' });
      await expect(first).resolves.toMatchObject({ answer: 'a' });
      expect(queue.all).toHaveLength(0); // the cancelled one was never presented
    });
  });

  // ---------------------------------------------------------------------------
  // D7/G2/G3 — origin-lane routing with presence override (Phase 1 I3, T18)
  // ---------------------------------------------------------------------------

  describe('origin-lane routing (D7/G2/G3, T18)', () => {
    it('routes a job clarify to its origin lane when no presence was recorded ("both idle → origin")', async () => {
      const { bridge } = makeBridge();
      bridge.setOriginResolver(() => ({ surfaceType: 'telegram' }));
      const queue = makePresentedQueue(bridge, 'telegram');

      const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
      const row = await queue.next();
      await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
      await pending;
    });

    it('falls back to the input surfaceType when the job has no recorded origin', async () => {
      const { bridge } = makeBridge();
      bridge.setOriginResolver(() => null);
      const queue = makePresentedQueue(bridge, 'cli');

      const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
      const row = await queue.next();
      await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
      await pending;
    });

    it('routes to a foreground surface active within the presence TTL, overriding origin', async () => {
      vi.useFakeTimers();
      try {
        const { bridge } = makeBridge({ presenceTtlMs: 5 * 60_000 });
        bridge.setOriginResolver(() => ({ surfaceType: 'telegram' }));
        const cliQueue = makePresentedQueue(bridge, 'cli');
        bridge.registerPresenter('telegram', () => {
          throw new Error('should not route to origin — presence override expected');
        });

        bridge.recordPresence('cli');
        await vi.advanceTimersByTimeAsync(60_000); // 1 min later — well within TTL

        const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
        const row = await cliQueue.next();
        await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to origin once the presence TTL has elapsed', async () => {
      vi.useFakeTimers();
      try {
        const { bridge } = makeBridge({ presenceTtlMs: 5 * 60_000 });
        bridge.setOriginResolver(() => ({ surfaceType: 'telegram' }));
        const telegramQueue = makePresentedQueue(bridge, 'telegram');
        bridge.registerPresenter('cli', () => {
          throw new Error('presence expired — must not route to cli');
        });

        bridge.recordPresence('cli');
        await vi.advanceTimersByTimeAsync(6 * 60_000); // past the 5 min TTL

        const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
        const row = await telegramQueue.next();
        await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it('a tie at exactly the TTL boundary routes to origin', async () => {
      vi.useFakeTimers();
      try {
        const { bridge } = makeBridge({ presenceTtlMs: 5 * 60_000 });
        bridge.setOriginResolver(() => ({ surfaceType: 'telegram' }));
        const telegramQueue = makePresentedQueue(bridge, 'telegram');
        bridge.registerPresenter('cli', () => {
          throw new Error('a tie must route to origin, not cli');
        });

        bridge.recordPresence('cli');
        await vi.advanceTimersByTimeAsync(5 * 60_000); // exactly the TTL — not < ttl

        const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
        const row = await telegramQueue.next();
        await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it('presence recorded on the origin surface itself is not treated as an override', async () => {
      const { bridge } = makeBridge();
      bridge.setOriginResolver(() => ({ surfaceType: 'telegram' }));
      const telegramQueue = makePresentedQueue(bridge, 'telegram');

      bridge.recordPresence('telegram');
      const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
      const row = await telegramQueue.next();
      await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
      await pending;
    });

    // Fix 1 (pi-delegation.md §1b) — the foreground-override route used to
    // hardcode `surfaceContext: {}`, losing the destination's chatId/botKey
    // even though it correctly picked the surface. Assert the row actually
    // carries what `recordPresence` was given.
    it('the foreground-override route carries real surfaceContext, not {} (Fix 1)', async () => {
      const { bridge } = makeBridge();
      bridge.setOriginResolver(() => ({
        surfaceType: 'telegram',
        surfaceContext: { chatId: 'origin-chat' },
      }));
      const cliQueue = makePresentedQueue(bridge, 'cli');
      bridge.registerPresenter('telegram', () => {
        throw new Error('should not route to origin — presence override expected');
      });

      bridge.recordPresence('cli', { chatId: 'cli-chat-42', botKey: 'bot-a' });

      const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
      const row = await cliQueue.next();
      expect(row.surfaceContext).toEqual({ chatId: 'cli-chat-42', botKey: 'bot-a' });

      await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
      await pending;
    });

    it('a foreground clarify (no jobId) ignores origin routing and presence entirely', async () => {
      const { bridge } = makeBridge();
      bridge.setOriginResolver(() => ({ surfaceType: 'telegram' }));
      const cliQueue = makePresentedQueue(bridge, 'cli');
      bridge.registerPresenter('telegram', () => {
        throw new Error('should never be called for a foreground clarify');
      });

      const pending = bridge.request(baseInput); // no jobId
      const row = await cliQueue.next();
      await bridge.respond({ requestId: row.requestId, answer: 'x', source: 'user' });
      await pending;
    });

    // Phase-1 done-when #4 — a job spawned with an origin on Telegram is
    // answered from a completely different surface (web) via the generic
    // requestId-keyed respond() path; resolves exactly once, no dangling
    // presenter on Telegram.
    it('a job answered on a surface other than where it was presented resolves exactly once', async () => {
      const { bridge } = makeBridge();
      bridge.setOriginResolver(() => ({ surfaceType: 'telegram' }));
      const telegramQueue = makePresentedQueue(bridge, 'telegram');
      const resolvedRows: string[] = [];
      bridge.onResolved((row) => resolvedRows.push(row.requestId));

      const pending = bridge.request({ ...baseInput, jobId: 'job-1', surfaceType: 'cli' });
      const row = await telegramQueue.next();

      // "Answered from web" — a completely different surface resolving by
      // requestId, exactly what the `clarify.respond` RPC does.
      await bridge.respond({ requestId: row.requestId, answer: 'dual-write', source: 'user' });
      await expect(pending).resolves.toMatchObject({ answer: 'dual-write' });
      expect(resolvedRows).toEqual([row.requestId]);

      // A second respond() for the same id (e.g. a stale Telegram callback
      // racing in after web already answered) must be swallowed, not throw
      // or double-resolve.
      await expect(
        bridge.respond({ requestId: row.requestId, answer: 'stale', source: 'user' }),
      ).resolves.toBeUndefined();
      expect(resolvedRows).toEqual([row.requestId]); // still exactly one notification
    });
  });

  // G1/D2 — a second concurrent clarify for the same session (no jobId, so
  // the per-session lane applies) used to reject outright with
  // CLARIFY_BUSY. It now queues instead: presented once the first resolves,
  // with its own full timeout window. Sanctioned behaviour change (G1).
  it('queues, rather than rejects, a second concurrent clarify for the same session', async () => {
    const { bridge } = makeBridge();
    const queue = makePresentedQueue(bridge, 'cli');

    const first = bridge.request(baseInput);
    const row1 = await queue.next(); // presenter fires after the pending row registers

    const second = bridge.request(baseInput);
    // Still busy — a lane-scoped listPending shows both (one presented, one queued).
    expect(bridge.hasPending('s1')).toBe(true);

    await bridge.respond({ requestId: row1.requestId, answer: 'done', source: 'user' });
    await expect(first).resolves.toMatchObject({ answer: 'done' });

    // Resolving the first drains the queue — the second is now presented.
    const row2 = await queue.next();
    await bridge.respond({ requestId: row2.requestId, answer: 'done2', source: 'user' });
    await expect(second).resolves.toMatchObject({ answer: 'done2' });
  });

  it('allows a second clarify after the first resolves', async () => {
    const { bridge } = makeBridge();
    bridge.registerPresenter('cli', (req) => {
      void bridge.respond({ requestId: req.requestId, answer: 'a', source: 'user' });
    });
    await bridge.request(baseInput);
    await expect(bridge.request(baseInput)).resolves.toMatchObject({ answer: 'a' });
  });

  describe('timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('resolves with the default on timeout', async () => {
      const { bridge, store } = makeBridge();
      bridge.registerPresenter('cli', () => {});
      const pending = bridge.request({ ...baseInput, default: 'postgres', timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await pending;
      expect(res).toMatchObject({ answer: 'postgres', source: 'timeout-default' });
      expect(await store.list()).toHaveLength(0);
    });

    it('rejects with CLARIFY_TIMED_OUT_NO_DEFAULT when no default was given', async () => {
      const { bridge } = makeBridge();
      bridge.registerPresenter('cli', () => {});
      const pending = bridge.request({ ...baseInput, timeoutMs: 5_000 });
      const assertion = expect(pending).rejects.toBeInstanceOf(ClarifyTimedOutNoDefaultError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    });
  });

  it('resolves as cancelled when the turn abort signal fires', async () => {
    const { bridge } = makeBridge();
    bridge.registerPresenter('cli', () => {});
    const controller = new AbortController();
    const pending = bridge.request({ ...baseInput, abortSignal: controller.signal });
    controller.abort();
    const res = await pending;
    expect(res.source).toBe('cancel');
  });

  it('swallows respond() for an unknown / already-resolved request id', async () => {
    const { bridge } = makeBridge();
    await expect(
      bridge.respond({ requestId: 'never-existed', answer: 'x', source: 'user' }),
    ).resolves.toBeUndefined();
  });

  // Fix 2 (pi-delegation.md §1b) — a respond() with no in-process entry can
  // mean one of two things: the owning process crashed (this IS the final
  // word), or it's alive in a DIFFERENT process sharing this store (its own
  // reconcile poll will pick this up). This bridge cannot tell which, so it
  // no longer deletes the row outright — it marks it answered and lets the
  // real owner (if any) finish the job. It still notifies ITS OWN listeners
  // immediately, which is exactly what the same-process-restart case needs
  // (there is no other process left to do it) and is harmless in the
  // cross-process case (this bridge typically has no listeners for a row
  // belonging to a different surface).
  it('respond() with no in-memory entry marks the row answered (not deleted) and still notifies local listeners', async () => {
    const { bridge, store } = makeBridge();
    const row = makeRow({ requestId: 'orphan', surfaceContext: { chatId: 7 } });
    await store.add(row);
    const notified: Array<{ requestId: string; source: string | null }> = [];
    bridge.onResolved((r, resp) => {
      notified.push({ requestId: r.requestId, source: resp?.source ?? null });
    });

    await bridge.respond({ requestId: 'orphan', answer: 'postgres', source: 'user' });

    // The row survives — a live owner in a DIFFERENT process may still need
    // to read this answer to finish resolution itself (see the
    // cross-process describe block below). It is not silently discarded.
    const persisted = await store.get('orphan');
    expect(persisted?.answer).toEqual({ requestId: 'orphan', answer: 'postgres', source: 'user' });
    expect(notified).toEqual([{ requestId: 'orphan', source: 'user' }]);
  });

  it('a second respond() for an already-answered orphan row is swallowed — first writer wins', async () => {
    const { bridge, store } = makeBridge();
    await store.add(makeRow({ requestId: 'orphan' }));

    await bridge.respond({ requestId: 'orphan', answer: 'first', source: 'user' });
    await bridge.respond({ requestId: 'orphan', answer: 'second', source: 'user' });

    const persisted = await store.get('orphan');
    expect(persisted?.answer?.answer).toBe('first');
  });

  // Fix 2 — the low-priority "genuinely dead owner" edge: nobody's
  // reconcile poll ever picks this row up (the owning process crashed and
  // never restarted). Once the row's OWN deadline passes, sweep() must
  // honor the real answer someone gave rather than silently discarding it
  // for the timeout-default logic.
  it('sweep() honors a recorded answer on an unreconciled row instead of the timeout default', async () => {
    const { bridge, store } = makeBridge();
    await store.add(
      makeRow({
        requestId: 'dead-owner',
        default: 'sqlite',
        defaultDeadlineAt: '2026-05-15T00:00:00.000Z',
        answer: { requestId: 'dead-owner', answer: 'postgres', source: 'user' },
      }),
    );
    const swept: Array<{ requestId: string; answer: string | undefined }> = [];
    bridge.onResolved((row, resp) => {
      swept.push({ requestId: row.requestId, answer: resp?.answer });
    });

    await bridge.sweep(new Date('2026-05-15T01:00:00.000Z'));

    expect(swept).toEqual([{ requestId: 'dead-owner', answer: 'postgres' }]);
    expect(await store.list()).toHaveLength(0);
  });

  // The genuine cross-process scenario Fix 2 exists for: TWO SEPARATE
  // `ClarifyBridge` instances (mirroring two real OS processes — gateway and
  // web-api are always separate processes per pi-delegation.md), sharing
  // only the persisted store. Instance A holds the live `request()` promise
  // (the AgentLoop turn actually blocked on it); instance B answers with no
  // local entry at all, exactly what `apps/web-api/src/rpc/clarify.ts`'s
  // `clarify.respond` RPC does today.
  describe('cross-process answer delivery (Fix 2)', () => {
    it("a job spawned in process A and answered in process B resolves A's request() exactly once", async () => {
      const storage = new InMemoryStorage();
      const root = '/ethos/clarify';
      const storeA = new FileClarifyStore(storage, root); // "gateway"
      const storeB = new FileClarifyStore(storage, root); // "web-api"
      // Short poll so the test doesn't need real-timer sleeps or fake-timer
      // gymnastics around a live setInterval.
      const bridgeA = new ClarifyBridge(storeA, { reconcilePollMs: 10 });
      const bridgeB = new ClarifyBridge(storeB, { reconcilePollMs: 10 });

      const presented: PendingClarify[] = [];
      bridgeA.registerPresenter('telegram', (row) => {
        presented.push(row);
      });

      const pending = bridgeA.request({
        ...baseInput,
        jobId: 'job-1',
        surfaceType: 'telegram',
      });
      await vi.waitFor(() => expect(presented).toHaveLength(1));
      const requestId = presented[0]?.requestId;
      if (!requestId) throw new Error('expected a presented row');

      // "Answered from web" — a completely different process/bridge
      // instance, sharing only the persisted store.
      await bridgeB.respond({
        requestId,
        answer: 'dual-write, then cut over',
        source: 'user',
      });

      // Process A's original request() promise — the one its blocked
      // AgentLoop turn actually awaits — resolves, not times out.
      await expect(pending).resolves.toMatchObject({ answer: 'dual-write, then cut over' });

      // And exactly once — the row is gone from the shared store.
      expect(await storeA.list()).toHaveLength(0);
    });
  });

  // Fix 4 (pi-delegation.md §1b) — boot-time rehydration. Each test
  // constructs a SECOND, fresh `ClarifyBridge` against the SAME persisted
  // store to simulate "the process restarted" — not just calling methods on
  // the same live instance, which would prove nothing about restart
  // survival (the pre-existing T17 sweep test makes exactly this mistake:
  // it runs sweep() against the same bridge that still holds the row in its
  // own in-memory laneQueues).
  describe('boot-time rehydration (Fix 4)', () => {
    it('an already-presented row resumes waiting (no duplicate prompt) and a queued sibling drains once it resolves', async () => {
      const storage = new InMemoryStorage();
      const root = '/ethos/clarify';
      const storeOld = new FileClarifyStore(storage, root);
      const bridgeOld = new ClarifyBridge(storeOld);
      const oldPresented: PendingClarify[] = [];
      bridgeOld.registerPresenter('cli', (row) => {
        oldPresented.push(row);
      });

      // First request presents; second queues behind it in the same lane.
      // Both promises are deliberately abandoned below ("process crashes") —
      // `.catch(() => {})` keeps that an intentional no-op, not an unhandled
      // rejection.
      void bridgeOld.request({ ...baseInput, jobId: 'job-1' }).catch(() => {});
      await vi.waitFor(() => expect(oldPresented).toHaveLength(1));
      void bridgeOld
        .request({ ...baseInput, jobId: 'job-1', question: 'second question' })
        .catch(() => {});
      await vi.waitFor(async () => {
        expect(await storeOld.list()).toHaveLength(2);
      });

      // "Process crashes" — bridgeOld is simply abandoned; its two
      // request() promises are permanently unsettled, exactly what happens
      // when the process dies mid-turn. A fresh bridge, sharing only the
      // persisted store, simulates the restarted process.
      const storeNew = new FileClarifyStore(storage, root);
      const bridgeNew = new ClarifyBridge(storeNew);
      const newPresented: PendingClarify[] = [];
      bridgeNew.registerPresenter('cli', (row) => {
        newPresented.push(row);
      });

      await bridgeNew.hydrate();

      // The already-presented row resumes waiting — it must NOT be re-sent
      // (that would be a duplicate prompt for a question the user already
      // saw once).
      expect(newPresented).toHaveLength(0);
      expect(bridgeNew.hasPending('s1', 'job-1')).toBe(true);

      const rows = await storeNew.list();
      const first = rows.find((r) => r.question === baseInput.question);
      if (!first) throw new Error('expected the first row to survive the restart');

      // Resolving the resumed occupant (as if the user finally replies, or
      // a different process resolves it) drains the queue — the SECOND
      // question, which the crashed process never got to show, is now
      // presented for the first time.
      await bridgeNew.respond({ requestId: first.requestId, answer: 'a', source: 'user' });
      await vi.waitFor(() => expect(newPresented).toHaveLength(1));
      expect(newPresented[0]?.question).toBe('second question');
    });

    it('a queued row with no surviving occupant in its lane is presented for the first time (the Fix 3 crash window)', async () => {
      const storage = new InMemoryStorage();
      const store = new FileClarifyStore(storage, '/ethos/clarify');
      // Simulates presentNow()'s persist-before-present write never landing:
      // the previous occupant is already gone (store.remove landed) but this
      // row's own presentedAt/defaultDeadlineAt never got written before the
      // crash — still legitimately "never shown."
      await store.add(
        makeRow({
          requestId: 'orphan-queued',
          jobId: 'job-2',
          surfaceType: 'cli',
          defaultDeadlineAt: null,
          presentedAt: null,
          timeoutMs: 900_000,
        }),
      );
      const bridge = new ClarifyBridge(store);
      const presented: PendingClarify[] = [];
      bridge.registerPresenter('cli', (row) => {
        presented.push(row);
      });

      await bridge.hydrate();

      // `drainLane` (like `request()`'s own initial present) fires
      // `presentNow` without awaiting it — the durable persist-before-
      // present write (Fix 3) is still in flight when `hydrate()` itself
      // resolves.
      await vi.waitFor(() => expect(presented).toHaveLength(1));
      expect(presented[0]?.requestId).toBe('orphan-queued');
      expect(presented[0]?.presentedAt).not.toBeNull();
    });

    it('only adopts rows whose surfaceType this bridge has a presenter for', async () => {
      const storage = new InMemoryStorage();
      const store = new FileClarifyStore(storage, '/ethos/clarify');
      await store.add(
        makeRow({
          requestId: 'web-row',
          jobId: 'job-3',
          surfaceType: 'web',
          presentedAt: '2026-05-15T00:00:00.000Z',
          // A near-future (real-clock) deadline, not a distant one — Node's
          // `setTimeout` clamps/warns past ~24.8 days (32-bit ms overflow),
          // and armRehydratedTimer computes its delay from real `Date.now()`
          // in these non-fake-timer tests.
          defaultDeadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
      );
      // A gateway-process bridge: no 'web' presenter registered.
      const bridge = new ClarifyBridge(store);
      bridge.registerPresenter('cli', () => {
        throw new Error('must not adopt a row belonging to a different surface');
      });

      await bridge.hydrate();

      expect(bridge.hasPending('s1', 'job-3')).toBe(false);
    });

    it('is idempotent — a second hydrate() call does not re-adopt or duplicate anything', async () => {
      const storage = new InMemoryStorage();
      const store = new FileClarifyStore(storage, '/ethos/clarify');
      await store.add(
        makeRow({
          requestId: 'r1',
          jobId: 'job-4',
          presentedAt: '2026-05-15T00:00:00.000Z',
          // A near-future (real-clock) deadline, not a distant one — Node's
          // `setTimeout` clamps/warns past ~24.8 days (32-bit ms overflow),
          // and armRehydratedTimer computes its delay from real `Date.now()`
          // in these non-fake-timer tests.
          defaultDeadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
      );
      const bridge = new ClarifyBridge(store);
      const presented: PendingClarify[] = [];
      bridge.registerPresenter('cli', (row) => {
        presented.push(row);
      });

      await bridge.hydrate();
      await bridge.hydrate();

      expect(presented).toHaveLength(0); // an occupant row is never re-shown
      expect(bridge.listPending(undefined, 'job-4')).toHaveLength(1);
    });

    // The resume path (`apps/ethos/src/boot-reconciliation.ts`): a second
    // `hydrate()` must pick up rows persisted since the first one. This is
    // what a `hydrated` latch made impossible — the latch turned every call
    // after the first into a permanent no-op that still reported success.
    it('a second hydrate() adopts a row persisted after the first call (resume)', async () => {
      const storage = new InMemoryStorage();
      const store = new FileClarifyStore(storage, '/ethos/clarify');
      await store.add(
        makeRow({
          requestId: 'first',
          jobId: 'job-resume-a',
          presentedAt: '2026-05-15T00:00:00.000Z',
          defaultDeadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }),
      );
      const bridge = new ClarifyBridge(store);
      const presented: PendingClarify[] = [];
      bridge.registerPresenter('cli', (row) => {
        presented.push(row);
      });

      await bridge.hydrate();
      expect(bridge.hasPending('s1', 'job-resume-a')).toBe(true);

      // A row that landed in the shared store AFTER the first hydrate — e.g.
      // written by another process while this one was paused.
      await store.add(
        makeRow({
          requestId: 'later',
          jobId: 'job-resume-b',
          presentedAt: null,
          defaultDeadlineAt: null,
          timeoutMs: 900_000,
        }),
      );

      await bridge.hydrate();

      expect(bridge.hasPending('s1', 'job-resume-b')).toBe(true);
      await vi.waitFor(() => expect(presented).toHaveLength(1));
      expect(presented[0]?.requestId).toBe('later');
      // ...and the row adopted by the first call was not adopted twice.
      expect(bridge.listPending(undefined, 'job-resume-a')).toHaveLength(1);
    });

    // A failed first hydrate must not poison every later one. The latch was
    // set BEFORE the first await, so a throwing `store.list()` left the
    // bridge permanently "hydrated" having adopted nothing.
    it('a first hydrate() that throws does not prevent a later successful one', async () => {
      const storage = new InMemoryStorage();
      const store = new FileClarifyStore(storage, '/ethos/clarify');
      await store.add(
        makeRow({
          requestId: 'r-retry',
          jobId: 'job-retry',
          presentedAt: null,
          defaultDeadlineAt: null,
          timeoutMs: 900_000,
        }),
      );
      let failNextList = true;
      const flaky: ClarifyStore = {
        list: async (filter) => {
          if (failNextList) {
            failNextList = false;
            throw new Error('store unavailable');
          }
          return store.list(filter);
        },
        add: (row) => store.add(row),
        get: (id) => store.get(id),
        remove: (id) => store.remove(id),
        update: (id, patch) => store.update(id, patch),
        expired: (now) => store.expired(now),
      };
      const bridge = new ClarifyBridge(flaky);
      const presented: PendingClarify[] = [];
      bridge.registerPresenter('cli', (row) => {
        presented.push(row);
      });

      await expect(bridge.hydrate()).rejects.toThrow('store unavailable');
      expect(bridge.hasPending('s1', 'job-retry')).toBe(false);

      await bridge.hydrate();

      expect(bridge.hasPending('s1', 'job-retry')).toBe(true);
      await vi.waitFor(() => expect(presented).toHaveLength(1));
      expect(presented[0]?.requestId).toBe('r-retry');
    });
  });

  it('sweep() notifies resolved listeners for swept persisted rows', async () => {
    const { bridge, store } = makeBridge();
    // Two rows: one expired, one fresh — only the expired one should fire.
    await store.add(
      makeRow({
        requestId: 'expired',
        defaultDeadlineAt: '2026-05-15T00:00:00.000Z',
      }),
    );
    await store.add(
      makeRow({
        requestId: 'fresh',
        defaultDeadlineAt: '2026-05-15T02:00:00.000Z',
      }),
    );
    const swept: string[] = [];
    bridge.onResolved((row) => {
      swept.push(row.requestId);
    });

    await bridge.sweep(new Date('2026-05-15T01:00:00.000Z'));

    expect(swept).toEqual(['expired']);
    expect(await store.list()).toHaveLength(1);
  });

  it('listPersisted() proxies to the underlying store', async () => {
    const { bridge, store } = makeBridge();
    await store.add(makeRow({ requestId: 'a', surfaceType: 'telegram' }));
    await store.add(makeRow({ requestId: 'b', surfaceType: 'cli' }));
    const tg = await bridge.listPersisted({ surfaceType: 'telegram' });
    expect(tg.map((r) => r.requestId)).toEqual(['a']);
  });
});

// I20 (Phase 5) — cancelling a run withdraws whatever it is parked on. Closes
// the gap Phase 4 recorded: abort used to leave the question live on someone's
// phone for its whole window, with nothing to un-pause the heartbeat.
describe('ClarifyBridge.cancelJob', () => {
  function makeBridge() {
    const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    return { bridge: new ClarifyBridge(store), store };
  }

  const input = {
    question: 'Which migration path?',
    timeoutMs: 900_000,
    answerableBy: 'anyone' as const,
    sessionId: 's1',
    surfaceType: 'cli' as const,
  };

  it("cancels the job's presented question AND everything queued behind it, leaving other jobs alone", async () => {
    const { bridge, store } = makeBridge();
    const presented = makePresentedQueue(bridge, 'cli');

    const first = bridge.request({ ...input, jobId: 'job-1' });
    await presented.next();
    const queued = bridge.request({ ...input, jobId: 'job-1', question: 'And the rollback?' });
    const other = bridge.request({ ...input, jobId: 'job-2' });
    await presented.next(); // job-2 has its own lane, so it presents immediately

    expect(await bridge.cancelJob('job-1')).toBe(2);

    await expect(first).resolves.toMatchObject({ answer: '', source: 'cancel' });
    await expect(queued).resolves.toMatchObject({ answer: '', source: 'cancel' });
    // The queued row was withdrawn, never shown — freeing the lane must not
    // present a question this call is in the middle of cancelling.
    expect(presented.all).toHaveLength(0);

    // Only the untouched job's row is left, in memory and on disk.
    expect(bridge.listPending().map((r) => r.jobId)).toEqual(['job-2']);
    expect((await store.list()).map((r) => r.jobId)).toEqual(['job-2']);

    await bridge.cancelJob('job-2');
    await expect(other).resolves.toMatchObject({ source: 'cancel' });
  });

  it('is a no-op for a job with nothing pending', async () => {
    const { bridge } = makeBridge();
    expect(await bridge.cancelJob('job-nothing')).toBe(0);
  });
});
