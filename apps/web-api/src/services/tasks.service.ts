import type {
  BackgroundJob,
  BackgroundJobEvent,
  JobRunner,
  JobRunnerRegistry,
  JobStore,
} from '@ethosagent/types';
import type {
  BackgroundJobDetailWire,
  BackgroundJobEventWire,
  BackgroundJobSummaryWire,
} from '@ethosagent/web-contracts';

/** How many of a job's newest events one detail read returns. */
const DETAIL_EVENT_LIMIT = 200;

export interface TasksServiceOptions {
  /** The durable background-job store from wiring's CreateAgentLoopResult.
   *  Absent when background delegation is disabled — every read degrades to
   *  an empty result and `cancel` reports `{ ok: false }` rather than throwing. */
  store?: JobStore;
  /**
   * Resolved runners, consulted on `get` so the run card's detail grid can carry
   * the runner's OWN rows alongside the 12 the UI owns (pi-delegation D18).
   * Absent, or a row naming a runner this process did not resolve → no extra
   * rows and no capabilities, which is still a valid card (T28).
   */
  runners?: JobRunnerRegistry;
}

// Maps the domain `BackgroundJob` (camelCase, epoch-ms numbers, optional fields
// possibly `undefined`) onto the wire schema, which uses `.nullable()` — absent
// optionals become explicit `null`, never omitted. Mirrors how GoalsService
// hands rows to the goals RPC.
function toSummary(job: BackgroundJob): BackgroundJobSummaryWire {
  return {
    id: job.id,
    status: job.status,
    label: job.label ?? null,
    personalityId: job.personalityId ?? null,
    spendUsd: job.spendUsd,
    maxCostUsd: job.maxCostUsd ?? null,
    depth: job.depth,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    heartbeatAt: job.heartbeatAt ?? null,
    owner: job.owner,
    rootSessionKey: job.rootSessionKey,
    parentSessionKey: job.parentSessionKey,
  };
}

function toEvent(event: BackgroundJobEvent): BackgroundJobEventWire {
  return {
    id: event.id,
    jobId: event.jobId,
    seq: event.seq,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function toDetail(
  job: BackgroundJob,
  events: BackgroundJobEvent[],
  runner: JobRunner | undefined,
): BackgroundJobDetailWire {
  return {
    ...toSummary(job),
    prompt: job.prompt,
    summary: job.summary ?? null,
    error: job.error ?? null,
    events: events.map(toEvent),
    runner: job.runner ?? null,
    childSessionKey: job.childSessionKey,
    originPlatform: job.originPlatform ?? null,
    originChatId: job.originChatId ?? null,
    blockedRequestId: job.blockedRequestId ?? null,
    // A runner throwing while describing a row must not take the detail read
    // down with it — the 12 shared rows are still worth rendering.
    detailRows: describeSafely(runner, job),
    capabilities: runner ? toCapabilities(runner.capabilities) : null,
  };
}

function toCapabilities(
  caps: JobRunner['capabilities'],
): NonNullable<BackgroundJobDetailWire['capabilities']> {
  // The contract's arrays are `readonly`; the wire schema's are not. Copying is
  // the whole conversion — the alternative is a schema that lets a surface
  // mutate a runner's advertised capabilities in place.
  return {
    interactionKinds: [...caps.interactionKinds],
    answerScopes: [...caps.answerScopes],
    takeover: caps.takeover,
    resume: caps.resume,
    steer: caps.steer,
    sandbox: caps.sandbox,
    transport: caps.transport,
  };
}

function describeSafely(
  runner: JobRunner | undefined,
  job: BackgroundJob,
): BackgroundJobDetailWire['detailRows'] {
  if (!runner) return [];
  try {
    return runner.describe(job).map((row) => ({
      label: row.label,
      value: row.value,
      ...(row.tone ? { tone: row.tone } : {}),
    }));
  } catch {
    return [];
  }
}

export class TasksService {
  private store?: JobStore;
  private runners?: JobRunnerRegistry;

  constructor(opts: TasksServiceOptions) {
    this.store = opts.store;
    this.runners = opts.runners;
  }

  /**
   * Background jobs scoped to a single root session. The frozen `JobStore`
   * contract exposes `listByRoot` but no `listAll`, so a global cross-session
   * list is not available without a schema change (Phase A contract). When
   * `rootSessionKey` is omitted, we return `[]` rather than adding a method to
   * the frozen contract — the Tasks page scopes to one session at a time.
   */
  async list(rootSessionKey?: string): Promise<BackgroundJobSummaryWire[]> {
    if (!this.store || !rootSessionKey) return [];
    const jobs = await this.store.listByRoot(rootSessionKey);
    return jobs.map(toSummary);
  }

  async get(id: string): Promise<BackgroundJobDetailWire | null> {
    if (!this.store) return null;
    const job = await this.store.get(id);
    if (!job) return null;
    // Bounded tail: the newest N rows, not the whole trail. A long run's event
    // log is unbounded, and this read happens at the exact moment someone opens
    // a task to find out what went wrong — the worst moment to buffer it all.
    const events = await this.store.getEvents(id, { limit: DETAIL_EVENT_LIMIT });
    // A row naming a runner this process did not resolve still renders: the 12
    // shared rows are the UI's contract, the runner's are a bonus (D18/T28).
    const runner = job.runner ? this.runners?.get(job.runner) : undefined;
    return toDetail(job, events, runner);
  }

  async cancel(id: string): Promise<{ ok: boolean }> {
    if (!this.store) return { ok: false };
    await this.store.requestCancel(id);
    return { ok: true };
  }
}
