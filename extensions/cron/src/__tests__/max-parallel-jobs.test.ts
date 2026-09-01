// `cron.maxParallelJobs` — the in-flight cap on the tick/fire loop. Drives two
// overlapping ticks past the cap and asserts the excess is DEFERRED (still due,
// runs on a later tick), not dropped.

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CronJob, CronScheduler } from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-cron-parallel-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/** A scheduler whose first job blocks until `release()` is called. */
function makeBlockingScheduler(maxParallelJobs?: number) {
  const started: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let markFirstRunning: () => void = () => {};
  const firstRunning = new Promise<void>((r) => {
    markFirstRunning = r;
  });

  const scheduler = new CronScheduler({
    cronDir: testDir,
    scriptsDir: join(testDir, 'scripts'),
    tickIntervalMs: 999_999,
    storage: new FsStorage(),
    ...(maxParallelJobs !== undefined ? { maxParallelJobs } : {}),
    runJob: async (job: CronJob) => {
      started.push(job.id);
      if (started.length === 1) {
        markFirstRunning();
        await gate;
      }
      return {
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'x',
        sessionKey: `cron:${job.id}`,
      };
    },
  });

  return { scheduler, started, release: () => release(), firstRunning };
}

async function createDueJob(scheduler: CronScheduler, name: string): Promise<CronJob> {
  const job = await scheduler.createJob({
    name,
    schedule: '0 8 * * *',
    prompt: 'test',
    personalityId: 'test',
    missedRunPolicy: 'run-once',
  });
  // biome-ignore lint/suspicious/noExplicitAny: test access to private method
  await (scheduler as any).patchJob(job.id, {
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return job;
}

describe('CronScheduler — cron.maxParallelJobs', () => {
  it('defers a due job while at the cap, then runs it once a slot frees', async () => {
    const { scheduler, started, release, firstRunning } = makeBlockingScheduler(1);
    const first = await createDueJob(scheduler, 'Parallel One');
    const second = await createDueJob(scheduler, 'Parallel Two');

    // Tick A claims `first` and blocks inside runJob — one job in flight.
    const tickA = scheduler.fire();
    await firstRunning;

    // Tick B overlaps it. `second` is due, but the cap is met, so it is left
    // unclaimed rather than executed.
    await scheduler.fire();
    expect(started).toEqual([first.id]);

    const deferred = (await scheduler.listJobs()).find((j) => j.id === second.id);
    expect(deferred?.status).toBe('active');
    expect(new Date(deferred?.nextRunAt ?? '').getTime()).toBeLessThan(Date.now());

    // Releasing the first job frees the slot; the deferred job then runs.
    release();
    await tickA;
    expect(started).toEqual([first.id, second.id]);
  });

  it('runs both concurrently when the cap is unset (unchanged behaviour)', async () => {
    const { scheduler, started, release, firstRunning } = makeBlockingScheduler();
    const first = await createDueJob(scheduler, 'Uncapped One');
    const second = await createDueJob(scheduler, 'Uncapped Two');

    const tickA = scheduler.fire();
    await firstRunning;

    await scheduler.fire();
    expect(started).toEqual([first.id, second.id]);

    release();
    await tickA;
  });
});
