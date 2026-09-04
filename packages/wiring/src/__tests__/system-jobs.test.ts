import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAllSystemJobs, systemJobProblem, systemJobSpecs } from '../system-jobs';

// `seedAllSystemJobs` (plan D7) — the one reconciling replacement for the three
// copied seeding blocks in serve / gateway / boot.
//
// The property that matters most is the one the copies did NOT have: it runs on
// every boot of every host process, so a second pass over an unchanged config
// must change nothing. Everything else here is a transition the old code could
// not express at all — a changed schedule, a flag turned off.

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-sysjobs-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

function makeConfig(over: Partial<EthosConfig> = {}): EthosConfig {
  return { provider: 'anthropic', model: 'm', apiKey: 'sk', personality: 'researcher', ...over };
}

async function jobIds(s: CronScheduler): Promise<string[]> {
  return (await s.listJobs()).map((j) => j.id).sort();
}

describe('systemJobSpecs', () => {
  it('enables observability-prune and backup by default, and nothing else', () => {
    const specs = systemJobSpecs(makeConfig());
    expect(
      specs
        .filter((s) => s.enabled)
        .map((s) => s.systemTask)
        .sort(),
    ).toEqual(['backup', 'observability-prune']);
  });

  // MIGRATION (FIX A): every id must equal the slug the old name-derived
  // seeders wrote, or an upgrade orphans the job it was meant to adopt.
  it('gives every spec the id an earlier release derived from its name', () => {
    const slugify = (name: string) =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64);
    for (const spec of systemJobSpecs(makeConfig())) {
      expect(spec.id, `id for "${spec.name}"`).toBe(slugify(spec.name));
    }
  });

  it('honours the backup schedule and toggle from config', () => {
    const specs = systemJobSpecs(makeConfig({ backup: { enabled: false, cron: '15 1 * * *' } }));
    const backup = specs.find((s) => s.systemTask === 'backup');
    expect(backup).toEqual({
      id: 'backup',
      name: 'Backup',
      schedule: '15 1 * * *',
      systemTask: 'backup',
      enabled: false,
    });
  });
});

describe('seedAllSystemJobs', () => {
  it('creates the jobs the config asks for and no others', async () => {
    const s = makeScheduler();
    const outcomes = await seedAllSystemJobs(s, makeConfig());
    expect(outcomes.every((o) => o.action !== 'failed')).toBe(true);
    expect(await jobIds(s)).toEqual(['backup', 'observability-prune']);
  });

  it('is idempotent — the second run reports every job unchanged and writes nothing', async () => {
    const s = makeScheduler();
    const config = makeConfig({ nightlyPass: { enabled: true } });
    await seedAllSystemJobs(s, config);
    const before = await s.listJobs();

    const outcomes = await seedAllSystemJobs(s, config);
    expect(outcomes.map((o) => o.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
    expect(await s.listJobs()).toEqual(before);
  });

  it('patches a schedule that changed in config.yaml', async () => {
    const s = makeScheduler();
    await seedAllSystemJobs(s, makeConfig({ nightlyPass: { enabled: true, cron: '0 3 * * *' } }));
    expect((await s.getJob('nightly-pass'))?.schedule).toBe('0 3 * * *');

    const outcomes = await seedAllSystemJobs(
      s,
      makeConfig({ nightlyPass: { enabled: true, cron: '45 2 * * *' } }),
    );
    expect(outcomes.find((o) => o.name === 'Nightly Pass')?.action).toBe('patched');
    expect((await s.getJob('nightly-pass'))?.schedule).toBe('45 2 * * *');
  });

  it('removes a job whose config flag went off', async () => {
    const s = makeScheduler();
    await seedAllSystemJobs(s, makeConfig({ weeklyDigest: { enabled: true } }));
    expect(await s.getJob('weekly-digest')).not.toBeNull();

    const outcomes = await seedAllSystemJobs(s, makeConfig({ weeklyDigest: { enabled: false } }));
    expect(outcomes.find((o) => o.name === 'Weekly Digest')?.action).toBe('removed');
    expect(await s.getJob('weekly-digest')).toBeNull();
  });

  it('removes the backup job when backup.enabled is false', async () => {
    const s = makeScheduler();
    await seedAllSystemJobs(s, makeConfig());
    expect(await s.getJob('backup')).not.toBeNull();

    await seedAllSystemJobs(s, makeConfig({ backup: { enabled: false } }));
    expect(await s.getJob('backup')).toBeNull();
  });

  it('leaves system jobs it does not own alone — watcher ticks survive', async () => {
    const s = makeScheduler();
    await s.seedSystemJob({
      name: 'watcher-tick-inbox',
      schedule: 'every 60s',
      systemTask: 'watcher-tick',
    });

    await seedAllSystemJobs(s, makeConfig({ backup: { enabled: false } }));
    expect(await s.getJob('watcher-tick-inbox')).not.toBeNull();
  });

  // MIGRATION (FIX A): the end-to-end proof — jobs written by the old
  // name-derived seeder are adopted in place, not duplicated.
  it('adopts jobs an earlier release seeded, without creating a second copy', async () => {
    const s = makeScheduler();
    const config = makeConfig({
      nightlyPass: { enabled: true },
      weeklyDigest: { enabled: true },
      evolverCronEnabled: true,
    });
    // Exactly what serve/gateway/boot wrote before `seedAllSystemJobs` existed:
    // `seedSystemJob`, whose id is `slugify(name)`.
    for (const spec of systemJobSpecs(config)) {
      await s.seedSystemJob({
        name: spec.name,
        schedule: spec.schedule,
        systemTask: spec.systemTask,
      });
    }
    const before = await jobIds(s);
    expect(before.length).toBe(5);

    const outcomes = await seedAllSystemJobs(s, config);
    expect(outcomes.map((o) => o.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
    expect(await jobIds(s)).toEqual(before);
  });

  it('patches a renamed spec onto the existing job rather than forking one', async () => {
    const s = makeScheduler();
    const config = makeConfig();
    await seedAllSystemJobs(s, config);
    const backup = await s.getJob('backup');
    expect(backup?.name).toBe('Backup');

    // Simulate the rename by patching the display name behind the reconciler's
    // back, then reconciling: config wins, and the id does not move.
    await s.updateJob('backup', { name: 'Nightly backup' });
    const outcomes = await seedAllSystemJobs(s, config);
    expect(outcomes.find((o) => o.id === 'backup')?.action).toBe('patched');
    expect((await s.getJob('backup'))?.name).toBe('Backup');
    expect(await jobIds(s)).toEqual(['backup', 'observability-prune']);
  });

  // FIX C — a user job on a system id disables the system job. Reporting
  // `unchanged` there says the desired state holds when the job does not exist.
  it('reports a conflict when a user job holds a system job id', async () => {
    const s = makeScheduler();
    await s.createJob({
      name: 'Backup',
      schedule: '0 6 * * *',
      prompt: 'my own backup routine',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
    });

    const outcomes = await seedAllSystemJobs(s, makeConfig());
    const backup = outcomes.find((o) => o.id === 'backup');
    if (!backup) throw new Error('no outcome for the backup spec');
    expect(backup.action).toBe('conflict');
    expect(systemJobProblem(backup)).toMatch(/"backup"/);
    // The user's job is untouched.
    expect((await s.getJob('backup'))?.source).toBe('user');
  });

  it('systemJobProblem is silent for every outcome that reached its desired state', () => {
    for (const action of ['created', 'patched', 'removed', 'unchanged'] as const) {
      expect(systemJobProblem({ id: 'backup', name: 'Backup', action })).toBeNull();
    }
    expect(
      systemJobProblem({ id: 'backup', name: 'Backup', action: 'failed', error: 'boom' }),
    ).toMatch(/boom/);
  });

  it('reports one bad schedule without abandoning the rest', async () => {
    const s = makeScheduler();
    const outcomes = await seedAllSystemJobs(
      s,
      makeConfig({ nightlyPass: { enabled: true, cron: 'not-a-cron' } }),
    );
    const failed = outcomes.find((o) => o.action === 'failed');
    expect(failed?.name).toBe('Nightly Pass');
    expect(failed?.error).toMatch(/schedule/i);
    // The four others still reconciled.
    expect(await jobIds(s)).toEqual(['backup', 'observability-prune']);
  });
});
