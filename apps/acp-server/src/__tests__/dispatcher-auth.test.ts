import { randomUUID } from 'node:crypto';
import { defaultDispatchCall, defaultSpawnDispatchCall } from '@ethosagent/team-supervisor';
import type {
  BackgroundJob,
  CreateBackgroundJobInput,
  JobStore,
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpServer, type AgentRunner } from '../index';

// ---------------------------------------------------------------------------
// This suite proves the fix for the pre-existing bug where
// `defaultDispatchCall`/`defaultSpawnDispatchCall` (extensions/team-supervisor)
// never sent an Authorization header, so every dispatch to a real
// bearer-secured AcpServer would 401. It drives a REAL AcpServer over a real
// socket (matching the pattern in ../__tests__/spawn.test.ts and
// ../__tests__/auth.test.ts) rather than mocking the transport.
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

function makeRunner(): AgentRunner {
  return {
    run: async function* () {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', text: 'ok', turnCount: 1 };
    },
  };
}

interface FakeJobStore extends JobStore {
  created: CreateBackgroundJobInput[];
}

function makeJobStore(): FakeJobStore {
  const jobs = new Map<string, BackgroundJob>();
  const created: CreateBackgroundJobInput[] = [];
  return {
    created,
    async create(input) {
      created.push(input);
      const job: BackgroundJob = {
        id: randomUUID(),
        owner: input.owner,
        parentSessionKey: input.parentSessionKey,
        rootSessionKey: input.rootSessionKey,
        childSessionKey: input.childSessionKey,
        depth: input.depth,
        status: 'queued',
        prompt: input.prompt,
        spendUsd: 0,
        createdAt: Date.now(),
        ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      };
      jobs.set(job.id, job);
      return job;
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async claimNextQueued() {
      return null;
    },
    async heartbeat() {},
    async updateSpend() {},
    async requestCancel() {},
    async markBlocked() {},
    async resumeFromBlocked() {},
    async finish() {},
    async listByRoot() {
      return [];
    },
    async countActiveByRoot() {
      return 0;
    },
    async countActiveByPersonality() {
      return 0;
    },
    async countActive() {
      return 0;
    },
    async reclaimStale() {
      return [];
    },
    async expireQueued() {
      return [];
    },
    async appendEvent() {},
    async getEvents() {
      return [];
    },
    async listRunningRemote() {
      return [];
    },
    async pruneTerminal() {
      return 0;
    },
    async listUndelivered() {
      return [];
    },
    async claimDelivery() {
      return true;
    },
    async releaseDelivery() {},
    async claimNotice() {
      return true;
    },
    async releaseNotice() {},
  };
}

async function listen(server: AcpServer): Promise<{
  httpServer: ReturnType<typeof import('node:http').createServer>;
  port: number;
}> {
  const httpServer = server.startHttp(0);
  await new Promise<void>((resolve) => {
    httpServer.on('listening', () => resolve());
  });
  const addr = httpServer.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return { httpServer, port };
}

describe('defaultDispatchCall against a real bearer-secured AcpServer', () => {
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;
  let port: number;

  beforeEach(async () => {
    server = new AcpServer({
      runner: makeRunner(),
      session: makeStore(),
      authToken: 'correct-token',
    });
    ({ httpServer, port } = await listen(server));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('succeeds when the resolved authToken matches the server token', async () => {
    const controller = new AbortController();
    const result = await defaultDispatchCall({
      host: '127.0.0.1',
      port,
      prompt: 'do the thing',
      personalityId: 'engineer',
      signal: controller.signal,
      authToken: 'correct-token',
    });
    expect(result).toBe('notified');
  });

  it('fails with 401 when the authToken is wrong', async () => {
    const controller = new AbortController();
    await expect(
      defaultDispatchCall({
        host: '127.0.0.1',
        port,
        prompt: 'do the thing',
        personalityId: 'engineer',
        signal: controller.signal,
        authToken: 'wrong-token',
      }),
    ).rejects.toThrow(/401/);
  });

  it('fails with 401 when no authToken is provided at all', async () => {
    const controller = new AbortController();
    await expect(
      defaultDispatchCall({
        host: '127.0.0.1',
        port,
        prompt: 'do the thing',
        personalityId: 'engineer',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/401/);
  });
});

describe('defaultSpawnDispatchCall against a real bearer-secured AcpServer', () => {
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;
  let port: number;

  beforeEach(async () => {
    server = new AcpServer({
      runner: makeRunner(),
      session: makeStore(),
      authToken: 'correct-token',
      jobStore: makeJobStore(),
      backgroundExecutor: { owner: 'test', nudge: vi.fn() },
    });
    ({ httpServer, port } = await listen(server));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('succeeds and returns a jobId when the resolved authToken matches the server token', async () => {
    const controller = new AbortController();
    const result = await defaultSpawnDispatchCall({
      host: '127.0.0.1',
      port,
      prompt: 'do the thing',
      personalityId: 'engineer',
      signal: controller.signal,
      authToken: 'correct-token',
    });
    expect(result.jobId).toBeTruthy();
  });

  it('fails with 401 when the authToken is wrong', async () => {
    const controller = new AbortController();
    await expect(
      defaultSpawnDispatchCall({
        host: '127.0.0.1',
        port,
        prompt: 'do the thing',
        personalityId: 'engineer',
        signal: controller.signal,
        authToken: 'wrong-token',
      }),
    ).rejects.toThrow(/401/);
  });

  it('fails with 401 when no authToken is provided at all', async () => {
    const controller = new AbortController();
    await expect(
      defaultSpawnDispatchCall({
        host: '127.0.0.1',
        port,
        prompt: 'do the thing',
        personalityId: 'engineer',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/401/);
  });
});
