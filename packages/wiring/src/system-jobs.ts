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
// per watcher from `watchers.json` — is left strictly alone. That last
// sentence is why the table is parameterised by SURFACE: see
// {@link SystemJobSurface}.

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

/**
 * Which host process is reconciling.
 *
 * The roster is NOT the same for all three, and the difference is between
 * "absent" and "present but disabled" — which for this function is the
 * difference between leaving a job alone and DELETING it.
 *
 * `channel-digest` is the case that forced this parameter. It summarises what
 * the channel adapters observed and delivers through the gateway's `sendVia`,
 * so only `gateway` and `boot` can run it — `ethos serve` has no adapters
 * (plan R3). A naive reading of R3 ("seed it in gateway/boot only") suggests
 * listing it in every table with `enabled: false` for serve. That is exactly
 * wrong: `seedAllSystemJobs` REMOVES a spec whose `enabled` is false, so a
 * serve process would delete the job a gateway process had just seeded, and
 * the two would fight over it on every restart of either. A spec this table
 * does not mention is untouched, so serve must not mention it at all.
 *
 * Required, not defaulted. A default would put that hazard one forgotten
 * argument away, and the compiler is the only thing that reliably remembers.
 */
export type SystemJobSurface = 'serve' | 'gateway' | 'boot';

/**
 * What the operator's config says the system job roster should be right now,
 * for the host process named by `surface` (see {@link SystemJobSurface}).
 */
export function systemJobSpecs(config: EthosConfig, surface: SystemJobSurface): SystemJobSpec[] {
  return [
    // The only thing that ages ANY stored data out — observability rows and,
    // since R4, the observe-mode channel transcript (the handler is in
    // `apps/ethos/src/wiring.ts:182`). It therefore inherits this table's
    // weakest property, and the weakness is worth stating where the schedule
    // is: every spec here is created with `missedRunPolicy: 'skip'`
    // (`CronScheduler.reconcileSystemJob`, `extensions/cron/src/index.ts:815`),
    // and a `skip` job overdue by more than one tick is rolled forward
    // undelivered (`extensions/cron/src/index.ts:917`). A machine that is
    // asleep or off at 03:00 — the `ethos boot` laptop target — therefore
    // prunes nothing, indefinitely, with no operator-visible symptom.
    //
    // There is deliberately no startup prune here to compensate: this table
    // only DECLARES jobs, and a prune-at-boot belongs beside the handler (the
    // precedent is `attachmentCache.pruneOlderThan` at
    // `apps/ethos/src/commands/serve.ts:249`, and the a2a task store's
    // boot-then-hourly at `serve.ts:1564`). Documented as a limitation in
    // `docs/content/using/reference/config-yaml.md` under `retention.*` until
    // one lands.
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
    // Omitted entirely on `serve` — NOT listed disabled. See `SystemJobSurface`.
    ...(surface === 'serve'
      ? []
      : [
          {
            id: 'channel-digest',
            name: 'Channel Digest',
            schedule: config.channelDigest?.cron ?? '0 8 * * *',
            systemTask: 'channel-digest',
            enabled: config.channelDigest?.enabled === true,
          },
        ]),
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
 * Reconcile every system job against `config`, for the roster `surface` owns.
 * Idempotent: a second run over an unchanged config reports `unchanged` for
 * everything and writes nothing.
 *
 * REMOVES jobs whose spec says `enabled: false`. Jobs the surface's table does
 * not list are never touched — which is the whole reason the table knows which
 * surface is asking (see {@link SystemJobSurface}).
 *
 * One job's failure — an unparseable schedule an operator typed into
 * config.yaml, say — must not stop the other four from being reconciled, so
 * each is isolated and reported. Callers log the failures; this package has no
 * console.
 */
export async function seedAllSystemJobs(
  scheduler: CronScheduler,
  config: EthosConfig,
  surface: SystemJobSurface,
): Promise<SystemJobOutcome[]> {
  const outcomes: SystemJobOutcome[] = [];
  for (const spec of systemJobSpecs(config, surface)) {
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
