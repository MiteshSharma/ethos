import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronScheduler } from '../index';

// `reconcileSystemJob` — the half `seedSystemJob` never had.
//
// `seedSystemJob` returns an existing job untouched, so a schedule edited in
// config.yaml was ignored forever and a feature switched off kept firing. These
// are the three transitions that fixes, plus the one property that makes it
// safe to run on every boot of every host process: doing it twice changes
// nothing the second time.

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-cron-reconcile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(join(testDir, 'scripts'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeScheduler(): CronScheduler {
  return new CronScheduler({
    cronDir: testDir,
    scriptsDir: join(testDir, 'scripts'),
    tickIntervalMs: 999_999,
    storage: new FsStorage(),
    runJob: async (job) => ({
      jobId: job.id,
      ranAt: new Date().toISOString(),
      output: '',
      sessionKey: `cron:${job.id}`,
    }),
  });
}

const spec = {
  id: 'weekly-digest',
  name: 'Weekly Digest',
  schedule: '0 9 * * 1',
  systemTask: 'weekly-digest',
};

describe('CronScheduler.reconcileSystemJob', () => {
  it('creates a job that does not exist yet', async () => {
    const s = makeScheduler();
    const { action, job } = await s.reconcileSystemJob(spec);
    expect(action).toBe('created');
    expect(job?.id).toBe('weekly-digest');
    expect(job?.source).toBe('system');
    expect(job?.systemTask).toBe('weekly-digest');
  });

  it('patches the schedule when config changed', async () => {
    const s = makeScheduler();
    await s.reconcileSystemJob(spec);
    const before = await s.getJob('weekly-digest');

    const { action, job } = await s.reconcileSystemJob({ ...spec, schedule: '30 7 * * 5' });
    expect(action).toBe('patched');
    expect(job?.schedule).toBe('30 7 * * 5');
    // The next fire is recomputed, not carried over from the old schedule.
    expect(job?.nextRunAt).not.toBe(before?.nextRunAt);
    expect((await s.listJobs()).length).toBe(1);
  });

  it('removes the job when the config flag goes off', async () => {
    const s = makeScheduler();
    await s.reconcileSystemJob(spec);
    const { action, job } = await s.reconcileSystemJob({ ...spec, enabled: false });
    expect(action).toBe('removed');
    expect(job).toBeNull();
    expect(await s.getJob('weekly-digest')).toBeNull();
  });

  it('is a no-op when the flag is off and the job was never created', async () => {
    const s = makeScheduler();
    const { action } = await s.reconcileSystemJob({ ...spec, enabled: false });
    expect(action).toBe('unchanged');
    expect(await s.listJobs()).toEqual([]);
  });

  it('is idempotent — a second run over an unchanged spec changes nothing', async () => {
    const s = makeScheduler();
    await s.reconcileSystemJob(spec);
    const first = await s.getJob('weekly-digest');

    const { action } = await s.reconcileSystemJob(spec);
    expect(action).toBe('unchanged');
    expect(await s.getJob('weekly-digest')).toEqual(first);
  });

  it('recreates the job when the handler name changed', async () => {
    const s = makeScheduler();
    await s.reconcileSystemJob(spec);
    const { action, job } = await s.reconcileSystemJob({ ...spec, systemTask: 'weekly-digest-v2' });
    // `CronJobUpdate` carries no systemTask, and a job pointing at a handler
    // that no longer exists throws on every tick.
    expect(action).toBe('created');
    expect(job?.systemTask).toBe('weekly-digest-v2');
    expect((await s.listJobs()).length).toBe(1);
  });

  it('never touches a user job squatting the same id, and reports the conflict', async () => {
    const s = makeScheduler();
    await s.createJob({
      name: 'Weekly Digest',
      schedule: '0 6 * * *',
      prompt: 'my own digest',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
    });

    // `unchanged` would claim the desired state holds while the system job does
    // not exist at all — the caller has to be able to tell those apart.
    const { action } = await s.reconcileSystemJob(spec);
    expect(action).toBe('conflict');
    const job = await s.getJob('weekly-digest');
    expect(job?.source).toBe('user');
    expect(job?.prompt).toBe('my own digest');

    // And the disable path leaves it alone too — a user's job is their data —
    // but it is still a collision, not a quiet success.
    const off = await s.reconcileSystemJob({ ...spec, enabled: false });
    expect(off.action).toBe('conflict');
    expect(await s.getJob('weekly-digest')).not.toBeNull();
  });

  // --- FIX A: identity is the explicit id, never the display name -----------

  it('patches a renamed job instead of forking a second one', async () => {
    const s = makeScheduler();
    await s.reconcileSystemJob(spec);

    const { action, job } = await s.reconcileSystemJob({ ...spec, name: 'Weekly Roundup' });
    expect(action).toBe('patched');
    expect(job?.id).toBe('weekly-digest');
    expect(job?.name).toBe('Weekly Roundup');
    // The old job is not left behind still firing beside the new one.
    expect((await s.listJobs()).map((j) => j.id)).toEqual(['weekly-digest']);
  });

  it('removes the renamed job by id when its flag goes off', async () => {
    const s = makeScheduler();
    await s.reconcileSystemJob(spec);

    const { action } = await s.reconcileSystemJob({
      ...spec,
      name: 'Weekly Roundup',
      enabled: false,
    });
    expect(action).toBe('removed');
    expect(await s.listJobs()).toEqual([]);
  });

  it('adopts a job stored under the id an earlier release slugified from the name', async () => {
    const s = makeScheduler();
    // What `seedSystemJob` (name-derived id) wrote on every install before this.
    await s.seedSystemJob({
      name: 'Weekly Digest',
      schedule: '0 9 * * 1',
      systemTask: 'weekly-digest',
    });

    const { action, job } = await s.reconcileSystemJob(spec);
    expect(action).toBe('unchanged');
    expect(job?.id).toBe('weekly-digest');
    expect((await s.listJobs()).length).toBe(1);
  });
});
