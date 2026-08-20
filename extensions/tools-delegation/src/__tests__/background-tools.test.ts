// Background sub-agents tool surface.
//
// Covers the `background`/`max_cost_usd` option on `delegate_task` and the four
// sibling task_* tools. Uses a small in-memory JobStore fake so the suite is
// independent of @ethosagent/job-store (built by a parallel agent).

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  BackgroundJob,
  BackgroundJobEvent,
  BackgroundJobEventType,
  BackgroundJobStatus,
  CreateBackgroundJobInput,
  JobRunner,
  JobRunnerRegistry,
  JobStore,
  ToolContext,
} from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BackgroundToolDeps,
  createDelegateTaskTool,
  createRouteToAgentTool,
  createTaskCancelTool,
  createTaskLogsTool,
  createTaskResultTool,
  createTaskStatusTool,
} from '../index';

// ---------------------------------------------------------------------------
// In-memory JobStore fake — implements the 16 contract methods over Maps.
// ---------------------------------------------------------------------------

const ACTIVE: ReadonlySet<BackgroundJobStatus> = new Set(['queued', 'running']);

class FakeJobStore implements JobStore {
  jobs = new Map<string, BackgroundJob>();
  events = new Map<string, BackgroundJobEvent[]>();
  private seq = 0;

  async create(input: CreateBackgroundJobInput): Promise<BackgroundJob> {
    const id = `job-${++this.seq}`;
    const job: BackgroundJob = {
      id,
      owner: input.owner,
      parentSessionKey: input.parentSessionKey,
      rootSessionKey: input.rootSessionKey,
      childSessionKey: input.childSessionKey,
      personalityId: input.personalityId,
      depth: input.depth,
      status: 'queued',
      label: input.label,
      prompt: input.prompt,
      maxCostUsd: input.maxCostUsd,
      spendUsd: 0,
      createdAt: Date.now(),
      originPlatform: input.originPlatform,
      originBotKey: input.originBotKey,
      originChatId: input.originChatId,
      originThreadId: input.originThreadId,
      remotePeer: input.remotePeer,
      remoteJobId: input.remoteJobId,
      runner: input.runner,
    };
    this.jobs.set(id, job);
    this.events.set(id, []);
    return job;
  }
  async get(id: string): Promise<BackgroundJob | null> {
    return this.jobs.get(id) ?? null;
  }
  async claimNextQueued(owner?: string): Promise<BackgroundJob | null> {
    if (owner === undefined) return null;
    const queued = [...this.jobs.values()]
      .filter((j) => j.owner === owner && j.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    const job = queued[0];
    if (!job) return null;
    job.status = 'running';
    job.startedAt = Date.now();
    job.heartbeatAt = Date.now();
    return job;
  }
  async heartbeat(): Promise<void> {}
  async updateSpend(id: string, spendUsd: number): Promise<void> {
    const job = this.jobs.get(id);
    if (job) job.spendUsd = spendUsd;
  }
  async requestCancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) job.cancelRequested = true;
  }
  async markBlocked(): Promise<void> {}
  async resumeFromBlocked(): Promise<void> {}
  async finish(): Promise<void> {}
  async listByRoot(rootSessionKey: string): Promise<BackgroundJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.rootSessionKey === rootSessionKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async countActiveByRoot(rootSessionKey: string): Promise<number> {
    return [...this.jobs.values()].filter(
      (j) => j.rootSessionKey === rootSessionKey && ACTIVE.has(j.status),
    ).length;
  }
  async countActiveByPersonality(personalityId: string): Promise<number> {
    return [...this.jobs.values()].filter(
      (j) => j.personalityId === personalityId && ACTIVE.has(j.status),
    ).length;
  }
  async reclaimStale(): Promise<BackgroundJob[]> {
    return [];
  }
  async expireQueued(): Promise<BackgroundJob[]> {
    return [];
  }
  async listRunningRemote(): Promise<BackgroundJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'running' && j.remoteJobId !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async pruneTerminal(): Promise<number> {
    return 0;
  }
  async listUndelivered(originBotKeys: string[]): Promise<BackgroundJob[]> {
    return [...this.jobs.values()].filter(
      (j) =>
        (j.status === 'done' || j.status === 'failed') &&
        j.deliveredAt === undefined &&
        j.originBotKey !== undefined &&
        originBotKeys.includes(j.originBotKey) &&
        j.originPlatform !== undefined &&
        j.originChatId !== undefined,
    );
  }
  async claimDelivery(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.deliveredAt !== undefined) return false;
    job.deliveredAt = Date.now();
    return true;
  }
  async releaseDelivery(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) job.deliveredAt = undefined;
  }
  async appendEvent(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const list = this.events.get(jobId) ?? [];
    list.push({
      id: list.length + 1,
      jobId,
      seq: list.length + 1,
      eventType,
      payload,
      createdAt: Date.now(),
    });
    this.events.set(jobId, list);
  }
  async getEvents(jobId: string): Promise<BackgroundJobEvent[]> {
    return [...(this.events.get(jobId) ?? [])];
  }

  // Test helper — seed a fully-formed row directly.
  seed(partial: Partial<BackgroundJob> & { id: string; rootSessionKey: string }): BackgroundJob {
    const job: BackgroundJob = {
      owner: 'worker-1',
      parentSessionKey: partial.rootSessionKey,
      childSessionKey: `${partial.rootSessionKey}:job:x:0`,
      depth: 1,
      status: 'queued',
      prompt: 'seeded',
      spendUsd: 0,
      createdAt: Date.now(),
      ...partial,
    };
    this.jobs.set(job.id, job);
    if (!this.events.has(job.id)) this.events.set(job.id, []);
    return job;
  }
}

// A loop that must NOT be invoked on the background path.
const loop = {
  run: () => {
    throw new Error('loop.run must not be called on the background path');
  },
} as unknown as AgentLoop;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

/**
 * A registry holding the named runners as already-RESOLVED instances. The tool
 * validates through `get`, so registration alone must not make a name usable.
 */
function fakeRegistry(resolved: string[]): JobRunnerRegistry {
  const runners = new Map<string, JobRunner>(
    resolved.map((name) => [name, { name } as unknown as JobRunner]),
  );
  return {
    register: () => {},
    resolve: async (name) => {
      const runner = runners.get(name);
      if (!runner) throw new Error(`not registered: ${name}`);
      return runner;
    },
    get: (name) => runners.get(name),
    list: () => [...runners.keys()],
  };
}

function makeDeps(store: FakeJobStore, overrides: Partial<BackgroundToolDeps> = {}) {
  const nudge = vi.fn();
  const deps: BackgroundToolDeps = {
    store,
    nudge,
    owner: 'worker-1',
    defaultMaxCostUsd: 1.5,
    maxJobsPerRoot: 3,
    maxJobsPerPersonality: 5,
    staleMs: 60_000,
    ...overrides,
  };
  return { deps, nudge };
}

// ---------------------------------------------------------------------------
// delegate_task — background path
// ---------------------------------------------------------------------------

describe('delegate_task background path', () => {
  it('returns not_available when background deps are absent', async () => {
    const tool = createDelegateTaskTool(loop); // no deps
    const res = await tool.execute({ prompt: 'do it', background: true }, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_available');
  });

  it('creates a queued job, returns the envelope, and calls nudge', async () => {
    const store = new FakeJobStore();
    const { deps, nudge } = makeDeps(store);
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute(
      { prompt: 'research X', background: true, label: 'research-x' },
      makeCtx({ personalityId: 'me' }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    const payload = JSON.parse(res.value) as {
      jobId: string;
      childSessionKey: string;
      status: string;
    };
    expect(payload.status).toBe('queued');
    expect(payload.childSessionKey).toMatch(/^cli:test:job:research-x:[0-9a-f]{8}$/);

    const job = store.jobs.get(payload.jobId);
    expect(job).toBeDefined();
    expect(job?.status).toBe('queued');
    expect(job?.prompt).toBe('research X');
    expect(job?.personalityId).toBe('me');
    expect(job?.depth).toBe(1);
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid labels', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createDelegateTaskTool(loop, deps);

    for (const label of ['Has Caps', 'a:b', 'x'.repeat(33)]) {
      const res = await tool.execute({ prompt: 'p', background: true, label }, makeCtx());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('input_invalid');
    }
    expect(store.jobs.size).toBe(0);
  });

  it('rejects at the spawn-depth cap without creating a job', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute(
      { prompt: 'p', background: true },
      makeCtx({ agentId: 'depth:3' }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('execution_failed');
    expect(store.jobs.size).toBe(0);
  });

  it('rejects cross-personality delegation (unchanged guard)', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute(
      { prompt: 'p', background: true, personality: 'other' },
      makeCtx({ personalityId: 'me' }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('input_invalid');
    expect(store.jobs.size).toBe(0);
  });

  it("defaults the runner to 'ethos' when omitted", async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute({ prompt: 'p', background: true }, makeCtx());
    if (!res.ok) throw new Error('expected ok');
    expect(store.jobs.get(JSON.parse(res.value).jobId)?.runner).toBe('ethos');
  });

  it('stamps a registered runner on the row', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store, { runners: fakeRegistry(['other-harness']) });
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute(
      { prompt: 'p', background: true, runner: 'other-harness' },
      makeCtx(),
    );
    if (!res.ok) throw new Error('expected ok');
    expect(store.jobs.get(JSON.parse(res.value).jobId)?.runner).toBe('other-harness');
  });

  it('refuses an unregistered runner with not_available — never a silent fallback', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store, { runners: fakeRegistry(['other-harness']) });
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute({ prompt: 'p', background: true, runner: 'pi' }, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_available');
    expect(store.jobs.size).toBe(0);
  });

  it('refuses any non-default runner when the deployment registered none', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute(
      { prompt: 'p', background: true, runner: 'other-harness' },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_available');
    expect(store.jobs.size).toBe(0);
  });

  it('rejects runner on the blocking path — it selects a background worker or nothing', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store, { runners: fakeRegistry(['other-harness']) });
    const tool = createDelegateTaskTool(loop, deps);

    const res = await tool.execute({ prompt: 'p', runner: 'other-harness' }, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('input_invalid');
    expect(store.jobs.size).toBe(0);
  });

  it('enforces the per-root concurrency cap', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store, { maxJobsPerRoot: 2 });
    const tool = createDelegateTaskTool(loop, deps);
    store.seed({ id: 'a', rootSessionKey: 'cli:test', status: 'running' });
    store.seed({ id: 'b', rootSessionKey: 'cli:test', status: 'queued' });

    const res = await tool.execute({ prompt: 'p', background: true }, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('execution_failed');
  });

  it('populates ALL FOUR origin lane fields, so the job is routable by ownership', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store, {
      originBotKey: 'bot-1',
      resolveOriginThreadId: (sessionKey) => (sessionKey === 'cli:test' ? 'thread-7' : undefined),
    });
    const tool = createDelegateTaskTool(loop, deps);

    const withOrigin = await tool.execute(
      { prompt: 'p', background: true },
      makeCtx({ origin: 'telegram:chat-9' }),
    );
    if (!withOrigin.ok) throw new Error('expected ok');
    const withOriginJob = store.jobs.get(JSON.parse(withOrigin.value).jobId);
    expect(withOriginJob?.originPlatform).toBe('telegram');
    expect(withOriginJob?.originChatId).toBe('chat-9');
    // botKey is what the gateway's ownership filter reads. Without it the job's
    // completion could never be announced — it would be nobody's to deliver.
    expect(withOriginJob?.originBotKey).toBe('bot-1');
    expect(withOriginJob?.originThreadId).toBe('thread-7');
    // ...and that is exactly the predicate the restore sweep queries on.
    expect(await store.listUndelivered(['bot-1'])).toHaveLength(0); // still queued
    if (withOriginJob) withOriginJob.status = 'done';
    expect(await store.listUndelivered(['bot-1'])).toHaveLength(1);
    expect(await store.listUndelivered(['bot-other'])).toHaveLength(0);

    const noOrigin = await tool.execute({ prompt: 'p', background: true }, makeCtx());
    if (!noOrigin.ok) throw new Error('expected ok');
    const noOriginJob = store.jobs.get(JSON.parse(noOrigin.value).jobId);
    expect(noOriginJob?.originPlatform).toBeUndefined();
    expect(noOriginJob?.originChatId).toBeUndefined();
    // No channel origin → no lane at all, not a half-populated one.
    expect(noOriginJob?.originBotKey).toBeUndefined();
    expect(noOriginJob?.originThreadId).toBeUndefined();
  });

  it('resolves the cost cap: null=uncapped, number=value, omitted=default', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createDelegateTaskTool(loop, deps);

    const nullRes = await tool.execute(
      { prompt: 'p', background: true, max_cost_usd: null },
      makeCtx(),
    );
    if (!nullRes.ok) throw new Error('expected ok');
    expect(store.jobs.get(JSON.parse(nullRes.value).jobId)?.maxCostUsd).toBeUndefined();

    const numRes = await tool.execute(
      { prompt: 'p', background: true, max_cost_usd: 2.5 },
      makeCtx(),
    );
    if (!numRes.ok) throw new Error('expected ok');
    expect(store.jobs.get(JSON.parse(numRes.value).jobId)?.maxCostUsd).toBe(2.5);

    const omitRes = await tool.execute({ prompt: 'p', background: true }, makeCtx());
    if (!omitRes.ok) throw new Error('expected ok');
    expect(store.jobs.get(JSON.parse(omitRes.value).jobId)?.maxCostUsd).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// Root scoping — a job under a different root is "not found"
// ---------------------------------------------------------------------------

describe('task_* root scoping', () => {
  it('hides jobs whose rootSessionKey differs from the caller', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    store.seed({ id: 'foreign', rootSessionKey: 'cli:ethos-fork', status: 'running' });

    const ctx = makeCtx({ sessionKey: 'cli:ethos' });
    for (const tool of [
      createTaskStatusTool(deps),
      createTaskResultTool(deps),
      createTaskCancelTool(deps),
      createTaskLogsTool(deps),
    ]) {
      const res = await tool.execute({ id: 'foreign' }, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('input_invalid');
        expect(res.error).toBe('job not found');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// task_result
// ---------------------------------------------------------------------------

describe('task_result', () => {
  it('returns a progress line for a non-terminal job (ok:true)', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    store.seed({ id: 'r', rootSessionKey: 'cli:test', status: 'running', spendUsd: 0.25 });

    const res = await createTaskResultTool(deps).execute({ id: 'r' }, makeCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('still running; spent $0.2500 so far');
  });

  it('returns the summary for a done job and is marked untrusted', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    store.seed({ id: 'd', rootSessionKey: 'cli:test', status: 'done', summary: 'all done' });

    const tool = createTaskResultTool(deps);
    expect(tool.outputIsUntrusted).toBe(true);
    const res = await tool.execute({ id: 'd' }, makeCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('all done');
  });
});

// ---------------------------------------------------------------------------
// task_status
// ---------------------------------------------------------------------------

describe('task_status', () => {
  it('lists all jobs for the caller when id is omitted', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    store.seed({ id: 'a', rootSessionKey: 'cli:test', status: 'running', label: 'one' });
    store.seed({ id: 'b', rootSessionKey: 'cli:test', status: 'done', label: 'two' });

    const res = await createTaskStatusTool(deps).execute({}, makeCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      const list = JSON.parse(res.value) as Array<{ id: string }>;
      expect(list.map((j) => j.id).sort()).toEqual(['a', 'b']);
    }
  });

  it('flags a stale heartbeat for a running job', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store, { staleMs: 1_000 });
    store.seed({
      id: 's',
      rootSessionKey: 'cli:test',
      status: 'running',
      heartbeatAt: Date.now() - 10_000,
    });

    const res = await createTaskStatusTool(deps).execute({ id: 's' }, makeCtx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toContain('heartbeat stale');
  });
});

// ---------------------------------------------------------------------------
// task_cancel
// ---------------------------------------------------------------------------

describe('task_cancel', () => {
  it('invokes requestCancel on the store', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    store.seed({ id: 'c', rootSessionKey: 'cli:test', status: 'running' });
    const spy = vi.spyOn(store, 'requestCancel');

    const res = await createTaskCancelTool(deps).execute({ id: 'c' }, makeCtx());
    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith('c');
    expect(store.jobs.get('c')?.cancelRequested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// task_logs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// route_to_agent — background (detached remote spawn) path
// ---------------------------------------------------------------------------

describe('route_to_agent background path', () => {
  const storage = new FsStorage();
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRegistryPath(): string {
    const dir = join(
      tmpdir(),
      `ethos-bg-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return join(dir, 'registry.json');
  }

  it('returns not_available when background deps are absent', async () => {
    const registryPath = makeRegistryPath();
    const tool = createRouteToAgentTool(storage, registryPath); // no background deps
    const res = await tool.execute(
      { capability: 'research', prompt: 'analyze', background: true },
      makeCtx({ scopedFetch: { fetch: vi.fn() as never } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_available');
  });

  it('spawns on the best peer and creates a running proxy row', async () => {
    const registryPath = makeRegistryPath();
    const mesh = new AgentMesh(registryPath, { storage });
    await mesh.register({
      agentId: 'researcher:711:one',
      capabilities: ['research'],
      model: 'm',
      pid: 711,
      host: '127.0.0.1',
      port: 7201,
      activeSessions: 0,
    });

    const mockFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method: string };
      expect(payload.method).toBe('spawn');
      return { json: async () => ({ result: { jobId: 'r1', status: 'queued' } }) };
    }) as unknown as (url: string | URL, init?: RequestInit) => Promise<Response>;

    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createRouteToAgentTool(storage, registryPath, deps);

    const res = await tool.execute(
      { capability: 'research', prompt: 'analyze the data', background: true },
      makeCtx({ personalityId: 'me', scopedFetch: { fetch: mockFetch } }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    const payload = JSON.parse(res.value) as {
      jobId: string;
      remotePeer: string;
      remoteJobId: string;
      status: string;
    };
    expect(payload.remotePeer).toBe('127.0.0.1:7201');
    expect(payload.remoteJobId).toBe('r1');
    expect(payload.status).toBe('running');

    const job = store.jobs.get(payload.jobId);
    expect(job).toBeDefined();
    expect(job?.remotePeer).toBe('127.0.0.1:7201');
    expect(job?.remoteJobId).toBe('r1');
    expect(job?.status).toBe('running'); // claimed by its unique proxy owner
    expect(job?.owner.startsWith('mesh-proxy:')).toBe(true);
    expect(job?.personalityId).toBe('me');
    expect(job?.depth).toBe(1);
  });

  it('returns execution_failed when no peer advertises the capability', async () => {
    const registryPath = makeRegistryPath();
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    const tool = createRouteToAgentTool(storage, registryPath, deps);

    const res = await tool.execute(
      { capability: 'nonexistent', prompt: 'x', background: true },
      makeCtx({ scopedFetch: { fetch: vi.fn() as never } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('execution_failed');
    expect(store.jobs.size).toBe(0);
  });
});

describe('task_logs', () => {
  it('formats recent events, respects tail, and is marked untrusted', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    store.seed({ id: 'l', rootSessionKey: 'cli:test', status: 'running' });
    await store.appendEvent('l', 'queued', {});
    await store.appendEvent('l', 'claimed', { owner: 'worker-1' });
    await store.appendEvent('l', 'tool_headline', { toolName: 'read_file', arg: 'a.txt' });
    await store.appendEvent('l', 'spend', { spendUsd: 0.12 });

    const tool = createTaskLogsTool(deps);
    expect(tool.outputIsUntrusted).toBe(true);

    const res = await tool.execute({ id: 'l', tail: 2 }, makeCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      const lines = res.value.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('ran read_file — a.txt');
      expect(lines[1]).toContain('spend $0.12');
    }
  });

  it('renders the new tool_end and text events, one event per line', async () => {
    const store = new FakeJobStore();
    const { deps } = makeDeps(store);
    store.seed({ id: 'l2', rootSessionKey: 'cli:test', status: 'running' });
    await store.appendEvent('l2', 'tool_headline', { toolName: 'bash', arg: 'ls' });
    await store.appendEvent('l2', 'tool_end', {
      toolName: 'bash',
      ok: false,
      durationMs: 40,
      error: 'exit 1',
    });
    // A chunk with newlines must still render as ONE line — task_logs is a tail.
    await store.appendEvent('l2', 'text', { text: 'first line\n\nsecond   line' });
    await store.appendEvent('l2', 'text', { truncated: true });

    const res = await createTaskLogsTool(deps).execute({ id: 'l2', tail: 4 }, makeCtx());
    expect(res.ok).toBe(true);
    if (res.ok) {
      const lines = res.value.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[1]).toContain('bash failed: exit 1 in 40ms');
      expect(lines[2]).toContain('output: first line second line');
      expect(lines[3]).toContain('output truncated');
    }
  });
});
