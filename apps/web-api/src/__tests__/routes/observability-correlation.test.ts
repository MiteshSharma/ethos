// D21 (analytics-observability plan) — "the first verification item of Phase
// 2, not dropped": the full correlation chain, proven together instead of
// only in isolated unit tests:
//
//   1. `POST /rpc/chat/send` returns `x-request-id` (B1); the JSON body's
//      `turnId` is that same value (B3's documented `turnId = x-request-id`
//      deviation — the loop's own `traceId` has not been minted yet when
//      `send` returns, see chat/service.ts).
//   2. The SSE stream's `run_start` carries the turn's `traceId` (B3).
//   3. That `traceId` is a real row in `observability.db` (looked up through
//      a genuine `SQLiteObservabilityStore`, not a fake).
//   4. Its `llm_call` span carries the provider's own `providerRequestId`
//      (B2) — the id an operator quotes in a support ticket — even though
//      the turn ended in a provider ERROR mid-stream.
//
// The LLM connection itself is scripted (an outbound network call is out of
// scope for this suite), but everything downstream of it — AgentLoop's error
// handling, the observability writer, the SQLite store, and the web-api HTTP
// layer — is the real production code, not a stand-in.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '@ethosagent/core';
import {
  BlobStore,
  ObservabilityService,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentSafety, CompletionChunk, LLMProvider } from '@ethosagent/types';
import { EthosObservability } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { makeStubMemoryProvider, makeStubPersonalityRegistry } from '../test-helpers';

const PROVIDER_REQUEST_ID = 'req_011CQoD21correlation';

/** Reports a provider-assigned request id, then fails mid-stream — the exact
 *  shape a real provider outage takes (B2's error-span path). */
function erroringLLM(): LLMProvider {
  return {
    name: 'mock-erroring',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
        },
        providerRequestId: PROVIDER_REQUEST_ID,
      };
      throw new Error('simulated provider failure mid-stream');
    },
    async countTokens() {
      return 10;
    },
  };
}

/** Minimal pass-through `AgentSafety` — this suite exercises correlation
 *  wiring, not injection/redaction behavior. */
function noopSafety(): AgentSafety {
  return {
    injection: {
      prelude: '',
      downgradeRejectionMessage: 'downgraded',
      sanitize: (c) => c,
      wrapUntrusted: ({ content }) => ({ content, strippedTokens: 0 }),
      shortPatternCheck: () => ({ containsInstructions: false, hits: [] }),
      c2PatternCheck: () => ({ containsInstructions: false }),
      resolveDowngradedTools: () => new Set(),
    },
    redaction: {
      redactPii: (t) => t,
      redactString: (t) => t,
      detectSecrets: () => [],
    },
    scopedStorageFactory: (base) => base,
    approvalPosture: { kind: 'ungated', reason: 'D21 correlation test' },
  };
}

describe('D21 — x-request-id -> traceId -> observability.db -> providerRequestId', () => {
  let dir: string;
  let sessionStore: SQLiteSessionStore;
  let obsStore: SQLiteObservabilityStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-d21-'));
    sessionStore = new SQLiteSessionStore(':memory:');
    obsStore = new SQLiteObservabilityStore(join(dir, 'observability.db'));
    const blobStore = new BlobStore(join(dir, 'blobs'), new InMemoryStorage());
    const ethosObs = new EthosObservability(new ObservabilityService(obsStore, blobStore));

    const loop = new AgentLoop({
      llm: erroringLLM(),
      safety: noopSafety(),
      session: sessionStore,
      observability: ethosObs,
    });

    const created = createWebApi({
      dataDir: dir,
      sessionStore,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: loop,
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });
    app = created.app;

    const tokens = new WebTokenRepository({ dataDir: dir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterEach(async () => {
    sessionStore.close();
    obsStore.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('walks the full chain end to end', async () => {
    const res = await app.request('/rpc/chat/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: { clientId: 'tab-1', text: 'trigger a provider error' } }),
    });
    expect(res.status).toBe(200);

    // Step 1 — x-request-id on the HTTP response (B1); `turnId` is that same
    // value (B3's documented deviation).
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    const body = (await res.json()) as { json: { sessionId: string; turnId: string } };
    expect(body.json.turnId).toBe(requestId);

    // Step 2 — SSE run_start carries the turn's traceId.
    const sse = await app.request(`/sse/sessions/${body.json.sessionId}`, {
      headers: { cookie },
    });
    expect(sse.status).toBe(200);
    const frames = await readSseUntilRunStart(sse, 2000);
    const runStart = frames.find((f) => f.event.type === 'run_start');
    if (!runStart) throw new Error('no run_start frame');
    const traceId = (runStart.event as { traceId?: string }).traceId;
    expect(traceId).toBeTruthy();
    if (!traceId) throw new Error('no traceId on run_start');

    // The fatal LLM error persists the span/trace close asynchronously —
    // give the bridge a moment to drain before reading observability.db.
    await sleep(100);

    // Step 3 — the trace is a REAL row, closed with status 'error'.
    const trace = obsStore.getTrace(traceId);
    expect(trace).not.toBeNull();
    expect(trace?.status).toBe('error');

    // Step 4 — the llm_call span carries the provider's own request id, even
    // though the call ended in error.
    const spans = obsStore.getSpans(traceId);
    const llmSpan = spans.find((s) => s.kind === 'llm_call');
    expect(llmSpan).toBeTruthy();
    expect(llmSpan?.status).toBe('error');
    expect(llmSpan?.attrs?.providerRequestId).toBe(PROVIDER_REQUEST_ID);
  });
});

interface ParsedSseFrame {
  seq: number;
  event: { type: string; [k: string]: unknown };
}

async function readSseUntilRunStart(
  response: Response,
  timeoutMs: number,
): Promise<ParsedSseFrame[]> {
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out: ParsedSseFrame[] = [];
  const start = Date.now();

  try {
    while (Date.now() - start < timeoutMs) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: Uint8Array | undefined; done: boolean }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: false }), 50),
        ),
      ]);
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });

      while (true) {
        const split = buf.indexOf('\n\n');
        if (split === -1) break;
        const frame = buf.slice(0, split);
        buf = buf.slice(split + 2);
        const parsed = parseFrame(frame);
        if (parsed) {
          out.push(parsed);
          if (parsed.event.type === 'run_start') return out;
        }
      }
    }
  } finally {
    reader.releaseLock();
    void response.body.cancel().catch(() => {});
  }
  return out;
}

function parseFrame(frame: string): ParsedSseFrame | null {
  let id = 0;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return { seq: id, event: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
