import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifySurfaceType, PendingClarify } from '@ethosagent/types';
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

  // Restart-survival: after a gateway crash the original `request()` promise is
  // gone, but a persisted row may remain and the UI is still showing buttons.
  // A late respond() (button tap after restart) must still clean the row up
  // and notify listeners so the surface can edit the message in place.
  it('respond() cleans up a persisted row + notifies listeners when no in-memory entry exists', async () => {
    const { bridge, store } = makeBridge();
    const row = makeRow({ requestId: 'orphan', surfaceContext: { chatId: 7 } });
    await store.add(row);
    const notified: Array<{ requestId: string; source: string | null }> = [];
    bridge.onResolved((r, resp) => {
      notified.push({ requestId: r.requestId, source: resp?.source ?? null });
    });

    await bridge.respond({ requestId: 'orphan', answer: 'postgres', source: 'user' });

    expect(await store.list()).toHaveLength(0);
    expect(notified).toEqual([{ requestId: 'orphan', source: 'user' }]);
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
