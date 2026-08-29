import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClarifyBridge, FileClarifyStore } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { BackgroundJob, JobStore, PendingClarify } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// The server half of the parked-question restore (pi-delegation I14).
//
// `clarify.request` is a live-only push, so the ONLY way a page that mounts
// after a run parked can learn what the run is waiting on is this read. The
// scoping is the part worth proving over the wire: a delegated run asks on its
// CHILD session key, so the join is the job — filter by clarify `sessionId`
// and a browser gets nothing at all.

const ROOT_KEY = 'web:sess-1';

function job(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1',
    status: 'blocked',
    prompt: 'ship it',
    spendUsd: 0.2,
    depth: 1,
    createdAt: 1_000,
    owner: 'host',
    rootSessionKey: ROOT_KEY,
    parentSessionKey: ROOT_KEY,
    childSessionKey: `${ROOT_KEY}:job:ship:abcd`,
    runner: 'pi',
    ...over,
  } as BackgroundJob;
}

function row(over: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'req-1',
    // The run's own session, never a web session id — see `createClarifyEscalator`.
    sessionId: `${ROOT_KEY}:job:ship:abcd`,
    jobId: 'job-1',
    surfaceType: 'web',
    surfaceContext: {},
    question: 'Push the branch to origin?',
    options: ['Allow', 'Deny'],
    answerableBy: 'anyone',
    createdAt: '2026-08-20T11:00:00.000Z',
    defaultDeadlineAt: '2026-08-20T12:00:00.000Z',
    presentedAt: '2026-08-20T11:00:00.000Z',
    ...over,
  };
}

describe('clarify.listPending RPC', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;
  let clarifyStore: FileClarifyStore;
  let jobs: BackgroundJob[];
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-clarify-rpc-'));
    sessions = new SQLiteSessionStore(':memory:');
    clarifyStore = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    jobs = [job()];

    const bridge = new ClarifyBridge(clarifyStore, { reconcilePollMs: 0 });
    const loop = makeStubAgentLoop();
    // The bridge reaches the RPC context via the loop, exactly as in wiring.
    (loop as unknown as { clarifyBridge: ClarifyBridge }).clarifyBridge = bridge;

    const jobStore = {
      listByRoot: async (key: string) => jobs.filter((j) => j.rootSessionKey === key),
    } as unknown as JobStore;

    app = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: loop,
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      jobStore,
    }).app;

    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  });

  afterEach(async () => {
    sessions.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const listPending = async (rootSessionKey: string) => {
    const res = await app.request('/rpc/clarify/listPending', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: { rootSessionKey } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: unknown[] };
    return body.json;
  };

  it('returns the question a parked run of this session is waiting on', async () => {
    await clarifyStore.add(row());

    expect(await listPending(ROOT_KEY)).toEqual([
      {
        requestId: 'req-1',
        jobId: 'job-1',
        question: 'Push the branch to origin?',
        options: ['Allow', 'Deny'],
        defaultDeadlineAt: '2026-08-20T12:00:00.000Z',
      },
    ]);
  });

  it('does not leak another session’s question', async () => {
    await clarifyStore.add(row({ requestId: 'req-2', jobId: 'other-job' }));

    expect(await listPending(ROOT_KEY)).toEqual([]);
  });

  it('skips a question still queued behind another in its lane', async () => {
    // D2 — no deadline means no timer and no presentation: it has been shown to
    // nobody, and offering it here would jump the FIFO.
    await clarifyStore.add(row({ defaultDeadlineAt: null, presentedAt: null }));

    expect(await listPending(ROOT_KEY)).toEqual([]);
  });

  it('skips a question already answered in another process', async () => {
    await clarifyStore.add(
      row({ answer: { requestId: 'req-1', answer: 'Allow', source: 'user' } }),
    );

    expect(await listPending(ROOT_KEY)).toEqual([]);
  });

  it('skips a question whose run has finished', async () => {
    jobs = [job({ status: 'done', finishedAt: 9_000 })];
    await clarifyStore.add(row());

    expect(await listPending(ROOT_KEY)).toEqual([]);
  });
});
