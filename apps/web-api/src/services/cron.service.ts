import type { CronScheduler, CronJob as ExtCronJob } from '@ethosagent/cron';
import { EthosError } from '@ethosagent/types';
import type {
  CronDeliverTo,
  CronDeliveryTarget,
  CronJob,
  CronRun,
} from '@ethosagent/web-contracts';
import { type DeliveryTargetWorld, resolveDeliveryTargets } from './cron-delivery-targets';

// Cron orchestration. Wraps the CronScheduler — job CRUD + tick loop +
// run-history reads (`listRuns`/`readRunOutput`) — into the wire shape
// the web tab consumes. Pure business logic — no Hono context, no oRPC.

export interface CronCreateInput {
  name: string;
  schedule: string;
  prompt: string;
  personalityId: string;
  missedRunPolicy?: 'run-once' | 'skip';
  /** @deprecated Alias for `deliverTo` — `true` ≡ `{kind:'inApp'}`, `false` ≡ `{kind:'none'}`. */
  notifyInApp?: boolean;
  deliverTo?: CronDeliverTo;
}

export interface CronRunNowOutput {
  output: string;
  ranAt: string;
}

export interface CronServiceOptions {
  scheduler: CronScheduler;
  /**
   * Reads behind `deliveryTargets()` and behind refusal rules 1 and 2 of
   * plan/phases/recipes-gallery.md §1. Absent in deployments with no channel
   * surface (tests, ACP-only): `deliveryTargets` then reports none and a
   * `kind: 'channel'` create is refused, which is the correct answer — there
   * is no bot to deliver through.
   */
  deliveryWorld?: DeliveryTargetWorld;
}

export class CronService {
  constructor(private readonly opts: CronServiceOptions) {}

  async list(): Promise<{ jobs: CronJob[] }> {
    const jobs = await this.opts.scheduler.listJobs();
    return { jobs: jobs.map(toWireJob) };
  }

  async get(id: string): Promise<{ job: CronJob }> {
    const job = await this.opts.scheduler.getJob(id);
    if (!job) throw notFound(id);
    return { job: toWireJob(job) };
  }

  /**
   * Chats this personality's own bots may be pointed at. Read-only, and the
   * only source the Cron page's delivery picker draws from — a chatId is never
   * free text.
   */
  async deliveryTargets(personalityId: string): Promise<{ targets: CronDeliveryTarget[] }> {
    if (!this.opts.deliveryWorld) return { targets: [] };
    const { targets } = await resolveDeliveryTargets(this.opts.deliveryWorld, personalityId);
    return { targets };
  }

  async create(input: CronCreateInput): Promise<{ job: CronJob }> {
    const deliverTo = reconcileDeliverTo(input);
    const origin = await this.resolveOrigin(input.personalityId, deliverTo);
    try {
      const job = await this.opts.scheduler.createJob({
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        personalityId: input.personalityId,
        missedRunPolicy: input.missedRunPolicy ?? 'skip',
        // Absent origin keeps today's default — output saved to file only.
        ...(origin ? { origin } : {}),
      });
      return { job: toWireJob(job) };
    } catch (err) {
      // The scheduler throws plain `Error`s for validation + duplicates;
      // surface them with the right wire code so the modal can render
      // a clear inline message.
      const message = err instanceof Error ? err.message : String(err);
      throw new EthosError({
        code: 'CRON_INVALID',
        cause: message,
        action: 'Check the schedule expression (5-field cron) and that the name is unique.',
      });
    }
  }

  async update(
    id: string,
    patch: { name?: string; schedule?: string; prompt?: string },
  ): Promise<{ job: CronJob }> {
    try {
      const updated = await this.opts.scheduler.updateJob(id, patch);
      return { job: toWireJob(updated) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) throw notFound(id);
      throw new EthosError({
        code: 'CRON_INVALID',
        cause: message,
        action: 'Check the schedule expression and that the job exists.',
      });
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.opts.scheduler.deleteJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }

  async pause(id: string): Promise<void> {
    try {
      await this.opts.scheduler.pauseJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }

  async resume(id: string): Promise<void> {
    try {
      await this.opts.scheduler.resumeJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }

  /**
   * Map the `deliverTo` union onto the existing `JobOrigin`. `JobOrigin` itself
   * does not change (D9): `{ platform, chatId }` already expresses the target,
   * and `botKey` is an authorization input consumed here, not a stored address.
   *
   * Refusal rules 1 and 2 of plan/phases/recipes-gallery.md §1 live here.
   * Rule 4 (`kind: 'channel'` is cookie-auth only) lives in the RPC handler —
   * see `apps/web-api/src/rpc/cron.ts` for why it cannot live in `SCOPE_MAP`.
   */
  private async resolveOrigin(
    personalityId: string,
    deliverTo: CronDeliverTo,
  ): Promise<{ platform: string; chatId: string } | undefined> {
    if (deliverTo.kind === 'none') return undefined;
    // In-app heartbeat: a `web` origin routes run output into a stable,
    // openable session (one per personality) that surfaces in Activity.
    if (deliverTo.kind === 'inApp') {
      return { platform: 'web', chatId: `web:heartbeat:${personalityId}` };
    }

    const world = this.opts.deliveryWorld;
    if (!world) {
      throw new EthosError({
        code: 'CRON_TARGET_NOT_ALLOWED',
        cause: 'This deployment has no channel surface, so a chat cannot be a delivery target.',
        action: 'Create the job with in-app or file-only delivery.',
      });
    }

    // Recomputed here, at create time, from the server's own view of the
    // world — never trusted from whatever the client previewed.
    const { bots, targets } = await resolveDeliveryTargets(world, personalityId);

    // Rule 1 — the bot must already speak for this personality. This is what
    // stops personality A's schedule being delivered through personality B's bot.
    const bound = bots.some(
      (b) => b.platform === deliverTo.platform && b.botKey === deliverTo.botKey,
    );
    if (!bound) {
      throw new EthosError({
        code: 'CRON_TARGET_NOT_ALLOWED',
        cause: `No ${deliverTo.platform} bot "${deliverTo.botKey}" is bound to personality "${personalityId}".`,
        action: `Bind a ${deliverTo.platform} bot to this personality in Communications, then pick it again.`,
      });
    }

    // Rule 2 — the chat must be in the recomputed set for that (platform, botKey).
    const allowed = targets.some(
      (t) =>
        t.platform === deliverTo.platform &&
        t.botKey === deliverTo.botKey &&
        t.chatId === deliverTo.chatId,
    );
    if (!allowed) {
      throw new EthosError({
        code: 'CRON_TARGET_NOT_ALLOWED',
        cause: `Chat "${deliverTo.chatId}" is not an approved delivery target for ${deliverTo.platform} bot "${deliverTo.botKey}".`,
        action:
          'Pick a target from the list, or message the bot from that chat once so it becomes a known target.',
      });
    }

    return { platform: deliverTo.platform, chatId: deliverTo.chatId };
  }

  async runNow(id: string): Promise<CronRunNowOutput> {
    const job = await this.opts.scheduler.getJob(id);
    if (!job) throw notFound(id);
    // "Test it" exercises the REAL delivery path: `runJobNow` runs the same
    // `executeJob` the ticker does, which delivers to the job's stored origin.
    // Nothing here re-resolves a target or substitutes a web one.
    const result = await this.opts.scheduler.runJobNow(id);
    return { output: result.output, ranAt: result.ranAt };
  }

  async history(id: string, limit?: number): Promise<{ runs: CronRun[] }> {
    const infos = await this.opts.scheduler.listRuns(id, limit);
    if (infos.length === 0) return { runs: [] };

    const runs: CronRun[] = infos.map((info) => ({
      ranAt: info.ranAt,
      outputPath: info.outputPath,
      output: null,
    }));

    // Hydrate the head run's body so the UI can show the most recent
    // output without a second round-trip; the rest stay metadata-only.
    const head = runs[0];
    if (head) {
      try {
        head.output = await this.opts.scheduler.readRunOutput(head.outputPath);
      } catch {
        // file vanished between listing and read — leave the metadata.
      }
    }
    return { runs };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse the deprecated `notifyInApp` boolean and the `deliverTo` union into
 * one answer. `notifyInApp: true` ≡ `{kind:'inApp'}` and `false` ≡
 * `{kind:'none'}`; sending both with anything else is a validation error, not
 * a silent precedence rule — a caller that disagrees with itself does not get
 * to find out which half the server happened to prefer.
 */
function reconcileDeliverTo(input: CronCreateInput): CronDeliverTo {
  const { deliverTo, notifyInApp } = input;
  if (deliverTo === undefined) {
    return notifyInApp ? { kind: 'inApp' } : { kind: 'none' };
  }
  if (notifyInApp === undefined) return deliverTo;
  const aliased: CronDeliverTo['kind'] = notifyInApp ? 'inApp' : 'none';
  if (aliased !== deliverTo.kind) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `notifyInApp=${notifyInApp} means deliverTo.kind='${aliased}', but deliverTo.kind='${deliverTo.kind}' was also sent.`,
      action: 'Send only `deliverTo` — `notifyInApp` is a deprecated alias for it.',
    });
  }
  return deliverTo;
}

function toWireJob(job: ExtCronJob): CronJob {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt ?? '',
    personalityId: job.personalityId,
    deliver: job.origin?.platform ?? null,
    status: job.status,
    missedRunPolicy: job.missedRunPolicy,
    source: (job.source ?? 'user') as 'system' | 'user',
    systemTask: job.systemTask ?? null,
    lastRunAt: job.lastRunAt ?? null,
    nextRunAt: job.nextRunAt ?? null,
    createdAt: job.createdAt,
  };
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'JOB_NOT_FOUND',
    cause: `Cron job "${id}" not found`,
    action: 'Use cron.list to see currently registered jobs.',
  });
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}
