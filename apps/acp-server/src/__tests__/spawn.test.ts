import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { FsStorage } from '@ethosagent/storage-fs';
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
// In-memory SessionStore (same as notify.test.ts)
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
// Fake in-memory JobStore — records create() inputs, returns queued jobs.
// ---------------------------------------------------------------------------

interface FakeJobStore extends JobStore {
  created: CreateBackgroundJobInput[];
  jobs: Map<string, BackgroundJob>;
}

function makeJobStore(): FakeJobStore {
  const jobs = new Map<string, BackgroundJob>();
  const created: CreateBackgroundJobInput[] = [];
  return {
    created,
    jobs,
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
        ...(input.label ? { label: input.label } : {}),
        ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
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

function rpc(port: number, token: string, method: string, params: unknown) {
  return httpPost(port, '/rpc', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), {
    Authorization: `Bearer ${token}`,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

describe('AcpServer spawn / job_status (background jobs enabled)', () => {
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;
  let port: number;
  let token: string;
  let jobStore: FakeJobStore;
  let nudge: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    jobStore = makeJobStore();
    nudge = vi.fn<() => void>();
    server = new AcpServer({
      runner: makeRunner(),
      session: makeStore(),
      authToken: 'test-secret-token',
      jobStore,
      backgroundExecutor: { owner: 'test', nudge },
    });
    token = server.token;
    ({ httpServer, port } = await listen(server));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('spawn creates a job, nudges the executor, and returns jobId + status', async () => {
    const res = await rpc(port, token, 'spawn', { text: 'do the thing' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.result.jobId).toBe('string');
    expect(body.result.status).toBe('queued');
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(jobStore.created).toHaveLength(1);
    expect(jobStore.created[0]?.owner).toBe('test');
    expect(jobStore.created[0]?.prompt).toBe('do the thing');
    expect(jobStore.created[0]?.depth).toBe(0);
  });

  it('spawn without text returns -32602', async () => {
    const res = await rpc(port, token, 'spawn', { text: '' });
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('text');
    expect(nudge).not.toHaveBeenCalled();
  });

  it('spawn passes a valid peer label through', async () => {
    await rpc(port, token, 'spawn', { text: 'x', label: 'nightly-run' });
    expect(jobStore.created[0]?.label).toBe('nightly-run');
  });

  it('spawn drops an invalid peer label', async () => {
    await rpc(port, token, 'spawn', { text: 'x', label: 'Bad Label!! WITH spaces' });
    expect(jobStore.created[0]?.label).toBeUndefined();
  });

  it('spawn forwards personalityId and maxCostUsd', async () => {
    await rpc(port, token, 'spawn', { text: 'x', personalityId: 'coder', maxCostUsd: 1.5 });
    expect(jobStore.created[0]?.personalityId).toBe('coder');
    expect(jobStore.created[0]?.maxCostUsd).toBe(1.5);
  });

  it('job_status returns the job status for a known job', async () => {
    const spawnRes = await rpc(port, token, 'spawn', { text: 'x' });
    const jobId = JSON.parse(spawnRes.body).result.jobId as string;
    const res = await rpc(port, token, 'job_status', { jobId });
    const body = JSON.parse(res.body);
    expect(body.result.found).toBe(true);
    expect(body.result.status).toBe('queued');
    expect(body.result.summary).toBeNull();
    expect(body.result.error).toBeNull();
    expect(body.result.spendUsd).toBe(0);
  });

  it('job_status returns found: false for an unknown job', async () => {
    const res = await rpc(port, token, 'job_status', { jobId: 'nope' });
    const body = JSON.parse(res.body);
    expect(body.result.found).toBe(false);
  });
});

describe('AcpServer spawn / job_status (background jobs NOT enabled)', () => {
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;
  let port: number;
  let token: string;

  beforeEach(async () => {
    server = new AcpServer({
      runner: makeRunner(),
      session: makeStore(),
      authToken: 'test-secret-token',
    });
    token = server.token;
    ({ httpServer, port } = await listen(server));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('spawn errors with -32000 when no store/executor is configured', async () => {
    const res = await rpc(port, token, 'spawn', { text: 'x' });
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('not enabled');
  });

  it('job_status errors with -32000 when no store is configured', async () => {
    const res = await rpc(port, token, 'job_status', { jobId: 'x' });
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('not enabled');
  });
});

// ---------------------------------------------------------------------------
// plan T1.1 / D12 — roster-constrain `spawn`'s `personalityId` when a mesh is
// configured. Real HTTP server + real fetch (same pattern the rest of this
// file already uses), which is what makes this a real-transport proof of the
// trust boundary rather than a unit stub.
// ---------------------------------------------------------------------------

describe('AcpServer spawn — mesh roster constraint (plan T1.1 / D12)', () => {
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;
  let port: number;
  let token: string;
  let jobStore: FakeJobStore;
  let nudge: ReturnType<typeof vi.fn<() => void>>;
  let mesh: AgentMesh;

  beforeEach(async () => {
    jobStore = makeJobStore();
    nudge = vi.fn<() => void>();
    // `AgentMesh`'s lock acquisition is raw `node:fs` regardless of the
    // injected `Storage` (CLAUDE.md exception — a lock is a primitive Storage
    // can't express), so a real tmpdir path is required here — same pattern
    // `extensions/agent-mesh/src/__tests__/agent-mesh.test.ts` uses.
    const registryPath = join(tmpdir(), `acp-spawn-roster-test-${randomUUID()}.json`);
    mesh = new AgentMesh(registryPath, { storage: new FsStorage() });
    // A live roster member — the SAME registration path production wiring uses
    // (`serve.ts`'s `mesh.register()`), not a hand-crafted allowlist.
    await mesh.register({
      agentId: 'coder:1:aaaaaaaa',
      capabilities: [],
      model: 'test-model',
      pid: 1,
      host: 'localhost',
      port: 9999,
      activeSessions: 0,
      personalityId: 'coder',
    });
    server = new AcpServer({
      runner: makeRunner(),
      session: makeStore(),
      authToken: 'test-secret-token',
      jobStore,
      backgroundExecutor: { owner: 'test', nudge },
      mesh,
    });
    token = server.token;
    ({ httpServer, port } = await listen(server));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('rejects a personalityId NOT on the mesh roster', async () => {
    const res = await rpc(port, token, 'spawn', { text: 'x', personalityId: 'not-a-team-member' });
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('not-a-team-member');
    expect(body.error.message).toContain('roster');
    expect(jobStore.created).toHaveLength(0);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('accepts a personalityId ON the mesh roster — no regression to legitimate dispatch', async () => {
    const res = await rpc(port, token, 'spawn', { text: 'x', personalityId: 'coder' });
    const body = JSON.parse(res.body);
    expect(typeof body.result.jobId).toBe('string');
    expect(jobStore.created[0]?.personalityId).toBe('coder');
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('does not constrain spawn calls with no personalityId at all', async () => {
    const res = await rpc(port, token, 'spawn', { text: 'x' });
    const body = JSON.parse(res.body);
    expect(typeof body.result.jobId).toBe('string');
    expect(jobStore.created[0]?.personalityId).toBeUndefined();
  });
});
