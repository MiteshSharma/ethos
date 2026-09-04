// One reconcile pass over every `source:'system'` cron job (plan D7).
//
// `ethos serve`, `ethos gateway` and `ethos boot` each carried a near-identical
// copy of the seeding block, and all three only ever CREATED: a schedule edited
// in config.yaml was ignored forever, a feature switched off kept firing, and
// the three copies drifted the moment a fifth job appeared. This is the single
// reconciling replacement.
//
// It lives here, not beside `seedSystemJob` in `extensions/cron`, because it
// reads `EthosConfig`. No extension depends on `@ethosagent/config` and cron
// should not be the first — that would teach the scheduler the operator config
// schema. `packages/wiring` already depends on both, which is what a wiring
// layer is for. The config-agnostic half — create / patch / remove one job —
// IS in cron, as `CronScheduler.reconcileSystemJob`.
//
// Only the jobs listed here are ever removed. A system job this table does not
// know about — the watcher ticks in `@ethosagent/watchers`, which are seeded
// per watcher from `watchers.json` — is left strictly alone.

import type { EthosConfig } from '@ethosagent/config';
import type { CronScheduler } from '@ethosagent/cron';
import { backupCron, backupEnabled } from './backup-schedule';

export interface SystemJobSpec {
  /**
   * Immutable cron job id. NOT derived from `name` — see
   * `CronScheduler.reconcileSystemJob`. Every id here is exactly the slug the
   * old name-derived seeders wrote, so jobs already on disk are adopted rather
   * than duplicated on upgrade. Changing one strands the job it renames.
   */
  id: string;
  /** Display copy. Safe to change: a rename patches the job, it does not fork it. */
  name: string;
  schedule: string;
  systemTask: string;
  /** `false` removes the job if it exists. */
  enabled: boolean;
}

/** What the operator's config says the system job roster should be right now. */
export function systemJobSpecs(config: EthosConfig): SystemJobSpec[] {
  return [
    {
      id: 'observability-prune',
      name: 'Observability Prune',
      schedule: '0 3 * * *',
      systemTask: 'observability-prune',
      enabled: true,
    },
    {
      id: 'nightly-pass',
      name: 'Nightly Pass',
      schedule: config.nightlyPass?.cron ?? '0 3 * * *',
      systemTask: 'nightly-pass',
      enabled: config.nightlyPass?.enabled === true,
    },
    {
      id: 'weekly-digest',
      name: 'Weekly Digest',
      schedule: config.weeklyDigest?.cron ?? '0 9 * * 1',
      systemTask: 'weekly-digest',
      enabled: config.weeklyDigest?.enabled === true,
    },
    {
      id: 'skill-evolver',
      name: 'Skill Evolver',
      schedule: config.evolverSchedule ?? '0 3 * * *',
      systemTask: 'skill-evolver',
      enabled: config.evolverCronEnabled === true,
    },
    {
      id: 'backup',
      name: 'Backup',
      schedule: backupCron(config),
      systemTask: 'backup',
      enabled: backupEnabled(config),
    },
  ];
}

export interface SystemJobOutcome {
  /** The spec's immutable cron job id. */
  id: string;
  /** The spec's display name. */
  name: string;
  /** `'conflict'` — the id is held by a user's own job, so nothing was applied. */
  action: 'created' | 'patched' | 'removed' | 'unchanged' | 'conflict' | 'failed';
  /** Set only when `action` is `'failed'`. */
  error?: string;
}

/**
 * One line for a system job that did NOT reach the state config asked for, or
 * `null` when it did. The three host processes (serve / gateway / boot) all
 * print this; keeping the wording here is what stops the copies from drifting
 * the way the seeding blocks it replaced did.
 */
export function systemJobProblem(outcome: SystemJobOutcome): string | null {
  if (outcome.action === 'failed') {
    return `system job "${outcome.name}" could not be reconciled: ${outcome.error}`;
  }
  if (outcome.action === 'conflict') {
    return (
      `system job "${outcome.name}" was not applied — cron job id "${outcome.id}" belongs to ` +
      'one of your own jobs, so Ethos left it alone. Rename or delete that job to let the ' +
      'system job use the id.'
    );
  }
  return null;
}

/**
 * Reconcile every system job against `config`. Idempotent: a second run over an
 * unchanged config reports `unchanged` for everything and writes nothing.
 *
 * One job's failure — an unparseable schedule an operator typed into
 * config.yaml, say — must not stop the other four from being reconciled, so
 * each is isolated and reported. Callers log the failures; this package has no
 * console.
 */
export async function seedAllSystemJobs(
  scheduler: CronScheduler,
  config: EthosConfig,
): Promise<SystemJobOutcome[]> {
  const outcomes: SystemJobOutcome[] = [];
  for (const spec of systemJobSpecs(config)) {
    try {
      const { action } = await scheduler.reconcileSystemJob(spec);
      outcomes.push({ id: spec.id, name: spec.name, action });
    } catch (err) {
      outcomes.push({
        id: spec.id,
        name: spec.name,
        action: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}
