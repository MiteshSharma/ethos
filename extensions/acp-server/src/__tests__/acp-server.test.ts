import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { AgentEvent } from '@ethosagent/core';
import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  SessionUsage,
  StoredMessage,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcpServer, type AgentRunner } from '../index';

// ---------------------------------------------------------------------------
// In-memory SessionStore — no native deps, tests AcpServer logic only
// ---------------------------------------------------------------------------

function makeStore(): SessionStore {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, StoredMessage[]>();

  return {
    async createSession(data) {
      const s: Session = {
        ...data,
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.set(s.id, s);
      return s;
    },
    async getSession(id) {
      return sessions.get(id) ?? null;
    },
    async getSessionByKey(key) {
      for (const s of sessions.values()) if (s.key === key) return s;
      return null;
    },
    async updateSession(id, patch) {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, ...patch, updatedAt: new Date() });
    },
    async deleteSession(id) {
      sessions.delete(id);
      messages.delete(id);
    },
    async listSessions(_filter?: SessionFilter) {
      return [...sessions.values()];
    },
    async appendMessage(msg) {
      const stored: StoredMessage = { ...msg, id: randomUUID(), timestamp: new Date() };
      const list = messages.get(msg.sessionId) ?? [];
      list.push(stored);
      messages.set(msg.sessionId, list);
      return stored;
    },
    async getMessages(sessionId, opts) {
      const list = messages.get(sessionId) ?? [];
      if (opts?.limit !== undefined) return list.slice(-opts.limit);
      return list;
    },
    async updateUsage(_id, _delta) {},
    async search(_query, _opts): Promise<SearchResult[]> {
      return [];
    },
    async pruneOldSessions(_olderThan) {
      return 0;
    },
    async vacuum() {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunner(events: AgentEvent[] = []): AgentRunner {
  return {
    run: async function* () {
      for (const event of events) yield event as { type: string } & Record<string, unknown>;
    },
  };
}

function makeServer(runner: AgentRunner, store: SessionStore) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new AcpServer({ runner, session: store, input, output });
  server.start();
  return { input, output };
}

function send(input: PassThrough, req: object) {
  input.write(`${JSON.stringify(req)}\n`);
}

function readLines(output: PassThrough, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const results: unknown[] = [];
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} lines`)), 2000);
    output.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        results.push(JSON.parse(line));
        if (results.length >= count) {
          clearTimeout(timer);
          resolve(results);
        }
      }
    });
  });
}

const BASE_SESSION: Omit<Session, 'id' | 'createdAt' | 'updatedAt' | 'key'> = {
  platform: 'acp',
  model: 'claude-opus-4-7',
  provider: 'anthropic',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  } satisfies SessionUsage,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpServer', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = makeStore();
  });

  // 1
  it('initialize returns protocolVersion and capabilities', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1.0' },
    });
    const [resp] = await lines;
    expect(resp).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '1.0', serverName: 'ethos', capabilities: { streaming: true } },
    });
  });

  // 2
  it('new_session returns a unique acp: sessionKey each call', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 2);
    send(input, { jsonrpc: '2.0', id: 1, method: 'new_session', params: {} });
    send(input, { jsonrpc: '2.0', id: 2, method: 'new_session', params: {} });
    const [r1, r2] = await lines;
    const key1 = (r1 as { result: { sessionKey: string } }).result.sessionKey;
    const key2 = (r2 as { result: { sessionKey: string } }).result.sessionKey;
    expect(key1).toMatch(/^acp:/);
    expect(key2).toMatch(/^acp:/);
    expect(key1).not.toBe(key2);
  });

  // 3
  it('new_session passes personalityId through', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'new_session',
      params: { personalityId: 'engineer' },
    });
    const [resp] = await lines;
    expect(resp).toMatchObject({ result: { personalityId: 'engineer' } });
  });

  // 4
  it('prompt sends $/stream notification for each AgentEvent', async () => {
    const runner = makeRunner([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'done', text: 'Hello world', turnCount: 1 },
    ]);
    const { input, output } = makeServer(runner, store);
    const lines = readLines(output, 3); // 2 stream notifications + 1 final result
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompt',
      params: { sessionKey: 'sk1', text: 'hi' },
    });
    const msgs = await lines;
    const streams = msgs.filter((m) => (m as { method?: string }).method === '$/stream');
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({
      params: { requestId: 1, event: { type: 'text_delta', text: 'Hello' } },
    });
  });

  // 5
  it('prompt sends final result with accumulated text and turnCount', async () => {
    const runner = makeRunner([
      { type: 'text_delta', text: 'Hi' },
      { type: 'done', text: 'Hi', turnCount: 2 },
    ]);
    const { input, output } = makeServer(runner, store);
    const lines = readLines(output, 2); // 1 stream + 1 result
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompt',
      params: { sessionKey: 'sk1', text: 'hello' },
    });
    const msgs = await lines;
    const result = msgs.find((m) => (m as { id?: number }).id === 1);
    expect(result).toMatchObject({ id: 1, result: { text: 'Hi', turnCount: 2 } });
  });

  // 6
  it('cancel fires AbortSignal for in-flight prompt', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner: AgentRunner = {
      run: async function* (_text, opts) {
        capturedSignal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          opts?.abortSignal?.addEventListener('abort', () => resolve());
        });
        // returns without yielding — runner respects abort
      },
    };
    const { input, output } = makeServer(runner, store);
    // cancel response (id:2) + prompt final result (id:1, empty text)
    const lines = readLines(output, 2);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompt',
      params: { sessionKey: 'sk1', text: 'hi' },
    });
    send(input, { jsonrpc: '2.0', id: 2, method: 'cancel', params: { requestId: 1 } });
    const msgs = await lines;
    const cancelResp = msgs.find((m) => (m as { id?: number }).id === 2);
    expect(cancelResp).toMatchObject({ id: 2, result: { ok: true } });
    expect(capturedSignal?.aborted).toBe(true);
  });

  // 7
  it('cancel with unknown requestId returns ok:true without error', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, { jsonrpc: '2.0', id: 1, method: 'cancel', params: { requestId: 999 } });
    const [resp] = await lines;
    expect(resp).toMatchObject({ id: 1, result: { ok: true } });
  });

  // 8
  it('concurrent prompt on same session returns -32000', async () => {
    // runner that holds open until abort so first prompt stays in-flight
    const runner: AgentRunner = {
      run: async function* (_text, opts) {
        await new Promise<void>((resolve) => {
          opts?.abortSignal?.addEventListener('abort', () => resolve());
          setTimeout(resolve, 500); // safety valve
        });
      },
    };
    const { input, output } = makeServer(runner, store);
    // write both in one call so readline sees them in the same tick
    const req1 = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'prompt',
      params: { sessionKey: 'sk1', text: 'a' },
    });
    const req2 = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompt',
      params: { sessionKey: 'sk1', text: 'b' },
    });
    const lines = readLines(output, 2); // error for id:2 + final result for id:1
    input.write(`${req1}\n${req2}\n`);
    const msgs = await lines;
    const err = msgs.find((m) => (m as { id?: number }).id === 2);
    expect(err).toMatchObject({ id: 2, error: { code: -32000 } });
  });

  // 9
  it('fork_session creates new session with copied message history', async () => {
    const src = await store.createSession({ ...BASE_SESSION, key: 'source' });
    await store.appendMessage({ sessionId: src.id, role: 'user', content: 'hello' });
    await store.appendMessage({ sessionId: src.id, role: 'assistant', content: 'world' });

    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'fork_session',
      params: { sessionKey: 'source' },
    });
    const [resp] = await lines;

    const newKey = (resp as { result: { sessionKey: string } }).result.sessionKey;
    expect(newKey).toMatch(/^acp:fork:/);

    const forked = await store.getSessionByKey(newKey);
    expect(forked).not.toBeNull();
    const msgs = await store.getMessages(forked!.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('hello');
    expect(msgs[1].content).toBe('world');
  });

  // 10
  it('fork_session with unknown sessionKey returns -32000', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'fork_session',
      params: { sessionKey: 'does-not-exist' },
    });
    const [resp] = await lines;
    expect(resp).toMatchObject({ id: 1, error: { code: -32000 } });
  });

  // 11
  it('resume_session returns exists:true and messageCount for a known session', async () => {
    const s = await store.createSession({ ...BASE_SESSION, key: 'resume-me' });
    await store.appendMessage({ sessionId: s.id, role: 'user', content: 'one' });
    await store.appendMessage({ sessionId: s.id, role: 'assistant', content: 'two' });
    await store.appendMessage({ sessionId: s.id, role: 'user', content: 'three' });

    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resume_session',
      params: { sessionKey: 'resume-me' },
    });
    const [resp] = await lines;
    expect(resp).toMatchObject({ id: 1, result: { exists: true, messageCount: 3 } });
  });

  // 12
  it('resume_session returns exists:false for unknown session', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resume_session',
      params: { sessionKey: 'ghost' },
    });
    const [resp] = await lines;
    expect(resp).toMatchObject({ id: 1, result: { exists: false, messageCount: 0 } });
  });

  // 13
  it('unknown method returns -32601', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    send(input, { jsonrpc: '2.0', id: 1, method: 'nope', params: {} });
    const [resp] = await lines;
    expect(resp).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  // bonus — malformed JSON
  it('malformed JSON returns -32700 parse error', async () => {
    const { input, output } = makeServer(makeRunner(), store);
    const lines = readLines(output, 1);
    input.write('not-valid-json\n');
    const [resp] = await lines;
    expect(resp).toMatchObject({ error: { code: -32700 } });
  });
});
