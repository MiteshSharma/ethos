import { randomUUID } from 'node:crypto';
import type { PendingNotifyQueue, WritePendingNotifyInput } from '@ethosagent/notify-queue';
import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AcpServer, type AgentRunner } from '../index';

// ---------------------------------------------------------------------------
// In-memory SessionStore (same as auth.test.ts)
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
    async recordCompression(event) {
      return { ...event, id: randomUUID(), createdAt: new Date() };
    },
    async listCompressions(_sessionId) {
      return [];
    },
    async recordTurnStart(_sessionId) {
      return { turnNumber: 0, lastCompactionTurn: 0 };
    },
    async recordCompactionTurn(_sessionId, _turnNumber) {},
    async pruneOldSessions(_olderThan) {
      return 0;
    },
    async undoTurns() {
      return 0;
    },
    async vacuum() {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunner(): AgentRunner {
  return {
    run: async function* () {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', text: 'ok', turnCount: 1 };
    },
  };
}

/** A runner that counts how many times `run()` was invoked — lets a test
 *  assert a `notify`-mode delivery never forces a turn. */
function makeCountingRunner(): { runner: AgentRunner; callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    runner: {
      run: async function* () {
        calls++;
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', text: 'ok', turnCount: 1 };
      },
    },
  };
}

/** In-memory fake of the pending-notify queue, so a test can assert exactly
 *  what a passive `notify`-mode delivery wrote without spinning up SQLite. */
function makeFakeQueue(): { queue: PendingNotifyQueue; writes: WritePendingNotifyInput[] } {
  const writes: WritePendingNotifyInput[] = [];
  return {
    writes,
    queue: {
      async write(input) {
        writes.push(input);
      },
      async readAndConsume() {
        return [];
      },
    },
  };
}

/** One JSON-RPC request/response round trip over the WS transport. */
function wsRpc(
  port: number,
  token: string,
  method: string,
  params: unknown,
  id = 1,
): Promise<{ id: unknown; result?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { id: unknown };
      if (msg.id === id) {
        ws.close();
        resolve(msg as { id: unknown; result?: unknown; error?: unknown });
      }
    });
    ws.on('error', reject);
  });
}

async function httpPost(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpServer /notify', () => {
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;
  let port: number;
  let token: string;

  beforeEach(async () => {
    const store = makeStore();
    server = new AcpServer({
      runner: makeRunner(),
      session: store,
      authToken: 'test-secret-token',
    });
    token = server.token;
    httpServer = server.startHttp(0);
    await new Promise<void>((resolve) => {
      httpServer.on('listening', () => {
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('POST /notify without auth returns 401', async () => {
    const res = await httpPost(port, '/notify', JSON.stringify({ kind: 'kanban' }));
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unauthorized');
  });

  it('POST /notify with valid auth returns 202', async () => {
    const res = await httpPost(
      port,
      '/notify',
      JSON.stringify({ kind: 'kanban', ref: 'task-123' }),
      { Authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.queued).toBe('number');
  });

  it('POST /notify with missing kind returns 400', async () => {
    const res = await httpPost(port, '/notify', JSON.stringify({ ref: 'task-123' }), {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('kind');
  });

  it('JSON-RPC notify method via POST /rpc returns result with ok: true', async () => {
    const rpcBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'notify',
      params: { kind: 'kanban', ref: 'task-456' },
    });
    const res = await httpPost(port, '/rpc', rpcBody, {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.ok).toBe(true);
    expect(typeof body.result.queued).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Lane C (kanban-hooks-notify-parity), Phase 2 — mode branching across all
// three transports. `notify` mode must never call runBlocking / mint a
// sessionKey; `wake` and `notify+wake` (and mode absent) must keep today's
// exact forced-turn behavior.
// ---------------------------------------------------------------------------

describe('AcpServer /notify — mode branching (Lane C Phase 2)', () => {
  async function startServer(opts: {
    runner: AgentRunner;
    queue?: PendingNotifyQueue;
    personalityId?: string;
    teamId?: string;
  }): Promise<{
    httpServer: ReturnType<typeof import('node:http').createServer>;
    port: number;
    token: string;
  }> {
    const server = new AcpServer({
      runner: opts.runner,
      session: makeStore(),
      authToken: 'test-secret-token',
      ...(opts.queue ? { notifyQueue: opts.queue } : {}),
      ...(opts.personalityId ? { personalityId: opts.personalityId } : {}),
      ...(opts.teamId ? { teamId: opts.teamId } : {}),
    });
    const token = server.token;
    const httpServer = server.startHttp(0);
    const port = await new Promise<number>((resolve) => {
      httpServer.on('listening', () => {
        const addr = httpServer.address();
        resolve(addr && typeof addr === 'object' ? addr.port : 0);
      });
    });
    return { httpServer, port, token };
  }

  async function stopServer(httpServer: ReturnType<typeof import('node:http').createServer>) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  it('HTTP: mode=notify does not call the runner and writes a pending row instead', async () => {
    const { runner, callCount } = makeCountingRunner();
    const { queue, writes } = makeFakeQueue();
    const { httpServer, port, token } = await startServer({
      runner,
      queue,
      personalityId: 'engineer',
      teamId: 'team-a',
    });
    try {
      const res = await httpPost(
        port,
        '/notify',
        JSON.stringify({ kind: 'kanban', ref: 'task-1', mode: 'notify' }),
        { Authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(202);
      expect(JSON.parse(res.body).ok).toBe(true);

      // Give any stray async work a moment, then assert the runner never ran.
      await new Promise((r) => setTimeout(r, 50));
      expect(callCount()).toBe(0);
      expect(writes).toEqual([
        { team: 'team-a', assigneePersonalityId: 'engineer', kind: 'kanban', ref: 'task-1' },
      ]);
    } finally {
      await stopServer(httpServer);
    }
  });

  it.each(['wake', 'notify+wake'] as const)(
    'HTTP: mode=%s calls the runner (unchanged behavior)',
    async (mode) => {
      const { runner, callCount } = makeCountingRunner();
      const { httpServer, port, token } = await startServer({ runner });
      try {
        const res = await httpPost(
          port,
          '/notify',
          JSON.stringify({ kind: 'kanban', ref: 'task-1', mode }),
          { Authorization: `Bearer ${token}` },
        );
        expect(res.status).toBe(202);
        await new Promise((r) => setTimeout(r, 50));
        expect(callCount()).toBe(1);
      } finally {
        await stopServer(httpServer);
      }
    },
  );

  it('HTTP: mode absent calls the runner (default-preserving)', async () => {
    const { runner, callCount } = makeCountingRunner();
    const { httpServer, port, token } = await startServer({ runner });
    try {
      const res = await httpPost(
        port,
        '/notify',
        JSON.stringify({ kind: 'kanban', ref: 'task-1' }),
        { Authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 50));
      expect(callCount()).toBe(1);
    } finally {
      await stopServer(httpServer);
    }
  });

  it('HTTP: mode=notify with no queue/team/personality wired is a no-op (no runner call, no throw)', async () => {
    const { runner, callCount } = makeCountingRunner();
    const { httpServer, port, token } = await startServer({ runner });
    try {
      const res = await httpPost(
        port,
        '/notify',
        JSON.stringify({ kind: 'kanban', ref: 'task-1', mode: 'notify' }),
        { Authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(202);
      expect(JSON.parse(res.body).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(callCount()).toBe(0);
    } finally {
      await stopServer(httpServer);
    }
  });

  it('RPC: notify method with mode=notify does not call the runner, writes a pending row', async () => {
    const { runner, callCount } = makeCountingRunner();
    const { queue, writes } = makeFakeQueue();
    const { httpServer, port, token } = await startServer({
      runner,
      queue,
      personalityId: 'engineer',
      teamId: 'team-a',
    });
    try {
      const res = await httpPost(
        port,
        '/rpc',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'notify',
          params: { kind: 'kanban', ref: 'task-2', mode: 'notify' },
        }),
        { Authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).result.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(callCount()).toBe(0);
      expect(writes).toEqual([
        { team: 'team-a', assigneePersonalityId: 'engineer', kind: 'kanban', ref: 'task-2' },
      ]);
    } finally {
      await stopServer(httpServer);
    }
  });

  it.each(['wake', 'notify+wake'] as const)(
    'RPC: notify method with mode=%s calls the runner (unchanged behavior)',
    async (mode) => {
      const { runner, callCount } = makeCountingRunner();
      const { httpServer, port, token } = await startServer({ runner });
      try {
        const res = await httpPost(
          port,
          '/rpc',
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'notify',
            params: { kind: 'kanban', ref: 'task-2', mode },
          }),
          { Authorization: `Bearer ${token}` },
        );
        expect(res.status).toBe(200);
        await new Promise((r) => setTimeout(r, 50));
        expect(callCount()).toBe(1);
      } finally {
        await stopServer(httpServer);
      }
    },
  );

  it('WS: notify method with mode=notify does not call the runner, writes a pending row', async () => {
    const { runner, callCount } = makeCountingRunner();
    const { queue, writes } = makeFakeQueue();
    const { httpServer, port, token } = await startServer({
      runner,
      queue,
      personalityId: 'engineer',
      teamId: 'team-a',
    });
    try {
      const resp = await wsRpc(port, token, 'notify', {
        kind: 'kanban',
        ref: 'task-3',
        mode: 'notify',
      });
      expect((resp.result as { ok: boolean }).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(callCount()).toBe(0);
      expect(writes).toEqual([
        { team: 'team-a', assigneePersonalityId: 'engineer', kind: 'kanban', ref: 'task-3' },
      ]);
    } finally {
      await stopServer(httpServer);
    }
  });

  it.each(['wake', 'notify+wake'] as const)(
    'WS: notify method with mode=%s calls the runner (unchanged behavior)',
    async (mode) => {
      const { runner, callCount } = makeCountingRunner();
      const { httpServer, port, token } = await startServer({ runner });
      try {
        const resp = await wsRpc(port, token, 'notify', { kind: 'kanban', ref: 'task-3', mode });
        expect((resp.result as { ok: boolean }).ok).toBe(true);
        await new Promise((r) => setTimeout(r, 50));
        expect(callCount()).toBe(1);
      } finally {
        await stopServer(httpServer);
      }
    },
  );

  it('WS: notify method with mode absent calls the runner (default-preserving)', async () => {
    const { runner, callCount } = makeCountingRunner();
    const { httpServer, port, token } = await startServer({ runner });
    try {
      const resp = await wsRpc(port, token, 'notify', { kind: 'kanban', ref: 'task-3' });
      expect((resp.result as { ok: boolean }).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(callCount()).toBe(1);
    } finally {
      await stopServer(httpServer);
    }
  });
});
