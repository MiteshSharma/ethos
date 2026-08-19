// I5 (pi-delegation plan Phase 1, D10) — the FakeJobRunner harness. Proves the
// composed chain — clarify tool → ClarifyBridge → BackgroundExecutor →
// SQLiteJobStore — actually works end to end, not just each piece in
// isolation. This is Phase 1's own test harness (no Pi, no worker-router; the
// full-vocabulary elicitation router is Phase 4) and doubles as the base a
// later phase's router integration test extends.
//
// Mirrors `integration.test.ts`'s `makeLoop()` pattern: a scripted
// `AgentLoop.run()` async generator rather than a real LLM turn calling the
// real `clarify` tool. What makes this a "FakeJobRunner" rather than just
// another mock loop is that its script drives THREE sequential clarify
// requests through the REAL `ClarifyBridge`, reading `opts.jobId` off the
// exact `RunOptions` the real `BackgroundExecutor.runOne` passes — the same
// plumbing a real `clarify` tool call would see via `ToolContext.jobId` (D22).

import type { AgentLoop, ClarifyRequestInput } from '@ethosagent/core';
import { ClarifyBridge, FileClarifyStore } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { createDelegationTools } from '@ethosagent/tools-delegation';
import type { PendingClarify, Storage, Tool, ToolContext } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor } from '../index';

/** A scripted "runner" whose child turn asks three questions in sequence
 *  through the real bridge before finishing — the D10 done-when claim. */
function makeFakeJobRunnerLoop(bridge: ClarifyBridge): AgentLoop {
  return {
    run: vi.fn((_prompt: string, opts: { sessionKey?: string; jobId?: string }) =>
      (async function* () {
        const ask = async (question: string): Promise<string> => {
          const res = await bridge.request({
            question,
            timeoutMs: 900_000,
            answerableBy: 'anyone',
            sessionId: opts.sessionKey ?? 'unknown',
            jobId: opts.jobId,
            surfaceType: 'cli',
          });
          return res.answer;
        };

        const a1 = await ask('Which database?');
        const a2 = await ask('Confirm the migration?');
        const a3 = await ask('Name for the new table?');

        yield {
          type: 'text_delta',
          text: `answers: ${a1}, ${a2}, ${a3}\n\n## Summary\nall three answered`,
        };
        yield { type: 'usage', estimatedCostUsd: 0.01, inputTokens: 1, outputTokens: 1 };
        yield {
          type: 'done',
          text: `answers: ${a1}, ${a2}, ${a3}\n\n## Summary\nall three answered`,
          turnCount: 1,
        };
      })(),
    ),
  } as unknown as AgentLoop;
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    personalityId: 'me',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}

describe('FakeJobRunner — three sequential clarify questions in one background job (D10/T19)', () => {
  let executor: BackgroundExecutor;

  afterEach(async () => {
    await executor.shutdown();
    vi.restoreAllMocks();
  });

  it('presents and resolves all three questions in order, with jobId on every row', async () => {
    const clarifyStore = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    const bridge = new ClarifyBridge(clarifyStore);

    const presented: PendingClarify[] = [];
    // Scripted human presenter — answers each question as soon as it's shown,
    // proving the queue drains and each question gets its own presentation.
    bridge.registerPresenter('cli', (req) => {
      presented.push(req);
      const answer = { 0: 'postgres', 1: 'yes', 2: 'users_v2' }[presented.length - 1] ?? 'x';
      void bridge.respond({ requestId: req.requestId, answer, source: 'user' });
    });

    const loop = makeFakeJobRunnerLoop(bridge);
    const store = new SQLiteJobStore(':memory:');
    executor = new BackgroundExecutor({
      store,
      loop,
      owner: 'test',
      config: {
        maxConcurrentJobs: 2,
        staleMs: 90_000,
        heartbeatMs: 30_000,
        queuedTtlMs: 900_000,
        maxRootBackgroundUsd: 5.0,
        pollMs: 20,
      },
    });
    executor.start();

    const background = {
      store,
      nudge: () => executor.nudge(),
      owner: 'test',
      defaultMaxCostUsd: 1.0,
      maxJobsPerRoot: 3,
      maxJobsPerPersonality: 5,
      staleMs: 90_000,
    };
    const tools = createDelegationTools(loop, {} as unknown as Storage, undefined, background);
    const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
    const delegateTask = byName.get('delegate_task');
    const taskResult = byName.get('task_result');
    if (!delegateTask || !taskResult) throw new Error('expected delegation tools registered');

    const ctx = makeCtx();
    const spawn = await delegateTask.execute({ prompt: 'do the thing', background: true }, ctx);
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) throw new Error('delegate_task failed');
    const jobId = (JSON.parse(spawn.value) as { jobId: string }).jobId;

    await vi.waitFor(
      async () => {
        const s = await store.get(jobId);
        expect(s?.status).toBe('done');
      },
      { timeout: 3000 },
    );

    // All three presented, in order, each carrying the job's id (G1/D22) —
    // never a CLARIFY_BUSY rejection anywhere in the chain.
    expect(presented.map((r) => r.question)).toEqual([
      'Which database?',
      'Confirm the migration?',
      'Name for the new table?',
    ]);
    expect(presented.every((r) => r.jobId === jobId)).toBe(true);
    // Each was actually presented (not left queued) — deadline derived at
    // present time (D2), never null by the time the presenter saw it.
    expect(presented.every((r) => r.defaultDeadlineAt !== null)).toBe(true);

    const result = await taskResult.execute({ id: jobId }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('task_result failed');
    expect(result.value).toContain('all three answered');
  });

  // Note: `BackgroundExecutor` derives a unique `childSessionKey` per job
  // (`${parentSessionKey}:job:${label}:${id.slice(0,8)}`) even from the same
  // parent turn, so two concurrently-spawned jobs never share a literal
  // `sessionId` here — that per-job lane test (two different jobIds sharing
  // one MANUALLY-FIXED sessionId, i.e. the actual G1 collision scenario) lives
  // in `packages/core/src/__tests__/clarify.test.ts`. What THIS test proves is
  // the executor's own I4 plumbing: `BackgroundExecutor.runOne` really does
  // stamp a distinct `jobId` (from `job.id`) onto each concurrently-running
  // job's `RunOptions`, all the way down to a real `ClarifyBridge.request()`
  // call, with neither job's clarify blocking the other.
  it('stamps a distinct jobId onto each concurrently-running job, reaching a real clarify request', async () => {
    const clarifyStore = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
    const bridge = new ClarifyBridge(clarifyStore);
    const captured: ClarifyRequestInput[] = [];
    bridge.registerPresenter('cli', (req) => {
      void bridge.respond({ requestId: req.requestId, answer: 'ok', source: 'user' });
    });

    // Two independent single-question turns, each stamped with its own jobId
    // by the executor (I4) regardless of childSessionKey.
    function makeSingleAskLoop(): AgentLoop {
      return {
        run: vi.fn((_prompt: string, opts: { sessionKey?: string; jobId?: string }) =>
          (async function* () {
            const input: ClarifyRequestInput = {
              question: `question for ${opts.jobId}`,
              timeoutMs: 900_000,
              answerableBy: 'anyone',
              sessionId: opts.sessionKey ?? 'unknown',
              jobId: opts.jobId,
              surfaceType: 'cli',
            };
            captured.push(input);
            await bridge.request(input);
            yield { type: 'text_delta', text: '## Summary\ndone' };
            yield { type: 'usage', estimatedCostUsd: 0.01, inputTokens: 1, outputTokens: 1 };
            yield { type: 'done', text: '## Summary\ndone', turnCount: 1 };
          })(),
        ),
      } as unknown as AgentLoop;
    }

    const loop = makeSingleAskLoop();
    const store = new SQLiteJobStore(':memory:');
    executor = new BackgroundExecutor({
      store,
      loop,
      owner: 'test',
      config: {
        maxConcurrentJobs: 2,
        staleMs: 90_000,
        heartbeatMs: 30_000,
        queuedTtlMs: 900_000,
        maxRootBackgroundUsd: 5.0,
        pollMs: 20,
      },
    });
    executor.start();

    const background = {
      store,
      nudge: () => executor.nudge(),
      owner: 'test',
      defaultMaxCostUsd: 1.0,
      maxJobsPerRoot: 3,
      maxJobsPerPersonality: 5,
      staleMs: 90_000,
    };
    const tools = createDelegationTools(loop, {} as unknown as Storage, undefined, background);
    const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
    const delegateTask = byName.get('delegate_task');
    if (!delegateTask) throw new Error('expected delegate_task registered');

    const ctx = makeCtx(); // both spawned from the same parent turn
    const spawn1 = await delegateTask.execute({ prompt: 'task one', background: true }, ctx);
    const spawn2 = await delegateTask.execute({ prompt: 'task two', background: true }, ctx);
    expect(spawn1.ok && spawn2.ok).toBe(true);
    if (!spawn1.ok || !spawn2.ok) throw new Error('delegate_task failed');
    const jobId1 = (JSON.parse(spawn1.value) as { jobId: string }).jobId;
    const jobId2 = (JSON.parse(spawn2.value) as { jobId: string }).jobId;

    await vi.waitFor(
      async () => {
        const s1 = await store.get(jobId1);
        const s2 = await store.get(jobId2);
        expect(s1?.status).toBe('done');
        expect(s2?.status).toBe('done');
      },
      { timeout: 3000 },
    );

    // Both jobs' clarify calls completed without CLARIFY_BUSY — if either
    // had thrown, its job would be `failed`, not `done` (asserted above).
    expect(captured).toHaveLength(2);
    expect(captured.map((c) => c.jobId).sort()).toEqual([jobId1, jobId2].sort());
  });
});
