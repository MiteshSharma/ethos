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
  Logger,
  RunnerCapabilities,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor, type BackgroundExecutorConfig } from '../index';

// ---------------------------------------------------------------------------
// T26 (scoped to this layer) — second-runner acceptance.
//
// A runner with a DIFFERENT vocabulary from Ethos's — one interaction kind
// (`confirm`), no takeover, no resume, no steering, an external sandbox and its
// own transport — registers through the registry and runs a job end-to-end
// through the executor using ONLY the three-member JobRunner interface.
//
// What this proves at this layer: neither the registry nor the executor knows
// anything Ethos-specific. The parts of T26 that need Phase 3's UI and Phase
// 4's kind router (unknown kinds via the default path, hidden Take over /
// Resume / Interrupt buttons) are asserted where those exist.
// ---------------------------------------------------------------------------

const OWNER = 'owner-second';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

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
    rootSessionKey: 'root-second',
    childSessionKey: 'child-second',
    depth: 1,
    prompt: 'do the thing',
    ...over,
  };
}

const SECOND_CAPABILITIES: RunnerCapabilities = {
  interactionKinds: ['confirm'],
  answerScopes: ['once'],
  takeover: 'none',
  resume: 'none',
  steer: false,
  sandbox: 'external',
  transport: 'fake · in-test',
};

/** A runner that shares nothing with Ethos but the interface. */
class SecondFakeRunner implements JobRunner {
  readonly name = 'second-fake';
  readonly capabilities = SECOND_CAPABILITIES;
  /** Jobs this runner was actually handed — the proof it, not Ethos, ran them. */
  readonly ran: string[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  describe(job: BackgroundJob): DetailRow[] {
    return [
      { label: 'harness', value: 'second-fake' },
      { label: 'workspace', value: `/tmp/${job.id}`, tone: 'safe' },
    ];
  }

  async *run(job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    this.ran.push(job.id);
    ctx.emitArtifact({ path: 'README.md', change: 'modified', added: 2, removed: 1 });
    yield { type: 'usage', inputTokens: 3, outputTokens: 4, estimatedCostUsd: 0.25 };
    const text = 'worked on it\n\n## Summary\nSecond runner did the job.';
    yield { type: 'text_delta', text };
    yield { type: 'done', text, turnCount: 1 };
  }
}

/** The loop dep only ever backs the DEFAULT runner; a second-runner job must not touch it. */
const loop = {
  run: () => {
    throw new Error('the default Ethos runner must not run a second-runner job');
  },
} as unknown as AgentLoop;

describe('second runner acceptance', () => {
  it('registers, resolves, and runs a job end-to-end through the registry', async () => {
    const store = new SQLiteJobStore(':memory:');
    const registry = new DefaultJobRunnerRegistry();
    const second = new SecondFakeRunner();
    registry.register(second.name, () => second);

    expect(registry.list()).toEqual(['second-fake']);
    // Registered is not resolved — the executor and the tool both read instances.
    expect(registry.get('second-fake')).toBeUndefined();
    const resolved = await registry.resolve('second-fake', { logger: noopLogger });
    expect(resolved).toBe(second);
    expect(registry.get('second-fake')).toBe(second);

    const exec = new BackgroundExecutor({
      store,
      loop,
      runners: registry,
      owner: OWNER,
      config: cfg(),
    });
    const job = await store.create(createInput({ runner: 'second-fake' }));
    expect(job.runner).toBe('second-fake');

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
      timeout: 2000,
    });

    const done = await store.get(job.id);
    // The executor's own bookkeeping — summary extraction, spend, audit trail —
    // works identically on a runner it has never heard of.
    expect(done?.summary).toBe('Second runner did the job.');
    expect(done?.spendUsd).toBe(0.25);
    expect(done?.runner).toBe('second-fake');
    expect(second.ran).toEqual([job.id]);

    const events = await store.getEvents(job.id);
    expect(events.some((e) => e.eventType === 'text')).toBe(true);
    expect(events[events.length - 1]?.eventType).toBe('done');

    await exec.shutdown();
  });

  it('fails a job whose runner this process has not resolved, without falling back to Ethos', async () => {
    const store = new SQLiteJobStore(':memory:');
    const exec = new BackgroundExecutor({ store, loop, owner: OWNER, config: cfg() });
    const job = await store.create(createInput({ runner: 'nobody-registered-this' }));

    exec.start();
    exec.nudge();

    await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('failed'), {
      timeout: 2000,
    });
    expect((await store.get(job.id))?.error).toContain('nobody-registered-this');

    await exec.shutdown();
  });

  it("runs a row naming the default runner, and a row naming none, on the loop's runner", async () => {
    const store = new SQLiteJobStore(':memory:');
    const seen: string[] = [];
    const defaultLoop = {
      run: (text: string) => {
        seen.push(text);
        return (async function* () {
          yield { type: 'done', text: 'ok', turnCount: 1 };
        })();
      },
    } as unknown as AgentLoop;
    const exec = new BackgroundExecutor({
      store,
      loop: defaultLoop,
      owner: OWNER,
      config: cfg(),
    });
    const explicit = await store.create(createInput({ runner: 'ethos', childSessionKey: 'c1' }));
    const implicit = await store.create(createInput({ childSessionKey: 'c2' }));

    exec.start();
    exec.nudge();

    await vi.waitFor(
      async () => {
        expect((await store.get(explicit.id))?.status).toBe('done');
        expect((await store.get(implicit.id))?.status).toBe('done');
      },
      { timeout: 2000 },
    );
    expect(seen).toHaveLength(2);

    await exec.shutdown();
  });
});
