import type { AgentLoop } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type { BackgroundJob, CreateBackgroundJobInput, HookRegistry } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor, type BackgroundExecutorConfig } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    parentSessionKey: 'parent',
    rootSessionKey: 'root-1',
    childSessionKey: 'child-1',
    depth: 1,
    prompt: 'do the thing',
    ...over,
  };
}

type MockEvent = { type: string; [k: string]: unknown };

/** Loop that yields a fixed sequence of events, then completes. */
function makeStaticLoop(events: MockEvent[]): {
  loop: AgentLoop;
  run: ReturnType<typeof vi.fn>;
  signals: Array<AbortSignal | undefined>;
} {
  const signals: Array<AbortSignal | undefined> = [];
  const run = vi.fn((_text: string, opts: { abortSignal?: AbortSignal }) => {
    signals.push(opts.abortSignal);
    return (async function* () {
      for (const e of events) {
        await Promise.resolve();
        yield e;
      }
    })();
  });
  return { loop: { run } as unknown as AgentLoop, run, signals };
}

/** Loop that never completes on its own — only an abort ends it. */
function makeNeverEndingLoop(): {
  loop: AgentLoop;
  run: ReturnType<typeof vi.fn>;
  signals: Array<AbortSignal | undefined>;
} {
  const signals: Array<AbortSignal | undefined> = [];
  const run = vi.fn((_text: string, opts: { abortSignal?: AbortSignal }) => {
    signals.push(opts.abortSignal);
    return (async function* () {
      while (!opts.abortSignal?.aborted) {
        await new Promise((r) => setTimeout(r, 5));
        yield { type: 'text_delta', text: 'thinking...' };
      }
    })();
  });
  return { loop: { run } as unknown as AgentLoop, run, signals };
}

/** Loop that emits one expensive usage event, then runs forever until aborted. */
function makeCostLoop(cost: number): {
  loop: AgentLoop;
  run: ReturnType<typeof vi.fn>;
  signals: Array<AbortSignal | undefined>;
} {
  const signals: Array<AbortSignal | undefined> = [];
  const run = vi.fn((_text: string, opts: { abortSignal?: AbortSignal }) => {
    signals.push(opts.abortSignal);
    return (async function* () {
      yield { type: 'usage', inputTokens: 1, outputTokens: 1, estimatedCostUsd: cost };
      while (!opts.abortSignal?.aborted) {
        await new Promise((r) => setTimeout(r, 5));
        yield { type: 'text_delta', text: 'x' };
      }
    })();
  });
  return { loop: { run } as unknown as AgentLoop, run, signals };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackgroundExecutor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('claims a queued job and runs it to done with the extracted summary and spend', async () => {
    const store = new SQLiteJobStore(':memory:');
    const finalText = 'Did the work.\n\n## Summary\nAll done well.';
    const { loop } = makeStaticLoop([
      { type: 'usage', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.5 },
      { type: 'text_delta', text: finalText },
      { type: 'done', text: finalText, turnCount: 1 },
    ]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });

    const done = await store.get(job.id);
    expect(done?.summary).toBe('All done well.');
    expect(done?.spendUsd).toBe(0.5);

    const events = await store.getEvents(job.id);
    expect(events[events.length - 1]?.eventType).toBe('done');

    await exec.shutdown();
  });

  it('aborts and fails a job that breaches max_cost_usd', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop, signals } = makeCostLoop(10);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput({ maxCostUsd: 1 }));

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('failed'), {
      timeout: 2000,
    });

    const failed = await store.get(job.id);
    expect(failed?.error).toContain('exceeded max_cost_usd');
    expect(signals[0]?.aborted).toBe(true);

    await exec.shutdown();
  });

  it('aborts a running job when cancel is requested on the next heartbeat', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop, signals } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('running'), {
      timeout: 2000,
    });

    await store.requestCancel(job.id);

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('aborted'), {
      timeout: 2000,
    });

    const aborted = await store.get(job.id);
    expect(aborted?.error).toBe('cancelled by task_cancel');
    expect(signals[0]?.aborted).toBe(true);

    await exec.shutdown();
  });

  it('pauses the heartbeat while a run is parked, and resumes it on answer (G4/D21)', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('running'), {
      timeout: 2000,
    });

    const beats = vi.spyOn(store, 'heartbeat');
    await exec.markJobBlocked(job.id, 'clarify-1');
    expect((await store.get(job.id))?.status).toBe('blocked');

    // Several heartbeat intervals pass with no beat — which is what makes the
    // row invisible to reclaimStale rather than a dead host.
    await new Promise((r) => setTimeout(r, cfg().heartbeatMs * 6));
    expect(beats).not.toHaveBeenCalled();
    expect(await store.reclaimStale(0)).toHaveLength(0);
    expect((await store.get(job.id))?.status).toBe('blocked');

    await exec.resumeJob(job.id);
    expect((await store.get(job.id))?.status).toBe('running');
    await vi.waitFor(() => expect(beats).toHaveBeenCalled(), { timeout: 2000 });

    await exec.shutdown();
  });

  it('keeps a parked run cancellable — blocked → aborted', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('running'), {
      timeout: 2000,
    });

    await exec.markJobBlocked(job.id, 'clarify-1');
    await store.requestCancel(job.id);

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('aborted'), {
      timeout: 2000,
    });
    expect((await store.get(job.id))?.blockedRequestId).toBeUndefined();

    await exec.shutdown();
  });

  // I20 (Phase 5) — the abort listener. Cancelling a run must WITHDRAW the
  // question it is parked on, not just abort the controller: otherwise the card
  // stays live on someone's phone for the rest of its (now 24 h) window, and
  // the escalator's `finally` — which un-pauses the heartbeat — never runs.
  it('withdraws a cancelled run’s pending questions, whatever caused the abort', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeNeverEndingLoop();
    const cancelled: string[] = [];
    const exec = new BackgroundExecutor({
      store,
      loop,
      owner: OWNER,
      config: cfg(),
      cancelInteractions: async (jobId) => {
        cancelled.push(jobId);
      },
    });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('running'), {
      timeout: 2000,
    });

    await exec.markJobBlocked(job.id, 'clarify-1');
    await store.requestCancel(job.id);

    await vi.waitFor(() => expect(cancelled).toEqual([job.id]), { timeout: 2000 });
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('aborted'), {
      timeout: 2000,
    });

    await exec.shutdown();
  });

  it('ignores markJobBlocked for a job this executor is not running', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    // Claimed by a peer process, never by this executor's pool.
    const job = await store.create(createInput({ owner: 'peer' }));
    await store.claimNextQueued('peer');

    await exec.markJobBlocked(job.id, 'clarify-1');
    expect((await store.get(job.id))?.status).toBe('running');

    await exec.shutdown();
  });

  it('respects the pool size and claims the next job only after one finishes', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({
      store,
      loop,
      owner: OWNER,
      config: cfg({ maxConcurrentJobs: 1 }),
    });
    const job1 = await store.create(createInput({ childSessionKey: 'c1' }));
    const job2 = await store.create(createInput({ childSessionKey: 'c2' }));

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job1.id))?.status).toBe('running'), {
      timeout: 2000,
    });
    expect((await store.get(job2.id))?.status).toBe('queued');
    expect(exec.activeCount()).toBe(1);

    await store.requestCancel(job1.id);

    await vi.waitFor(async () => expect((await store.get(job2.id))?.status).toBe('running'), {
      timeout: 2000,
    });
    expect(exec.activeCount()).toBe(1);

    await exec.shutdown();
  });

  it('fails a job on the pre-start aggregate spend gate without running the child', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop, run } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({
      store,
      loop,
      owner: OWNER,
      config: cfg({ maxRootBackgroundUsd: 5 }),
    });

    // Pre-seed a finished sibling on the same root whose spend already meets the cap.
    const seed = await store.create(createInput({ childSessionKey: 'seed' }));
    await store.claimNextQueued(OWNER);
    await store.updateSpend(seed.id, 5);
    await store.finish(seed.id, 'done', { summary: 'seed' });

    const job = await store.create(createInput({ childSessionKey: 'c-new' }));

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('failed'), {
      timeout: 2000,
    });

    expect((await store.get(job.id))?.error).toContain('spend cap');
    expect(run).not.toHaveBeenCalled();

    await exec.shutdown();
  });

  it('boot sweep reclaims a stale running row', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeNeverEndingLoop();
    const job = await store.create(createInput());

    // Claim directly so it is running with a fresh heartbeat — no executor ran it.
    await store.claimNextQueued(OWNER);
    expect((await store.get(job.id))?.status).toBe('running');

    // A fresh executor with a 0ms stale threshold treats any beat as stale on boot.
    const exec = new BackgroundExecutor({
      store,
      loop,
      owner: OWNER,
      config: cfg({ staleMs: 0 }),
    });
    exec.start();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('stale'), {
      timeout: 2000,
    });

    await exec.shutdown();
  });

  it('shutdown aborts an in-flight job and marks it aborted with the shutdown error', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop, signals } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    await vi.waitFor(() => expect(exec.activeCount()).toBe(1), { timeout: 2000 });

    await exec.shutdown();

    expect(exec.activeCount()).toBe(0);
    const j = await store.get(job.id);
    expect(j?.status).toBe('aborted');
    expect(j?.error).toBe('process shutdown');
    expect(signals[0]?.aborted).toBe(true);
  });

  it('fires onComplete with the finished job when a job reaches done', async () => {
    const store = new SQLiteJobStore(':memory:');
    const finalText = 'Did the work.\n\n## Summary\nAll done well.';
    const { loop } = makeStaticLoop([
      { type: 'usage', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.5 },
      { type: 'text_delta', text: finalText },
      { type: 'done', text: finalText, turnCount: 1 },
    ]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const completed: BackgroundJob[] = [];
    exec.onComplete((j) => completed.push(j));
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    await vi.waitFor(() => expect(completed.length).toBe(1), { timeout: 2000 });
    expect(completed[0]?.id).toBe(job.id);
    expect(completed[0]?.status).toBe('done');
    expect(completed[0]?.summary).toBe('All done well.');

    await exec.shutdown();
  });

  it('fires onComplete on a failed job (cost breach)', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeCostLoop(10);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const completed: BackgroundJob[] = [];
    exec.onComplete((j) => completed.push(j));
    const job = await store.create(createInput({ maxCostUsd: 1 }));

    exec.start();
    exec.nudge();

    await vi.waitFor(() => expect(completed.length).toBe(1), { timeout: 2000 });
    expect(completed[0]?.id).toBe(job.id);
    expect(completed[0]?.status).toBe('failed');
    expect(completed[0]?.error).toContain('exceeded max_cost_usd');

    await exec.shutdown();
  });

  it('fires onComplete on an aborted job (cancel)', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeNeverEndingLoop();
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const completed: BackgroundJob[] = [];
    exec.onComplete((j) => completed.push(j));
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('running'), {
      timeout: 2000,
    });
    await store.requestCancel(job.id);

    await vi.waitFor(() => expect(completed.length).toBe(1), { timeout: 2000 });
    expect(completed[0]?.id).toBe(job.id);
    expect(completed[0]?.status).toBe('aborted');

    await exec.shutdown();
  });

  it('unsubscribe stops further onComplete callbacks', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeStaticLoop([{ type: 'done', text: 'x', turnCount: 1 }]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const completed: BackgroundJob[] = [];
    const unsub = exec.onComplete((j) => completed.push(j));
    const job1 = await store.create(createInput({ childSessionKey: 'c1' }));

    exec.start();
    exec.nudge();

    await vi.waitFor(() => expect(completed.length).toBe(1), { timeout: 2000 });
    expect(completed[0]?.id).toBe(job1.id);

    unsub();
    const job2 = await store.create(createInput({ childSessionKey: 'c2' }));
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job2.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    expect(completed.length).toBe(1);

    await exec.shutdown();
  });

  it('fires the on_background_job_complete void hook on terminal when hooks are wired', async () => {
    const store = new SQLiteJobStore(':memory:');
    const finalText = 'work\n\n## Summary\ndone';
    const { loop } = makeStaticLoop([
      { type: 'text_delta', text: finalText },
      { type: 'done', text: finalText, turnCount: 1 },
    ]);
    const fireVoid = vi.fn((_name: string, _payload: unknown) => Promise.resolve());
    const hooks = { fireVoid } as unknown as HookRegistry;
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg(), hooks });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    await vi.waitFor(() => expect(fireVoid).toHaveBeenCalled(), { timeout: 2000 });

    const call = fireVoid.mock.calls.find((c) => c[0] === 'on_background_job_complete');
    expect(call).toBeDefined();
    const payload = call?.[1] as { job: BackgroundJob };
    expect(payload.job.id).toBe(job.id);
    expect(payload.job.status).toBe('done');

    await exec.shutdown();
  });

  it('prunes old terminal rows at boot when retentionMs is set', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeStaticLoop([]);
    const job = await store.create(createInput());
    await store.claimNextQueued(OWNER); // queued -> running
    await store.finish(job.id, 'done', { summary: 'done' });
    expect((await store.get(job.id))?.status).toBe('done');

    // Let finishedAt fall comfortably behind the retention cutoff.
    await new Promise((r) => setTimeout(r, 20));

    const spy = vi.spyOn(store, 'pruneTerminal');
    const exec = new BackgroundExecutor({
      store,
      loop,
      owner: OWNER,
      config: cfg({ retentionMs: 1 }),
    });
    exec.start();

    await vi.waitFor(async () => expect(await store.get(job.id)).toBeNull(), { timeout: 2000 });
    expect(spy).toHaveBeenCalled();

    await exec.shutdown();
  });

  it('leaves terminal rows untouched when retentionMs is absent', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeStaticLoop([]);
    const job = await store.create(createInput());
    await store.claimNextQueued(OWNER);
    await store.finish(job.id, 'done', { summary: 'done' });

    const spy = vi.spyOn(store, 'pruneTerminal');
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    exec.start();

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
    expect((await store.get(job.id))?.status).toBe('done');

    await exec.shutdown();
  });

  // -------------------------------------------------------------------------
  // Live transcript (item 10) — the child's narrative is durable WHILE it runs
  // -------------------------------------------------------------------------

  it("persists the child's text incrementally — a running job's stream grows between reads", async () => {
    const store = new SQLiteJobStore(':memory:');
    let openGate1!: () => void;
    let openGate2!: () => void;
    const gate1 = new Promise<void>((r) => {
      openGate1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      openGate2 = r;
    });
    const chunk = 'x'.repeat(2_500);
    const run = vi.fn(() =>
      (async function* () {
        yield { type: 'text_delta', text: chunk };
        await gate1;
        yield { type: 'text_delta', text: chunk };
        await gate2;
        yield { type: 'done', text: '', turnCount: 1 };
      })(),
    );
    const exec = new BackgroundExecutor({
      store,
      loop: { run } as unknown as AgentLoop,
      owner: OWNER,
      config: cfg(),
    });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();

    const textEvents = async () =>
      (await store.getEvents(job.id)).filter((e) => e.eventType === 'text');

    // Read #1, mid-run: the opening text is ALREADY durable. Before this change
    // it lived only in a local accumulator and died with the process.
    await vi.waitFor(async () => expect((await textEvents()).length).toBe(1), { timeout: 2000 });
    expect((await store.get(job.id))?.status).toBe('running');
    // Chunked, not one row per delta: a 2500-char delta lands as one full chunk
    // plus a 500-char remainder still buffered.
    expect(String((await textEvents())[0]?.payload.text)).toHaveLength(2_000);

    // Read #2, still mid-run: the stream has grown.
    openGate1();
    await vi.waitFor(async () => expect((await textEvents()).length).toBe(2), { timeout: 2000 });
    expect((await store.get(job.id))?.status).toBe('running');

    // The tail is flushed before the terminal transition — nothing is dropped.
    openGate2();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    const persisted = (await textEvents()).map((e) => String(e.payload.text)).join('');
    expect(persisted).toBe(chunk + chunk);

    await exec.shutdown();
  });

  it('records a tool_end event after each tool_headline, carrying ok/duration/error', async () => {
    const store = new SQLiteJobStore(':memory:');
    const { loop } = makeStaticLoop([
      { type: 'tool_start', toolCallId: 't1', toolName: 'read_file', args: { path: 'a.txt' } },
      {
        type: 'tool_end',
        toolCallId: 't1',
        toolName: 'read_file',
        ok: false,
        durationMs: 12,
        error: 'boom',
      },
      { type: 'text_delta', text: 'wrapped up' },
      { type: 'done', text: 'wrapped up', turnCount: 1 },
    ]);
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput());

    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });

    const events = await store.getEvents(job.id);
    const headlineIdx = events.findIndex((e) => e.eventType === 'tool_headline');
    const endIdx = events.findIndex((e) => e.eventType === 'tool_end');
    expect(headlineIdx).toBeGreaterThanOrEqual(0);
    // The call's outcome reads after the call, not before it.
    expect(endIdx).toBeGreaterThan(headlineIdx);
    expect(events[endIdx]?.payload).toMatchObject({
      toolName: 'read_file',
      ok: false,
      durationMs: 12,
      error: 'boom',
    });

    await exec.shutdown();
  });
});
