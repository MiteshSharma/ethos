import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { makeStubAgentLoop, makeStubPersonalityRegistry } from '../test-helpers';

// End-to-end SSE test: chat.send kicks off a turn, /sse/sessions/:id replays
// buffered events. We don't need a real network — Hono's `app.request(...)`
// returns a Response whose `body` is a ReadableStream we can read frame by
// frame.

describe('SSE — chat.send → /sse/sessions/:id', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>;
  let cookie: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-sse-'));
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      // Slow-ish stub so the SSE consumer reliably catches events live AND
      // exercises the replay path on reconnect.
      agentLoop: makeStubAgentLoop({
        events: [
          { type: 'text_delta', text: 'pong' },
          { type: 'usage', inputTokens: 5, outputTokens: 1, estimatedCostUsd: 0 },
          { type: 'done', text: 'pong', turnCount: 1 },
        ],
      }),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });

    const tokens = new WebTokenRepository({ dataDir: dir });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function chatSend(text: string): Promise<{ sessionId: string; turnId: string }> {
    const res = await app.request('/rpc/chat/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: { clientId: 'tab-1', text } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { sessionId: string; turnId: string } };
    return body.json;
  }

  it('chat.send returns immediately with sessionId; SSE then replays the turn', async () => {
    const { sessionId } = await chatSend('hi');

    // Pause briefly so the bridge has time to drain and append events to
    // the buffer. (Bridge runs async — chat.send doesn't await it.)
    await sleep(50);

    const sse = await app.request(`/sse/sessions/${sessionId}`, {
      headers: { cookie },
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/i);

    // Read enough of the stream to capture the buffered turn, then bail.
    // The reader is closed implicitly when we let it go out of scope.
    const events = await readSseUntilDone(sse, 1000);

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.event.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.event.type === 'done')).toBe(true);

    // seq is monotonic and 1-indexed
    expect(events[0]?.seq).toBe(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.seq).toBeGreaterThan(events[i - 1]?.seq ?? 0);
    }
  });

  it('Last-Event-ID resume skips events at or before the given seq', async () => {
    const { sessionId } = await chatSend('hi');
    await sleep(50);

    // First connection — capture all events to learn the head seq
    const initial = await app.request(`/sse/sessions/${sessionId}`, { headers: { cookie } });
    const allEvents = await readSseUntilDone(initial, 1000);
    expect(allEvents.length).toBeGreaterThanOrEqual(2);

    // Reconnect with Last-Event-ID = seq of the FIRST event. Replay should
    // start from the second event onward.
    const firstSeq = allEvents[0]?.seq ?? 0;
    const reconnect = await app.request(`/sse/sessions/${sessionId}`, {
      headers: { cookie, 'last-event-id': String(firstSeq) },
    });
    const replayEvents = await readSseUntilDone(reconnect, 1000);

    expect(replayEvents.length).toBe(allEvents.length - 1);
    expect(replayEvents[0]?.seq).toBe(firstSeq + 1);
  });

  it('SSE requires the auth cookie', async () => {
    const { sessionId } = await chatSend('hi');
    const res = await app.request(`/sse/sessions/${sessionId}`);
    expect(res.status).toBe(401);
  });
});

interface ParsedSseFrame {
  seq: number;
  event: { type: string; [k: string]: unknown };
}

async function readSseUntilDone(response: Response, timeoutMs: number): Promise<ParsedSseFrame[]> {
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

      // Frame separator is a blank line. Parse complete frames.
      let split: number;
      while ((split = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, split);
        buf = buf.slice(split + 2);
        const parsed = parseFrame(frame);
        if (parsed) {
          out.push(parsed);
          if (parsed.event.type === 'done') return out;
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
