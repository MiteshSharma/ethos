import type { AgentLoop } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type { CreateBackgroundJobInput, RunUpdateDigest } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor, type BackgroundExecutorConfig } from '../index';

// T22 / I15 — the run card's liveness feed (G9/D11/D20).
//
// A background job's own events fire on its `childSessionKey`, which nobody
// watching the parent chat is subscribed to. The executor therefore publishes a
// coalesced digest keyed by `parentSessionKey`; the surface that owns a session
// stream maps it onto its own `run.update` push event. These tests pin the two
// properties that matter: the digest carries the PARENT key, and a burst of
// tool events inside one second collapses into a single publish.

const OWNER = 'owner-1';

function cfg(over?: Partial<BackgroundExecutorConfig>): BackgroundExecutorConfig {
  return {
    maxConcurrentJobs: 2,
    staleMs: 90_000,
    heartbeatMs: 15,
    queuedTtlMs: 900_000,
    maxRootBackgroundUsd: 5.0,
    pollMs: 20,
    ...over,
  };
}

function createInput(over?: Partial<CreateBackgroundJobInput>): CreateBackgroundJobInput {
  return {
    owner: OWNER,
    parentSessionKey: 'web:parent-session',
    rootSessionKey: 'root-1',
    childSessionKey: 'child-1',
    depth: 1,
    prompt: 'do the thing',
    ...over,
  };
}

type MockEvent = { type: string; [k: string]: unknown };

/** Loop that never completes on its own — only an abort ends it. */
function makeNeverEndingLoop(prelude: MockEvent[] = []): AgentLoop {
  const run = vi.fn((_text: string, opts: { abortSignal?: AbortSignal }) =>
    (async function* () {
      for (const e of prelude) {
        await Promise.resolve();
        yield e;
      }
      while (!opts.abortSignal?.aborted) {
        await new Promise((r) => setTimeout(r, 20));
        yield { type: 'text_delta', text: 'x' };
      }
    })(),
  );
  return { run } as unknown as AgentLoop;
}

function makeStaticLoop(events: MockEvent[]): AgentLoop {
  const run = vi.fn(() =>
    (async function* () {
      for (const e of events) {
        await Promise.resolve();
        yield e;
      }
    })(),
  );
  return { run } as unknown as AgentLoop;
}

describe('run digest (G9/D11/D20)', () => {
  it('publishes onto the PARENT session key, never the child', async () => {
    const store = new SQLiteJobStore(':memory:');
    const loop = makeStaticLoop([
      { type: 'tool_start', toolCallId: 't1', toolName: 'edit_file', args: { path: 'a.ts' } },
      { type: 'tool_end', toolCallId: 't1', toolName: 'edit_file', ok: true, durationMs: 3 },
      { type: 'done', text: 'done', turnCount: 1 },
    ]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const seen: RunUpdateDigest[] = [];
    exec.onRunUpdate((u) => seen.push(u));
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    await exec.shutdown();

    expect(seen.length).toBeGreaterThan(0);
    for (const update of seen) {
      expect(update.parentSessionKey).toBe('web:parent-session');
      expect(update.jobId).toBe(job.id);
      expect(update.runner).toBe('ethos');
    }
    // The card must be terminal by the time the completion notice lands under
    // it — `finishAndNotify` closes the digest before firing onComplete.
    expect(seen[seen.length - 1]?.status).toBe('done');
    expect(seen[seen.length - 1]?.now).toBe('');
  });

  it('reports the tool the run is on, as fact and not as copy — at most 1 Hz', async () => {
    // The `now` line arrives on the coalescing window's trailing edge, which is
    // the point of coalescing rather than throttling: a burst of tool events
    // inside one second collapses into ONE publish carrying the latest state,
    // not the sample that happened to arrive first.
    const store = new SQLiteJobStore(':memory:');
    const loop = makeNeverEndingLoop([
      { type: 'tool_start', toolCallId: 't1', toolName: 'read_file', args: { path: 'z.ts' } },
      { type: 'tool_start', toolCallId: 't2', toolName: 'edit_file', args: { path: 'a.ts' } },
    ]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const seen: RunUpdateDigest[] = [];
    exec.onRunUpdate((u) => seen.push(u));
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(() => expect(seen.some((u) => u.now.includes('edit_file'))).toBe(true), {
      timeout: 3000,
    });

    const withTool = seen.find((u) => u.now.includes('edit_file'));
    expect(withTool?.now).toContain('a.ts');
    // The earlier tool in the same window was collapsed away, not queued up.
    expect(seen.filter((u) => u.now.includes('read_file'))).toEqual([]);

    await store.requestCancel(job.id);
    await exec.shutdown();
  });

  it('publishes a status change immediately, without waiting out the window', async () => {
    // A status is the one thing that must never sit in a coalescing window: a
    // run that parked on a question is the most urgent row on the screen.
    const store = new SQLiteJobStore(':memory:');
    const loop = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const seen: RunUpdateDigest[] = [];
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('running'), {
      timeout: 2000,
    });
    exec.onRunUpdate((u) => seen.push(u));
    await exec.markJobBlocked(job.id, 'rq_1');

    expect(seen.map((u) => u.status)).toContain('blocked');
    // Parked runs send an empty `now`: "paused — waiting on you" is UI copy and
    // lives in the copy module, not in the executor.
    expect(seen.find((u) => u.status === 'blocked')?.now).toBe('');

    await exec.resumeJob(job.id);
    expect(seen.map((u) => u.status)).toContain('running');

    await store.requestCancel(job.id);
    await exec.shutdown();
  });

  it('unsubscribes cleanly', async () => {
    const store = new SQLiteJobStore(':memory:');
    const loop = makeStaticLoop([{ type: 'done', text: 'done', turnCount: 1 }]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const seen: RunUpdateDigest[] = [];
    const off = exec.onRunUpdate((u) => seen.push(u));
    off();
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    await exec.shutdown();

    expect(seen).toEqual([]);
  });

  it('survives a throwing subscriber', async () => {
    const store = new SQLiteJobStore(':memory:');
    const loop = makeStaticLoop([{ type: 'done', text: 'done', turnCount: 1 }]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    exec.onRunUpdate(() => {
      throw new Error('surface blew up');
    });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    await exec.shutdown();

    // A broken surface must not take the run down with it.
    expect((await store.get(job.id))?.status).toBe('done');
  });
});
