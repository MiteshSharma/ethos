import type { AgentLoop } from '@ethosagent/core';
import { DefaultJobRunnerRegistry } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  AgentEvent,
  BackgroundJob,
  CreateBackgroundJobInput,
  DetailRow,
  JobRunner,
  JobRunnerContext,
  RunnerCapabilities,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor, type BackgroundExecutorConfig } from '../index';
import { BoundedLogBuffer } from '../log-buffer';

// ---------------------------------------------------------------------------
// T1 / I-LOG1 — the runner-agnostic log sink.
//
// `JobRunnerContext.appendLog` batches a runner subprocess's own stdout/stderr
// into bounded `runner_log` job_events instead of one write per line. Three
// things need proving: the oldest-dropped-first cap on the buffer, and both
// independent flush triggers (line count, then time).
// ---------------------------------------------------------------------------

describe('BoundedLogBuffer', () => {
  it('drops the OLDEST line first once the cap is hit, keeping the freshest', () => {
    const buf = new BoundedLogBuffer(5);
    for (let i = 1; i <= 8; i++) buf.push({ stream: 'stdout', line: `line ${i}` });

    expect(buf.length).toBe(5);
    expect(buf.dropped).toBe(3);
    const { entries, dropped } = buf.drain();
    // Lines 1-3 were evicted to make room; 4-8 are what's left, oldest-first.
    expect(entries.map((e) => e.line)).toEqual(['line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
    expect(dropped).toBe(3);

    // draining resets both the buffer and the drop counter.
    expect(buf.length).toBe(0);
    expect(buf.dropped).toBe(0);
  });

  it('never drops when pushes stay within the cap', () => {
    const buf = new BoundedLogBuffer(3);
    buf.push({ stream: 'stderr', line: 'a' });
    buf.push({ stream: 'stderr', line: 'b' });
    expect(buf.length).toBe(2);
    expect(buf.dropped).toBe(0);
  });
});

const OWNER = 'owner-runner-log';

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
    rootSessionKey: 'root-runner-log',
    childSessionKey: 'child-runner-log',
    depth: 1,
    prompt: 'produce some logs',
    ...over,
  };
}

const CAPABILITIES: RunnerCapabilities = {
  interactionKinds: ['confirm'],
  answerScopes: ['once'],
  takeover: 'none',
  resume: 'none',
  steer: false,
  sandbox: 'external',
  transport: 'fake · in-test',
};

const loop = {
  run: () => {
    throw new Error('the default Ethos runner must not run this job');
  },
} as unknown as AgentLoop;

/** A runner that calls `ctx.appendLog` a fixed number of times, synchronously, before finishing. */
class BurstLogRunner implements JobRunner {
  readonly name = 'burst-log-fake';
  readonly capabilities = CAPABILITIES;

  constructor(private readonly lineCount: number) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  describe(): DetailRow[] {
    return [];
  }

  async *run(_job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    for (let i = 0; i < this.lineCount; i++) ctx.appendLog('stdout', `line ${i}`);
    const text = 'wrote logs\n\n## Summary\ndone';
    yield { type: 'text_delta', text };
    yield { type: 'done', text, turnCount: 1 };
  }
}

/** A runner that logs a few lines, then holds the run open past the 250ms flush window. */
class SlowLogRunner implements JobRunner {
  readonly name = 'slow-log-fake';
  readonly capabilities = CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  describe(): DetailRow[] {
    return [];
  }

  async *run(_job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    ctx.appendLog('stderr', 'warming up');
    ctx.appendLog('stderr', 'still below the line-count trigger');
    // Held open well past the 250ms window so a flush that happens on its own
    // — before the run ever finishes — can only be explained by the timer,
    // not by the terminal-transition catch-all flush.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const text = 'done\n\n## Summary\ndone';
    yield { type: 'text_delta', text };
    yield { type: 'done', text, turnCount: 1 };
  }
}

async function setup(runner: JobRunner) {
  const store = new SQLiteJobStore(':memory:');
  const registry = new DefaultJobRunnerRegistry();
  registry.register(runner.name, () => runner);
  await registry.resolve(runner.name, {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => {
        throw new Error('unused');
      },
    },
  });

  const exec = new BackgroundExecutor({
    store,
    loop,
    runners: registry,
    owner: OWNER,
    config: cfg(),
  });
  const job = await store.create(createInput({ runner: runner.name }));
  return { store, exec, job };
}

describe('runner_log delivery', () => {
  it('flushes on the LINE-COUNT trigger, batching in fixed-size groups', async () => {
    // 45 lines: two full 20-line batches flush mid-run on their own, and the
    // remaining 5 flush once via the terminal-transition catch-all.
    const { store, exec, job } = await setup(new BurstLogRunner(45));
    exec.start();
    exec.nudge();
    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    await exec.shutdown();

    const events = await store.getEvents(job.id, { limit: 200 });
    const logRows = events.filter((e) => e.eventType === 'runner_log');
    expect(logRows.map((e) => (e.payload.lines as unknown[]).length)).toEqual([20, 20, 5]);
    // No lines were dropped — 45 is well under the retention cap.
    expect(logRows.every((e) => e.payload.dropped === undefined)).toBe(true);
    store.close();
  });

  it('flushes on the 250ms TIME trigger even without reaching the line-count trigger', async () => {
    const { store, exec, job } = await setup(new SlowLogRunner());
    exec.start();
    exec.nudge();

    // Caught while the job is still running: the flush happened on its own,
    // not as part of the terminal transition (the runner is still asleep).
    await vi.waitFor(
      async () => {
        const fresh = await store.get(job.id);
        expect(fresh?.status).toBe('running');
        const events = await store.getEvents(job.id, { limit: 50 });
        const logRow = events.find((e) => e.eventType === 'runner_log');
        expect(logRow).toBeDefined();
        expect(logRow?.payload.lines).toEqual([
          { stream: 'stderr', line: 'warming up' },
          { stream: 'stderr', line: 'still below the line-count trigger' },
        ]);
      },
      { timeout: 2000 },
    );

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });
    await exec.shutdown();
    store.close();
  });
});
