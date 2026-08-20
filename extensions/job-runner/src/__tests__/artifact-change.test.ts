import type { AgentLoop } from '@ethosagent/core';
import { DefaultJobRunnerRegistry } from '@ethosagent/core';
import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  AgentEvent,
  ArtifactChange,
  BackgroundJob,
  CreateBackgroundJobInput,
  DetailRow,
  JobRunner,
  JobRunnerContext,
  RunnerCapabilities,
} from '@ethosagent/types';
import { KNOWN_AGENT_EVENT_TYPES } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundExecutor, type BackgroundExecutorConfig } from '../index';

// ---------------------------------------------------------------------------
// T21 — `artifact.change` delivery (G7/D3).
//
// A runner's file changes reach the persisted job event log as `artifact_change`
// ROWS, which is what the inspector's Diff tab reads. The other half of D3 is
// the negative: `AgentEvent` gains nothing — no eighteenth variant, no artifact
// slot — so the union's drift gate must still read 17.
// ---------------------------------------------------------------------------

const OWNER = 'owner-artifact';

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
    rootSessionKey: 'root-artifact',
    childSessionKey: 'child-artifact',
    depth: 1,
    prompt: 'change some files',
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

const HUGE_DIFF = `@@ -1 +1 @@\n${'+a'.repeat(30_000)}`;

/** A runner that reports file changes the only way a runner can: `emitArtifact`. */
class ArtifactRunner implements JobRunner {
  readonly name = 'artifact-fake';
  readonly capabilities = CAPABILITIES;

  constructor(private readonly changes: ArtifactChange[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  describe(): DetailRow[] {
    return [];
  }

  async *run(_job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent> {
    for (const change of this.changes) ctx.emitArtifact(change);
    const text = 'edited\n\n## Summary\nTouched two files.';
    yield { type: 'text_delta', text };
    yield { type: 'done', text, turnCount: 1 };
  }
}

const loop = {
  run: () => {
    throw new Error('the default Ethos runner must not run this job');
  },
} as unknown as AgentLoop;

async function runWith(changes: ArtifactChange[]) {
  const store = new SQLiteJobStore(':memory:');
  const registry = new DefaultJobRunnerRegistry();
  const runner = new ArtifactRunner(changes);
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
  exec.start();
  exec.nudge();
  await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe('done'), {
    timeout: 2000,
  });
  await exec.shutdown();
  return { store, job };
}

describe('artifact_change delivery', () => {
  it('persists every emitArtifact call as a queryable artifact_change row', async () => {
    const { store, job } = await runWith([
      { path: 'src/a.ts', change: 'modified', added: 12, removed: 3, diff: '@@ -1 +1 @@\n+a' },
      { path: 'src/gone.ts', change: 'deleted', added: 0, removed: 40 },
    ]);

    // Read back through the bounded tail read the inspector itself uses (I21).
    const events = await store.getEvents(job.id, { limit: 200 });
    const artifacts = events.filter((e) => e.eventType === 'artifact_change');

    expect(artifacts.map((e) => e.payload)).toEqual([
      { path: 'src/a.ts', change: 'modified', added: 12, removed: 3, diff: '@@ -1 +1 @@\n+a' },
      { path: 'src/gone.ts', change: 'deleted', added: 0, removed: 40 },
    ]);
    // A file with no diff to give persists its counts and says nothing more —
    // the executor never invents a diff on a runner's behalf.
    expect(artifacts[1]?.payload.diff).toBeUndefined();
    // The rows survive the run: the job is terminal and they are still there.
    expect((await store.get(job.id))?.status).toBe('done');
    store.close();
  });

  it('caps a runaway diff body while keeping the file line counts exact', async () => {
    const { store, job } = await runWith([
      {
        path: 'dist/bundle.js',
        change: 'modified',
        added: 40_000,
        removed: 39_000,
        diff: HUGE_DIFF,
      },
    ]);

    const [artifact] = (await store.getEvents(job.id, { limit: 200 })).filter(
      (e) => e.eventType === 'artifact_change',
    );
    const diff = String(artifact?.payload.diff ?? '');
    expect(diff.length).toBeLessThanOrEqual(20_000);
    expect(diff.endsWith('[truncated]')).toBe(true);
    expect(artifact?.payload.added).toBe(40_000);
    expect(artifact?.payload.removed).toBe(39_000);
    store.close();
  });

  it('adds no AgentEvent variant — the union is still frozen at 17', () => {
    expect(KNOWN_AGENT_EVENT_TYPES).toHaveLength(17);
    expect((KNOWN_AGENT_EVENT_TYPES as readonly string[]).some((t) => t.includes('artifact'))).toBe(
      false,
    );
  });
});
