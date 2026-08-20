import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pruneObservabilityByPath,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import type { Span, Trace } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangfusePollLoop } from '../poller';

function tmpDb(): string {
  return join(tmpdir(), `export-langfuse-test-${randomUUID()}.db`);
}

function closedTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    traceId: randomUUID(),
    sessionId: 'sess-1',
    kind: 'turn',
    startTs: Date.now(),
    endTs: Date.now() + 500,
    status: 'ok',
    subjectId: 'assistant',
    attrs: { platform: 'telegram' },
    ...overrides,
  };
}

function llmSpan(traceId: string, overrides: Partial<Span> = {}): Span {
  return {
    spanId: randomUUID(),
    traceId,
    kind: 'llm_call',
    name: 'claude-sonnet-5',
    startTs: Date.now(),
    endTs: Date.now() + 100,
    status: 'ok',
    attrs: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A real HTTP server standing in for Langfuse. Repo convention (see
// extensions/team-supervisor/src/__tests__/health.test.ts) — no mock library.
// ---------------------------------------------------------------------------

describe('LangfusePollLoop', () => {
  let dbPath: string;
  let store: SQLiteObservabilityStore;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new SQLiteObservabilityStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  describe('against a working endpoint', () => {
    let server: Server;
    let port: number;
    let receivedBodies: Array<{ batch: Array<{ type: string; body: Record<string, unknown> }> }>;

    beforeEach(
      () =>
        new Promise<void>((resolve) => {
          receivedBodies = [];
          server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
              receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              res.writeHead(207, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ successes: [], errors: [] }));
            });
          });
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            port = typeof addr === 'object' && addr !== null ? addr.port : 0;
            resolve();
          });
        }),
    );

    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    function makeLoop(overrides: Partial<ConstructorParameters<typeof LangfusePollLoop>[0]> = {}) {
      return new LangfusePollLoop({
        store,
        baseUrl: `http://127.0.0.1:${port}`,
        publicKey: 'pk',
        secretKey: 'sk',
        batchSize: 50,
        staleClaimCutoffMs: 120_000,
        ...overrides,
      });
    }

    it('exports a fixture turn and matches the mapped payload', async () => {
      const trace = closedTrace();
      store.insertTrace(trace);
      store.insertSpan(llmSpan(trace.traceId));

      const result = await makeLoop().tick();

      expect(result).toEqual({ exported: 1, failed: 0, skipped: 0 });
      expect(receivedBodies).toHaveLength(1);
      const types = receivedBodies[0].batch.map((e) => e.type);
      expect(types).toEqual(['trace-create', 'generation-create']);
      expect(receivedBodies[0].batch[0].body.id).toBe(trace.traceId);
    });

    it('never re-exports an already-exported trace', async () => {
      const trace = closedTrace();
      store.insertTrace(trace);
      store.insertSpan(llmSpan(trace.traceId));

      await makeLoop().tick();
      expect(receivedBodies).toHaveLength(1);

      // exported_at is now set — a second tick's claim query must exclude it
      // by construction, not by re-POSTing and relying on Langfuse's upsert.
      const second = await makeLoop().tick();
      expect(second).toEqual({ exported: 0, failed: 0, skipped: 0 });
      expect(receivedBodies).toHaveLength(1);
    });

    it('exports a trace that completes after other traces were already exported', async () => {
      const early = closedTrace({ startTs: Date.now() - 10_000 });
      store.insertTrace(early);
      store.insertSpan(llmSpan(early.traceId));

      // Starts earlier than `early` but is not closed yet (status null) — not
      // claimable until it completes.
      const lateCompleting: Trace = {
        traceId: randomUUID(),
        sessionId: 'sess-1',
        kind: 'turn',
        startTs: Date.now() - 20_000,
        subjectId: 'assistant',
        attrs: { platform: 'telegram' },
      };
      store.insertTrace(lateCompleting);
      store.insertSpan(llmSpan(lateCompleting.traceId));

      const first = await makeLoop().tick();
      expect(first).toEqual({ exported: 1, failed: 0, skipped: 0 });

      // Now it completes.
      store.closeTrace(lateCompleting.traceId, 'ok');
      const second = await makeLoop().tick();
      expect(second).toEqual({ exported: 1, failed: 0, skipped: 0 });
      expect(receivedBodies).toHaveLength(2);
      expect(receivedBodies[1].batch[0].body.id).toBe(lateCompleting.traceId);
    });

    it('skips and counts a trace whose spans were pruned before export, without throwing', async () => {
      const trace = closedTrace();
      store.insertTrace(trace);
      // Old enough to fall outside a 90d span retention window; the trace
      // itself is kept ('forever') so only its spans are pruned out from
      // under the poller — a real prune race, not a fabricated empty trace.
      store.insertSpan(llmSpan(trace.traceId, { startTs: Date.now() - 91 * 86_400_000 }));

      pruneObservabilityByPath(dbPath, { traces: 'forever', spans: '90d' });
      expect(store.getSpans(trace.traceId)).toHaveLength(0);

      const result = await makeLoop().tick();
      expect(result).toEqual({ exported: 0, failed: 0, skipped: 1 });
      expect(receivedBodies).toHaveLength(0); // nothing to ship, no POST made
      const events = store.getEvents({ traceId: trace.traceId });
      expect(events.some((e) => e.category === 'export.langfuse_skipped_pruned')).toBe(true);

      // Stamped exported — never retried again.
      const again = await makeLoop().tick();
      expect(again).toEqual({ exported: 0, failed: 0, skipped: 0 });
    });

    it("a crashed poller's claim is reclaimed once it goes stale", async () => {
      const trace = closedTrace();
      store.insertTrace(trace);
      store.insertSpan(llmSpan(trace.traceId));

      // Simulate a poller that claimed and then died before exporting.
      const claimed = store.claimUnexportedTraces(10, 120_000);
      expect(claimed).toHaveLength(1);

      // Immediately after, nothing is claimable (claim is fresh).
      expect(store.claimUnexportedTraces(10, 120_000)).toHaveLength(0);

      // Let real wall-clock time move past the claim timestamp, then use a
      // cutoff of 0 so that claim now reads as stale — a fresh poller tick
      // reclaims and successfully exports it.
      await new Promise((r) => setTimeout(r, 5));
      const result = await makeLoop({ staleClaimCutoffMs: 0 }).tick();
      expect(result).toEqual({ exported: 1, failed: 0, skipped: 0 });
    });

    it('two stores on the same file never claim the same trace', () => {
      const traces = Array.from({ length: 5 }, () => closedTrace());
      for (const t of traces) store.insertTrace(t);

      const store2 = new SQLiteObservabilityStore(dbPath);
      try {
        const claimed1 = store.claimUnexportedTraces(3, 120_000);
        const claimed2 = store2.claimUnexportedTraces(3, 120_000);

        expect(claimed1).toHaveLength(3);
        expect(claimed2).toHaveLength(2);
        const ids1 = new Set(claimed1.map((c) => c.trace.traceId));
        const ids2 = new Set(claimed2.map((c) => c.trace.traceId));
        for (const id of ids2) expect(ids1.has(id)).toBe(false);
      } finally {
        store2.close();
      }
    });
  });

  describe('against a dead endpoint', () => {
    it('fails open: releases the claim and does not throw', async () => {
      const trace = closedTrace();
      store.insertTrace(trace);
      store.insertSpan(llmSpan(trace.traceId));

      const loop = new LangfusePollLoop({
        store,
        baseUrl: 'http://127.0.0.1:1', // port 1 — nothing listens there
        publicKey: 'pk',
        secretKey: 'sk',
      });

      const result = await loop.tick();
      expect(result).toEqual({ exported: 0, failed: 1, skipped: 0 });

      // Claim was released — the trace is claimable again next tick.
      expect(store.claimUnexportedTraces(10, 120_000)).toHaveLength(1);

      const events = store.getEvents({ traceId: trace.traceId });
      expect(events.some((e) => e.category === 'export.langfuse_failed')).toBe(true);
    });
  });

  describe('against an endpoint that reports a 207 with per-event errors', () => {
    let server: Server;
    let port: number;

    beforeEach(
      () =>
        new Promise<void>((resolve) => {
          server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
              // A partial-failure 207: some events in the batch were
              // rejected. `Response.ok` alone would treat this as success.
              res.writeHead(207, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  successes: [],
                  errors: [{ id: 'whatever', status: 400, message: 'invalid' }],
                }),
              );
            });
          });
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            port = typeof addr === 'object' && addr !== null ? addr.port : 0;
            resolve();
          });
        }),
    );

    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('treats a non-empty errors array as failure: claim released, not marked exported', async () => {
      const trace = closedTrace();
      store.insertTrace(trace);
      store.insertSpan(llmSpan(trace.traceId));

      const loop = new LangfusePollLoop({
        store,
        baseUrl: `http://127.0.0.1:${port}`,
        publicKey: 'pk',
        secretKey: 'sk',
      });

      const result = await loop.tick();
      expect(result).toEqual({ exported: 0, failed: 1, skipped: 0 });

      // Claim was released — the trace is claimable again next tick, not
      // stuck as permanently exported.
      expect(store.claimUnexportedTraces(10, 120_000)).toHaveLength(1);

      const events = store.getEvents({ traceId: trace.traceId });
      expect(events.some((e) => e.category === 'export.langfuse_failed')).toBe(true);
    });
  });
});
