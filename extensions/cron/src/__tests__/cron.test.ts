import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronArmingBackend, CronJob, CronRunResult, CronSchedulerConfig } from '../index';
import { CronScheduler, isValidCronExpression, nextRun, nextRunAfter } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;
let scriptsDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-cron-test-${Date.now()}`);
  scriptsDir = join(testDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/** Drop an operator-authored fixture script into the temp scripts dir. */
async function writeScript(name: string, body: string): Promise<void> {
  await writeFile(join(scriptsDir, name), body, 'utf-8');
}

function makeScheduler(opts?: {
  runJob?: (job: CronJob) => Promise<CronRunResult>;
  deliver?: (job: CronJob, output: string) => Promise<void>;
  onDecision?: CronSchedulerConfig['onDecision'];
  armingBackend?: CronArmingBackend;
}) {
  return new CronScheduler({
    cronDir: testDir,
    scriptsDir,
    tickIntervalMs: 999_999, // don't auto-tick in tests
    storage: new FsStorage(),
    ...(opts?.armingBackend ? { armingBackend: opts.armingBackend } : {}),
    runJob:
      opts?.runJob ??
      (async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: `ran: ${job.prompt}`,
        sessionKey: `cron:${job.id}`,
      })),
    ...(opts?.deliver ? { deliver: opts.deliver } : {}),
    ...(opts?.onDecision ? { onDecision: opts.onDecision } : {}),
  });
}

// ---------------------------------------------------------------------------
// Cron expression helpers
// ---------------------------------------------------------------------------

describe('isValidCronExpression', () => {
  it('accepts valid expressions', () => {
    expect(isValidCronExpression('0 8 * * *')).toBe(true);
    expect(isValidCronExpression('0 8 * * 1-5')).toBe(true);
    expect(isValidCronExpression('*/15 * * * *')).toBe(true);
    expect(isValidCronExpression('0 0 1 * *')).toBe(true);
  });

  it('rejects invalid expressions', () => {
    expect(isValidCronExpression('not-a-cron')).toBe(false);
    expect(isValidCronExpression('60 8 * * *')).toBe(false);
    expect(isValidCronExpression('')).toBe(false);
  });
});

describe('nextRun', () => {
  it('returns a future date for a valid expression', () => {
    const result = nextRun('0 8 * * *');
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for invalid expression', () => {
    expect(nextRun('invalid')).toBeNull();
  });
});

describe('nextRunAfter', () => {
  it('returns a date strictly after the given anchor', () => {
    const anchor = new Date('2026-01-01T09:00:00Z'); // 9am UTC
    const result = nextRunAfter('0 8 * * *', anchor); // daily at 8am
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBeGreaterThan(anchor.getTime());
  });
});

// ---------------------------------------------------------------------------
// CronScheduler — job management
// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  it('creates a job and persists it', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Daily Brief',
      schedule: '0 8 * * *',
      prompt: 'Summarize the news',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
    });

    expect(job.id).toBe('daily-brief');
    expect(job.status).toBe('active');
    expect(job.nextRunAt).toBeTruthy();

    const jobs = await scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('Daily Brief');
  });

  it('rejects duplicate job ids', async () => {
    const scheduler = makeScheduler();
    await scheduler.createJob({
      name: 'My Job',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await expect(
      scheduler.createJob({
        name: 'My Job',
        schedule: '0 9 * * *',
        prompt: 'test2',
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow('already exists');
  });

  it('rejects invalid schedules', async () => {
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Bad',
        schedule: 'not-cron',
        prompt: 'x',
        personalityId: 'test',
        missedRunPolicy: 'skip',
        repeat: { kind: 'forever' },
      }),
    ).rejects.toThrow('Invalid schedule');
  });

  it('deletes a job', async () => {
    const scheduler = makeScheduler();
    await scheduler.createJob({
      name: 'To Delete',
      schedule: '0 8 * * *',
      prompt: 'x',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await scheduler.deleteJob('to-delete');
    expect(await scheduler.listJobs()).toHaveLength(0);
  });

  it('pauses and resumes a job', async () => {
    const scheduler = makeScheduler();
    await scheduler.createJob({
      name: 'Pauseable',
      schedule: '0 8 * * *',
      prompt: 'x',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    await scheduler.pauseJob('pauseable');
    expect((await scheduler.getJob('pauseable'))?.status).toBe('paused');

    await scheduler.resumeJob('pauseable');
    expect((await scheduler.getJob('pauseable'))?.status).toBe('active');
  });

  it('runJobNow executes and saves output', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runs.push(job.id);
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'test output',
          sessionKey: 'k',
        };
      },
    });

    await scheduler.createJob({
      name: 'Immediate',
      schedule: '0 8 * * *',
      prompt: 'go',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    const result = await scheduler.runJobNow('immediate');

    expect(result.output).toBe('test output');
    expect(runs).toContain('immediate');
  });

  it('lists empty jobs without error', async () => {
    const scheduler = makeScheduler();
    expect(await scheduler.listJobs()).toEqual([]);
  });

  it('returns null for unknown job', async () => {
    const scheduler = makeScheduler();
    expect(await scheduler.getJob('nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Repeat policy and updateJob
// ---------------------------------------------------------------------------

describe('CronScheduler repeat policy', () => {
  it('defaults to forever for cron schedules', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Cron Forever',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    expect(job.repeat).toEqual({ kind: 'forever' });
    expect(job.runCount).toBe(0);
  });

  it('defaults to once for relative delay schedules', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Delay Once',
      schedule: '30m',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    expect(job.repeat).toEqual({ kind: 'once' });
  });

  it('defaults to once for ISO timestamp schedules', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'ISO Once',
      schedule: '2099-06-01T09:00:00Z',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    expect(job.repeat).toEqual({ kind: 'once' });
  });

  it('defaults to forever for interval schedules', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Interval Forever',
      schedule: 'every 2h',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    expect(job.repeat).toEqual({ kind: 'forever' });
  });

  it('respects explicit repeat override', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Count Job',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      repeat: { kind: 'count', maxRuns: 3 },
    });
    expect(job.repeat).toEqual({ kind: 'count', maxRuns: 3 });
  });

  it('once-repeat job retires to done after one tick', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Fire Once',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      repeat: { kind: 'once' },
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).tick();

    const updated = await scheduler.getJob(job.id);
    expect(updated?.status).toBe('done');
    expect(updated?.runCount).toBe(1);
    expect(updated?.nextRunAt).toBeUndefined();
  });

  it('count-repeat job retires after maxRuns', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Count Two',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
      repeat: { kind: 'count', maxRuns: 2 },
    });

    // First tick
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).tick();

    let updated = await scheduler.getJob(job.id);
    expect(updated?.status).toBe('active');
    expect(updated?.runCount).toBe(1);

    // Second tick
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).tick();

    updated = await scheduler.getJob(job.id);
    expect(updated?.status).toBe('done');
    expect(updated?.runCount).toBe(2);
  });
});

describe('CronScheduler updateJob', () => {
  it('updates the schedule and recomputes nextRunAt', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Update Me',
      schedule: '0 8 * * *',
      prompt: 'old prompt',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    const updated = await scheduler.updateJob(job.id, { schedule: '0 9 * * *' });
    expect(updated.schedule).toBe('0 9 * * *');
    expect(updated.nextRunAt).toBeTruthy();
  });

  it('updates the name', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Old Name',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    const updated = await scheduler.updateJob(job.id, { name: 'New Name' });
    expect(updated.name).toBe('New Name');
  });

  it('updates the prompt', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Prompt Update',
      schedule: '0 8 * * *',
      prompt: 'old prompt',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    const updated = await scheduler.updateJob(job.id, { prompt: 'new prompt' });
    expect(updated.prompt).toBe('new prompt');
  });

  it('rejects update with no fields', async () => {
    const scheduler = makeScheduler();
    await scheduler.createJob({
      name: 'Empty Update',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    await expect(scheduler.updateJob('empty-update', {})).rejects.toThrow(
      'At least one of name, schedule, prompt, script, or precheck is required',
    );
  });

  it('rejects update with invalid schedule', async () => {
    const scheduler = makeScheduler();
    await scheduler.createJob({
      name: 'Bad Schedule Update',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    await expect(
      scheduler.updateJob('bad-schedule-update', { schedule: 'garbage' }),
    ).rejects.toThrow('Invalid schedule');
  });

  it('rejects update for non-existent job', async () => {
    const scheduler = makeScheduler();
    await expect(scheduler.updateJob('nope', { name: 'x' })).rejects.toThrow('Job not found');
  });

  it('switches repeat to once when schedule changes to one-shot', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Cron To Delay',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    expect(job.repeat.kind).toBe('forever');

    const updated = await scheduler.updateJob(job.id, { schedule: '30m' });
    expect(updated.repeat.kind).toBe('once');
  });
});

// ---------------------------------------------------------------------------
// Tick behaviour
// ---------------------------------------------------------------------------

describe('CronScheduler tick', () => {
  it('skip policy does not run overdue job', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runs.push(job.id);
        return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
      },
    });

    // Create a job that was due in the past
    const job = await scheduler.createJob({
      name: 'Overdue Skip',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    // Force nextRunAt to more than one tick interval in the past so the skip
    // policy fires (missedByMs > tickIntervalMs). The test scheduler uses
    // tickIntervalMs: 999_999, so we go 2 × that into the past.
    // Access internal method via cast
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 2_000_000).toISOString(),
    });

    // Manually trigger tick
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).tick();

    expect(runs).not.toContain('overdue-skip');

    // Next run should be updated to a future time
    const updated = await scheduler.getJob(job.id);
    if (!updated?.nextRunAt) throw new Error('expected updated.nextRunAt to be set');
    expect(new Date(updated.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('run-once policy runs overdue job', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runs.push(job.id);
        return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
      },
    });

    const job = await scheduler.createJob({
      name: 'Overdue Run',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).tick();

    expect(runs).toContain('overdue-run');
  });

  it('paused jobs are not run by tick', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runs.push(job.id);
        return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
      },
    });

    const job = await scheduler.createJob({
      name: 'Paused Job',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'paused',
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).tick();

    expect(runs).not.toContain('paused-job');
  });
});

// ---------------------------------------------------------------------------
// CronScheduler.fire() — the public CronEngine entry point a
// CronTriggerSource calls into (plan/phases/cron-scheduler-seam.md).
// ---------------------------------------------------------------------------

describe('CronScheduler.fire()', () => {
  it('runs the same due-scan/claim/execute cycle as the private tick()', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runs.push(job.id);
        return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
      },
    });

    const job = await scheduler.createJob({
      name: 'Fire Due Job',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await scheduler.fire();

    expect(runs).toContain('fire-due-job');
  });

  it('calls the arming backend with the earliest nextRunAt across active jobs after firing', async () => {
    const armCalls: Array<Date | null> = [];
    const armingBackend: CronArmingBackend = { arm: (next) => void armCalls.push(next) };
    const scheduler = makeScheduler({ armingBackend });

    const later = await scheduler.createJob({
      name: 'Arm Later Job',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    const sooner = await scheduler.createJob({
      name: 'Arm Sooner Job',
      schedule: '0 9 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    const laterAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const soonerAt = new Date(Date.now() + 60 * 60 * 1000);
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(later.id, { nextRunAt: laterAt.toISOString() });
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(sooner.id, { nextRunAt: soonerAt.toISOString() });

    await scheduler.fire();

    expect(armCalls).toHaveLength(1);
    expect(armCalls[0]?.getTime()).toBe(soonerAt.getTime());
  });

  it('arms null when no active job has a nextRunAt', async () => {
    const armCalls: Array<Date | null> = [];
    const armingBackend: CronArmingBackend = { arm: (next) => void armCalls.push(next) };
    const scheduler = makeScheduler({ armingBackend });

    await scheduler.fire();

    expect(armCalls).toHaveLength(1);
    expect(armCalls[0]).toBeNull();
  });

  it('a throwing arming backend never breaks the fire (fail-open)', async () => {
    const runs: string[] = [];
    const armingBackend: CronArmingBackend = {
      arm: () => {
        throw new Error('arming backend exploded');
      },
    };
    const scheduler = makeScheduler({
      armingBackend,
      runJob: async (job) => {
        runs.push(job.id);
        return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
      },
    });

    const job = await scheduler.createJob({
      name: 'Survives Arming Failure',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect(scheduler.fire()).resolves.toBeUndefined();
    expect(runs).toContain('survives-arming-failure');
  });
});

// ---------------------------------------------------------------------------
// CronScheduler.setArmingBackend() — the late-binding seam
// buildCronTriggers's construction order requires: buildCronTriggers needs
// the already-constructed CronScheduler as its `engine` arg, so the arming
// backend it produces can only be wired back in AFTER construction.
// ---------------------------------------------------------------------------

describe('CronScheduler.setArmingBackend()', () => {
  it('a backend set after construction is picked up by a subsequent fire()', async () => {
    const armCalls: Array<Date | null> = [];
    const scheduler = makeScheduler(); // no armingBackend at construction time

    const job = await scheduler.createJob({
      name: 'Late Bound Arming Job',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    const nextAt = new Date(Date.now() + 60 * 60 * 1000);
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, { nextRunAt: nextAt.toISOString() });

    // Set AFTER construction — mirrors serve.ts/gateway.ts calling
    // `scheduler.setArmingBackend(cronTriggers.arming)` right after
    // `buildCronTriggers(scheduler, config.cron)` returns.
    scheduler.setArmingBackend({ arm: (next) => void armCalls.push(next) });

    await scheduler.fire();

    expect(armCalls).toHaveLength(1);
    expect(armCalls[0]?.getTime()).toBe(nextAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// Concurrent tick() claims — real compare-and-swap (post-review fix). Two
// CronTriggerSources (LocalIntervalTrigger + HttpFireTrigger) firing the same
// engine close together in the hybrid deployment profile must not both win
// the claim on the same due job.
// ---------------------------------------------------------------------------

describe('CronScheduler concurrent claim (CAS)', () => {
  it('two overlapping fire() calls on the same due job execute it exactly once', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runs.push(job.id);
        // A little run latency gives both overlapping calls room to race.
        await new Promise((r) => setTimeout(r, 20));
        return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
      },
    });

    const job = await scheduler.createJob({
      name: 'Race Due Job',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'run-once',
    });
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // Simulate LocalIntervalTrigger's interval and HttpFireTrigger's
    // /cron/fire both calling into the same engine around the same moment.
    await Promise.all([scheduler.fire(), scheduler.fire()]);

    // Exactly one execution — not two. Before the fix, both calls' unlocked
    // readJobs() snapshots saw the same due nextRunAt and both patchJob
    // "claims" succeeded (last-write-wins), so the job ran twice.
    expect(runs).toEqual(['race-due-job']);
  });
});

// ---------------------------------------------------------------------------
// Job chaining (contextFrom)
// ---------------------------------------------------------------------------

describe('CronScheduler job chaining', () => {
  it('prepends referenced job output to prompt at fire time', async () => {
    const prompts: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: `output of ${job.id}`,
          sessionKey: 'k',
        };
      },
    });

    // Create a source job and run it so it has output
    const source = await scheduler.createJob({
      name: 'Source Job',
      schedule: '0 8 * * *',
      prompt: 'source prompt',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await scheduler.runJobNow(source.id);

    // Create a chained job referencing the source
    const chained = await scheduler.createJob({
      name: 'Chained Job',
      schedule: '0 9 * * *',
      prompt: 'chained prompt',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      contextFrom: [source.id],
    });
    await scheduler.runJobNow(chained.id);

    // The chained job's prompt should include the source's output
    const chainedPrompt = prompts.find((p) => p.includes('chained prompt'));
    expect(chainedPrompt).toContain('Context from "Source Job"');
    expect(chainedPrompt).toContain(`output of ${source.id}`);
  });

  it('silently skips references with no runs', async () => {
    const prompts: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: `output of ${job.id}`,
          sessionKey: 'k',
        };
      },
    });

    const source = await scheduler.createJob({
      name: 'Empty Source',
      schedule: '0 8 * * *',
      prompt: 'source',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    // Don't run the source — it has no output
    const chained = await scheduler.createJob({
      name: 'Chained No Output',
      schedule: '0 9 * * *',
      prompt: 'chained',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      contextFrom: [source.id],
    });

    // Should not throw — silently skips the empty reference
    await scheduler.runJobNow(chained.id);

    // The prompt should be just the original (no context prefix)
    const chainedPrompt = prompts.find((p) => p.includes('chained'));
    expect(chainedPrompt).toBe('chained');
  });

  it('rejects contextFrom with non-existent job at create time', async () => {
    const scheduler = makeScheduler();

    await expect(
      scheduler.createJob({
        name: 'Bad Chain',
        schedule: '0 8 * * *',
        prompt: 'test',
        personalityId: 'test',
        missedRunPolicy: 'skip',
        contextFrom: ['does-not-exist'],
      }),
    ).rejects.toThrow('contextFrom references unknown job');
  });

  it('resolves contextFrom by job name', async () => {
    const prompts: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: `output of ${job.id}`,
          sessionKey: 'k',
        };
      },
    });

    const source = await scheduler.createJob({
      name: 'Named Source',
      schedule: '0 8 * * *',
      prompt: 'source prompt',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await scheduler.runJobNow(source.id);

    // Reference by name instead of id
    const chained = await scheduler.createJob({
      name: 'Chained By Name',
      schedule: '0 9 * * *',
      prompt: 'chained prompt',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      contextFrom: ['Named Source'],
    });
    await scheduler.runJobNow(chained.id);

    const chainedPrompt = prompts.find((p) => p.includes('chained prompt'));
    expect(chainedPrompt).toContain('Context from "Named Source"');
  });
});

// ---------------------------------------------------------------------------
// Delivery callback
// ---------------------------------------------------------------------------

describe('CronScheduler delivery', () => {
  it('does not call deliver when job has no origin', async () => {
    const deliver = vi.fn();
    const scheduler = makeScheduler({ deliver });

    await scheduler.createJob({
      name: 'No Origin',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await scheduler.runJobNow('no-origin');

    expect(deliver).not.toHaveBeenCalled();
  });

  it('calls deliver when job has an origin', async () => {
    const deliver = vi.fn();
    const scheduler = makeScheduler({ deliver });

    await scheduler.createJob({
      name: 'With Origin',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '12345' },
    });
    await scheduler.runJobNow('with-origin');

    expect(deliver).toHaveBeenCalledOnce();
    const [job, output] = deliver.mock.calls[0] ?? [];
    expect(job.id).toBe('with-origin');
    expect(job.origin).toEqual({ platform: 'telegram', chatId: '12345' });
    expect(output).toContain('ran: test');
  });

  it('always writes audit file regardless of origin', async () => {
    const deliver = vi.fn();
    const scheduler = makeScheduler({ deliver });

    await scheduler.createJob({
      name: 'Audit Check',
      schedule: '0 8 * * *',
      prompt: 'audit test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'slack', chatId: 'C999' },
    });
    await scheduler.runJobNow('audit-check');

    // Audit file written (listRuns returns entries)
    const runs = await scheduler.listRuns('audit-check');
    expect(runs.length).toBeGreaterThan(0);

    // Delivery also called
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('delivery failure does not break job execution', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('network down'));
    const scheduler = makeScheduler({ deliver });

    await scheduler.createJob({
      name: 'Fail Deliver',
      schedule: '0 8 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '999' },
    });

    // Should not throw despite deliver failure
    const result = await scheduler.runJobNow('fail-deliver');
    expect(result.output).toContain('ran: test');

    // Audit file still written
    const runs = await scheduler.listRuns('fail-deliver');
    expect(runs.length).toBeGreaterThan(0);
  });

  it('suppresses delivery when output starts with [SILENT]', async () => {
    const deliver = vi.fn();
    const scheduler = makeScheduler({
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: '[SILENT] all green',
        sessionKey: 'k',
      }),
      deliver,
    });

    await scheduler.createJob({
      name: 'Silent Job',
      schedule: '0 8 * * *',
      prompt: 'check health',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '123' },
    });
    await scheduler.runJobNow('silent-job');

    // Delivery should NOT have been called
    expect(deliver).not.toHaveBeenCalled();

    // But the audit file should still be written
    const runs = await scheduler.listRuns('silent-job');
    expect(runs.length).toBeGreaterThan(0);
  });

  it('suppresses delivery when output starts with whitespace then [SILENT]', async () => {
    const deliver = vi.fn();
    const scheduler = makeScheduler({
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: '  \n[SILENT] all green',
        sessionKey: 'k',
      }),
      deliver,
    });

    await scheduler.createJob({
      name: 'Silent Whitespace',
      schedule: '0 8 * * *',
      prompt: 'check health',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '123' },
    });
    await scheduler.runJobNow('silent-whitespace');

    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers normally when output does not start with [SILENT]', async () => {
    const deliver = vi.fn();
    const scheduler = makeScheduler({
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'Something is wrong!',
        sessionKey: 'k',
      }),
      deliver,
    });

    await scheduler.createJob({
      name: 'Alert Job',
      schedule: '0 8 * * *',
      prompt: 'check health',
      personalityId: 'test',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '123' },
    });
    await scheduler.runJobNow('alert-job');

    expect(deliver).toHaveBeenCalledOnce();
    const [, output] = deliver.mock.calls[0] ?? [];
    expect(output).toBe('Something is wrong!');
  });
});

// ---------------------------------------------------------------------------
// readRunOutput — path containment
// ---------------------------------------------------------------------------

describe('readRunOutput — path containment', () => {
  it('reads a valid output file inside outputDir', async () => {
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Valid Read',
      schedule: '0 8 * * *',
      prompt: 'test output read',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await scheduler.runJobNow(job.id);
    const runs = await scheduler.listRuns(job.id);
    expect(runs.length).toBeGreaterThan(0);
    const output = await scheduler.readRunOutput(runs[0]?.outputPath ?? '');
    expect(output).toContain('ran:');
  });

  it('rejects an absolute path outside outputDir', async () => {
    const scheduler = makeScheduler();
    await expect(scheduler.readRunOutput('/etc/passwd')).rejects.toThrow(
      'Path outside output directory',
    );
  });

  it('rejects a path with ".." traversal', async () => {
    const scheduler = makeScheduler();
    await expect(
      scheduler.readRunOutput(join(testDir, 'output', '..', 'escape.md')),
    ).rejects.toThrow('Path outside output directory');
  });
});

// ---------------------------------------------------------------------------
// System jobs
// ---------------------------------------------------------------------------

describe('CronScheduler system jobs', () => {
  function makeSystemScheduler(overrides: Partial<CronSchedulerConfig> = {}): CronScheduler {
    return new CronScheduler({
      cronDir: testDir,
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: `ran: ${job.prompt ?? ''}`,
        sessionKey: 'k',
      }),
      tickIntervalMs: 60_000,
      storage: new FsStorage(),
      ...overrides,
    });
  }

  it('seedSystemJob creates a system job idempotently', async () => {
    const scheduler = makeSystemScheduler();
    const job1 = await scheduler.seedSystemJob({
      name: 'Observability Prune',
      schedule: '0 3 * * *',
      systemTask: 'observability-prune',
    });
    expect(job1.source).toBe('system');
    expect(job1.systemTask).toBe('observability-prune');

    const job2 = await scheduler.seedSystemJob({
      name: 'Observability Prune',
      schedule: '0 3 * * *',
      systemTask: 'observability-prune',
    });
    expect(job2.id).toBe(job1.id);

    const jobs = await scheduler.listJobs();
    const systemJobs = jobs.filter((j) => j.source === 'system');
    expect(systemJobs).toHaveLength(1);
  });

  it('rejects pause for system jobs', async () => {
    const scheduler = makeSystemScheduler();
    const job = await scheduler.seedSystemJob({
      name: 'Test System Job',
      schedule: '0 3 * * *',
      systemTask: 'test-task',
    });
    await expect(scheduler.pauseJob(job.id)).rejects.toThrow(/cannot pause system job/i);
  });

  it('rejects delete for system jobs', async () => {
    const scheduler = makeSystemScheduler();
    const job = await scheduler.seedSystemJob({
      name: 'Test System Job',
      schedule: '0 3 * * *',
      systemTask: 'test-task',
    });
    await expect(scheduler.deleteJob(job.id)).rejects.toThrow(/cannot delete system job/i);
  });

  it('runJobNow works for system jobs', async () => {
    let handlerCalled = false;
    const scheduler = makeSystemScheduler({
      systemTasks: {
        'test-task': async () => {
          handlerCalled = true;
          return { output: 'system task ran' };
        },
      },
    });
    const job = await scheduler.seedSystemJob({
      name: 'Test System Job',
      schedule: '0 3 * * *',
      systemTask: 'test-task',
    });
    const result = await scheduler.runJobNow(job.id);
    expect(handlerCalled).toBe(true);
    expect(result.output).toBe('system task ran');
  });

  it('tick dispatches system jobs to systemTasks handler', async () => {
    let handlerOutput = '';
    const scheduler = makeSystemScheduler({
      systemTasks: {
        'test-task': async () => {
          handlerOutput = 'handler executed';
          return { output: handlerOutput };
        },
      },
    });
    const job = await scheduler.seedSystemJob({
      name: 'Due System Job',
      schedule: '0 3 * * *',
      systemTask: 'test-task',
    });
    const result = await scheduler.runJobNow(job.id);
    expect(result.output).toBe('handler executed');
    expect(handlerOutput).toBe('handler executed');
  });

  it('user jobs still dispatch through runJob', async () => {
    const prompts: string[] = [];
    const scheduler = makeSystemScheduler({
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'user output',
          sessionKey: 'k',
        };
      },
    });

    await scheduler.createJob({
      name: 'User Job',
      schedule: '0 9 * * *',
      prompt: 'do something',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    const job = await scheduler.getJob('user-job');
    const result = await scheduler.runJobNow(job?.id ?? 'user-job');
    expect(result.output).toBe('user output');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('do something');
  });

  it('user jobs can be paused and deleted', async () => {
    const scheduler = makeSystemScheduler();
    const created = await scheduler.createJob({
      name: 'Deletable Job',
      schedule: '0 9 * * *',
      prompt: 'test',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    await scheduler.pauseJob(created.id);
    const paused = await scheduler.getJob(created.id);
    expect(paused?.status).toBe('paused');

    await scheduler.deleteJob(created.id);
    const deleted = await scheduler.getJob(created.id);
    expect(deleted).toBeNull();
  });

  it('throws when system task handler is not registered', async () => {
    const scheduler = makeSystemScheduler();
    const job = await scheduler.seedSystemJob({
      name: 'No Handler Job',
      schedule: '0 3 * * *',
      systemTask: 'nonexistent',
    });
    await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/not registered/i);
  });

  it('removeSystemJob removes a system job that deleteJob refuses, and skips user jobs', async () => {
    const scheduler = makeSystemScheduler();
    const systemJob = await scheduler.seedSystemJob({
      name: 'Watcher Backing Job',
      schedule: 'every 60s',
      systemTask: 'watcher-tick',
    });
    await expect(scheduler.deleteJob(systemJob.id)).rejects.toThrow(/cannot delete system job/i);

    await scheduler.removeSystemJob(systemJob.id);
    expect(await scheduler.getJob(systemJob.id)).toBeNull();

    // Idempotent on a missing id
    await scheduler.removeSystemJob(systemJob.id);

    // A user job with the same id is untouched
    const userJob = await scheduler.createJob({
      name: 'User Kept Job',
      schedule: '0 9 * * *',
      prompt: 'keep me',
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await scheduler.removeSystemJob(userJob.id);
    expect(await scheduler.getJob(userJob.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Script jobs — zero-LLM, operator-authored files under the scripts dir,
// executed through the ExecutionBackend
// ---------------------------------------------------------------------------

describe('CronScheduler script jobs', () => {
  it('rejects a job with both script and prompt', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Both Set',
        schedule: '0 8 * * *',
        prompt: 'a prompt',
        script: { file: 'ok.sh' },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  it('rejects script on system-source jobs', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'System Script',
        schedule: '0 8 * * *',
        script: { file: 'ok.sh' },
        personalityId: 'system',
        source: 'system',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/not allowed on system jobs/i);
  });

  it('accepts a script-only job — prompt is not required', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Script Only',
      schedule: '0 8 * * *',
      script: { file: 'ok.sh' },
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    expect(job.script).toEqual({ file: 'ok.sh' });
    expect(job.prompt).toBeUndefined();
    expect(job.status).toBe('active');
  });

  it('rejects absolute script paths at create time', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Absolute',
        schedule: '0 8 * * *',
        script: { file: join(scriptsDir, 'ok.sh') },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/must be relative/i);
  });

  it('rejects .. traversal at create time', async () => {
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Traversal',
        schedule: '0 8 * * *',
        script: { file: '../evil.sh' },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/escapes the scripts directory/i);
  });

  it('rejects unsupported extensions at create time', async () => {
    await writeScript('notes.txt', 'echo hi');
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Bad Ext',
        schedule: '0 8 * * *',
        script: { file: 'notes.txt' },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/unsupported extension/i);
  });

  it('rejects a script file that does not exist at create time', async () => {
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Ghost',
        schedule: '0 8 * * *',
        script: { file: 'ghost.sh' },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects out-of-range timeoutSeconds at create time', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Too Long',
        schedule: '0 8 * * *',
        script: { file: 'ok.sh', timeoutSeconds: 601 },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/timeoutSeconds/);
  });

  it('accepts a .py script at create time without executing it', async () => {
    await writeScript('check.py', 'print("hi")');
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Py Job',
      schedule: '0 8 * * *',
      script: { file: 'check.py' },
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    expect(job.script?.file).toBe('check.py');
  });

  it('rejects an update that would leave both script and prompt set', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    const job = await scheduler.createJob({
      name: 'Script Then Prompt',
      schedule: '0 8 * * *',
      script: { file: 'ok.sh' },
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });
    await expect(scheduler.updateJob(job.id, { prompt: 'a prompt' })).rejects.toThrow(
      /mutually exclusive/i,
    );
    // Setting one while explicitly clearing the other stays allowed.
    const updated = await scheduler.updateJob(job.id, { prompt: 'a prompt', script: null });
    expect(updated.prompt).toBe('a prompt');
    expect(updated.script).toBeUndefined();
  });

  it('rejects script on a system job at create time', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'System With Script',
        schedule: '0 3 * * *',
        script: { file: 'ok.sh' },
        source: 'system',
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/not allowed on system jobs/i);
  });

  it('rejects adding script to a system job via update', async () => {
    await writeScript('ok.sh', 'echo hi');
    const scheduler = makeScheduler();
    const job = await scheduler.seedSystemJob({
      name: 'System No Script',
      schedule: '0 3 * * *',
      systemTask: 'test-task',
    });
    await expect(scheduler.updateJob(job.id, { script: { file: 'ok.sh' } })).rejects.toThrow(
      /not allowed on system jobs/i,
    );
  });

  it('executes the script with zero LLM involvement and delivers stdout verbatim', async () => {
    await writeScript('disk.sh', 'echo hello-from-script');
    const runJobCalls: string[] = [];
    const delivered: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runJobCalls.push(job.id);
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'llm output',
          sessionKey: 'k',
        };
      },
      deliver: async (_job, output) => {
        delivered.push(output);
      },
    });
    const job = await scheduler.createJob({
      name: 'Disk Check',
      schedule: '0 8 * * *',
      script: { file: 'disk.sh' },
      personalityId: 'test',
      origin: { platform: 'telegram', chatId: '42' },
      missedRunPolicy: 'skip',
    });

    const result = await scheduler.runJobNow(job.id);
    expect(runJobCalls).toHaveLength(0);
    expect(result.output).toBe('hello-from-script');
    expect(result.sessionKey).toBe(`cron:script:${job.id}`);
    expect(delivered).toEqual(['hello-from-script']);

    // Run output persisted to the same history as prompt jobs.
    const runs = await scheduler.listRuns(job.id);
    expect(runs).toHaveLength(1);
    const body = await scheduler.readRunOutput(runs[0]?.outputPath ?? '');
    expect(body).toContain('hello-from-script');
  });

  it('empty stdout is a silent tick audited as script-silent', async () => {
    await writeScript('quiet.sh', 'exit 0');
    const delivered: string[] = [];
    const decisions: Array<{ action: string; delivered: boolean }> = [];
    const scheduler = makeScheduler({
      deliver: async (_job, output) => {
        delivered.push(output);
      },
      onDecision: (_job, d) => {
        decisions.push({ action: d.action, delivered: d.delivered });
      },
    });
    const job = await scheduler.createJob({
      name: 'Quiet',
      schedule: '0 8 * * *',
      script: { file: 'quiet.sh' },
      personalityId: 'test',
      origin: { platform: 'telegram', chatId: '42' },
      missedRunPolicy: 'skip',
    });

    const result = await scheduler.runJobNow(job.id);
    expect(result.output).toBe('');
    expect(delivered).toHaveLength(0);
    expect(decisions).toEqual([{ action: 'script-silent', delivered: false }]);
  });

  it('non-zero exit records lastError and delivers a failure notice', async () => {
    await writeScript('boom.sh', 'echo boom >&2; exit 3');
    const delivered: string[] = [];
    const scheduler = makeScheduler({
      deliver: async (_job, output) => {
        delivered.push(output);
      },
    });
    const job = await scheduler.createJob({
      name: 'Failing Script',
      schedule: '0 8 * * *',
      script: { file: 'boom.sh' },
      personalityId: 'test',
      origin: { platform: 'telegram', chatId: '42' },
      missedRunPolicy: 'run-once',
    });

    await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/exited with code 3/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/exited with code 3/);
    expect(delivered[0]).toContain('boom');

    // Tick path: due job fails → lastError recorded, job not stuck.
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).tick();

    const updated = await scheduler.getJob(job.id);
    expect(updated?.lastError).toMatch(/exited with code 3/);
    expect(updated?.status).toBe('active');
    expect(updated?.nextRunAt).toBeTruthy();
  });

  it('timeout is a failure — notice delivered, runJobNow rejects', async () => {
    await writeScript('slow.sh', 'sleep 5');
    const delivered: string[] = [];
    const scheduler = makeScheduler({
      deliver: async (_job, output) => {
        delivered.push(output);
      },
    });
    const job = await scheduler.createJob({
      name: 'Slow Script',
      schedule: '0 8 * * *',
      script: { file: 'slow.sh', timeoutSeconds: 1 },
      personalityId: 'test',
      origin: { platform: 'telegram', chatId: '42' },
      missedRunPolicy: 'skip',
    });

    await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/timed out after 1s/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/timed out/);
  });

  it('a script deleted after create is treated as a run-time failure', async () => {
    await writeScript('gone.sh', 'echo hi');
    const delivered: string[] = [];
    const scheduler = makeScheduler({
      deliver: async (_job, output) => {
        delivered.push(output);
      },
    });
    const job = await scheduler.createJob({
      name: 'Gone Script',
      schedule: '0 8 * * *',
      script: { file: 'gone.sh' },
      personalityId: 'test',
      origin: { platform: 'telegram', chatId: '42' },
      missedRunPolicy: 'skip',
    });

    await unlink(join(scriptsDir, 'gone.sh'));
    await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/not found/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/not found/);
  });

  it('redacts secrets from script stdout before delivery', async () => {
    await writeScript('leak.sh', 'echo "password=hunter2hunter2hunter2hunter2"');
    const delivered: string[] = [];
    const scheduler = makeScheduler({
      deliver: async (_job, output) => {
        delivered.push(output);
      },
    });
    const job = await scheduler.createJob({
      name: 'Leaky',
      schedule: '0 8 * * *',
      script: { file: 'leak.sh' },
      personalityId: 'test',
      origin: { platform: 'telegram', chatId: '42' },
      missedRunPolicy: 'skip',
    });

    await scheduler.runJobNow(job.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toContain('hunter2hunter2');
    expect(delivered[0]).toContain('[REDACTED');
  });
});

// ---------------------------------------------------------------------------
// Precheck gate — deterministic script decides whether the LLM turn runs
// ---------------------------------------------------------------------------

describe('CronScheduler precheck gate', () => {
  it('rejects precheck on script jobs and system jobs', async () => {
    await writeScript('ok.sh', 'echo hi');
    await writeScript('pre.sh', 'exit 0');
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Precheck On Script',
        schedule: '0 8 * * *',
        script: { file: 'ok.sh' },
        precheck: { file: 'pre.sh' },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/only allowed on prompt jobs/i);
    await expect(
      scheduler.createJob({
        name: 'Precheck On System',
        schedule: '0 8 * * *',
        precheck: { file: 'pre.sh' },
        personalityId: 'system',
        source: 'system',
        systemTask: 'x',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/not allowed on system jobs/i);
  });

  it('applies the same path guards as script jobs', async () => {
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Traversal Precheck',
        schedule: '0 8 * * *',
        prompt: 'check things',
        precheck: { file: '../evil.sh' },
        personalityId: 'test',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow(/escapes the scripts directory/i);
  });

  it('exit 78 skips the turn entirely — zero runJob calls, precheck-skip audit', async () => {
    await writeScript('skip.sh', 'exit 78');
    const runJobCalls: string[] = [];
    const decisions: Array<{ action: string }> = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        runJobCalls.push(job.id);
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'llm output',
          sessionKey: 'k',
        };
      },
      onDecision: (_job, d) => {
        decisions.push({ action: d.action });
      },
    });
    const job = await scheduler.createJob({
      name: 'Gated',
      schedule: '0 8 * * *',
      prompt: 'analyze the diff',
      precheck: { file: 'skip.sh' },
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    const result = await scheduler.runJobNow(job.id);
    expect(runJobCalls).toHaveLength(0);
    expect(result.output).toBe('');
    expect(result.sessionKey).toBe(`cron:precheck-skip:${job.id}`);
    expect(decisions).toEqual([{ action: 'precheck-skip' }]);
  });

  it('exit 0 runs the turn with stdout injected as untrusted context', async () => {
    await writeScript('ctx.sh', 'echo new-commits-found');
    const prompts: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'llm output',
          sessionKey: 'k',
        };
      },
    });
    const job = await scheduler.createJob({
      name: 'With Context',
      schedule: '0 8 * * *',
      prompt: 'analyze the diff',
      precheck: { file: 'ctx.sh' },
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    await scheduler.runJobNow(job.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('new-commits-found');
    expect(prompts[0]).toContain('analyze the diff');
    expect(prompts[0]).toContain('<untrusted');
  });

  it('a failing precheck fails open — the turn still runs, without context', async () => {
    await writeScript('preboom.sh', 'echo broken >&2; exit 1');
    const prompts: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'llm output',
          sessionKey: 'k',
        };
      },
    });
    const job = await scheduler.createJob({
      name: 'Broken Gate',
      schedule: '0 8 * * *',
      prompt: 'analyze the diff',
      precheck: { file: 'preboom.sh' },
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    await scheduler.runJobNow(job.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('analyze the diff');
    expect(prompts[0]).not.toContain('<untrusted');
  });

  it('a timed-out precheck fails open too', async () => {
    await writeScript('preslow.sh', 'sleep 5');
    const prompts: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => {
        prompts.push(job.prompt ?? '');
        return {
          jobId: job.id,
          ranAt: new Date().toISOString(),
          output: 'llm output',
          sessionKey: 'k',
        };
      },
    });
    const job = await scheduler.createJob({
      name: 'Slow Gate',
      schedule: '0 8 * * *',
      prompt: 'analyze the diff',
      precheck: { file: 'preslow.sh', timeoutSeconds: 1 },
      personalityId: 'test',
      missedRunPolicy: 'skip',
    });

    await scheduler.runJobNow(job.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('analyze the diff');
  });
});
