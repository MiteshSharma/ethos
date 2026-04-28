import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CronJob, CronRunResult } from '../index';
import { CronScheduler, isValidCronExpression, nextRun, nextRunAfter } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-cron-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeScheduler(runJob?: (job: CronJob) => Promise<CronRunResult>) {
  return new CronScheduler({
    cronDir: testDir,
    tickIntervalMs: 999_999, // don't auto-tick in tests
    runJob:
      runJob ??
      (async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: `ran: ${job.prompt}`,
        sessionKey: `cron:${job.id}`,
      })),
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
      missedRunPolicy: 'skip',
    });
    await expect(
      scheduler.createJob({
        name: 'My Job',
        schedule: '0 9 * * *',
        prompt: 'test2',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow('already exists');
  });

  it('rejects invalid cron expressions', async () => {
    const scheduler = makeScheduler();
    await expect(
      scheduler.createJob({
        name: 'Bad',
        schedule: 'not-cron',
        prompt: 'x',
        missedRunPolicy: 'skip',
      }),
    ).rejects.toThrow('Invalid cron expression');
  });

  it('deletes a job', async () => {
    const scheduler = makeScheduler();
    await scheduler.createJob({
      name: 'To Delete',
      schedule: '0 8 * * *',
      prompt: 'x',
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
      missedRunPolicy: 'skip',
    });

    await scheduler.pauseJob('pauseable');
    expect((await scheduler.getJob('pauseable'))?.status).toBe('paused');

    await scheduler.resumeJob('pauseable');
    expect((await scheduler.getJob('pauseable'))?.status).toBe('active');
  });

  it('runJobNow executes and saves output', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler(async (job) => {
      runs.push(job.id);
      return {
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'test output',
        sessionKey: 'k',
      };
    });

    await scheduler.createJob({
      name: 'Immediate',
      schedule: '0 8 * * *',
      prompt: 'go',
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
// Tick behaviour
// ---------------------------------------------------------------------------

describe('CronScheduler tick', () => {
  it('skip policy does not run overdue job', async () => {
    const runs: string[] = [];
    const scheduler = makeScheduler(async (job) => {
      runs.push(job.id);
      return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
    });

    // Create a job that was due in the past
    const job = await scheduler.createJob({
      name: 'Overdue Skip',
      schedule: '0 8 * * *',
      prompt: 'test',
      missedRunPolicy: 'skip',
    });

    // Force nextRunAt to the past
    // Access internal method via cast
    // biome-ignore lint/suspicious/noExplicitAny: test access to private method
    await (scheduler as any).patchJob(job.id, {
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
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
    const scheduler = makeScheduler(async (job) => {
      runs.push(job.id);
      return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
    });

    const job = await scheduler.createJob({
      name: 'Overdue Run',
      schedule: '0 8 * * *',
      prompt: 'test',
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
    const scheduler = makeScheduler(async (job) => {
      runs.push(job.id);
      return { jobId: job.id, ranAt: new Date().toISOString(), output: 'x', sessionKey: 'k' };
    });

    const job = await scheduler.createJob({
      name: 'Paused Job',
      schedule: '0 8 * * *',
      prompt: 'test',
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
