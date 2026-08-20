import type { AgentLoop } from '@ethosagent/core';
import type {
  ArtifactChange,
  BackgroundJob,
  HookRegistry,
  JobRunner,
  JobRunnerRegistry,
  JobStore,
  SteerSink,
} from '@ethosagent/types';
import { EthosJobRunner } from './ethos-job-runner';
import { capText, extractSummarySection, SUMMARY_RESULT_CAP } from './summary';

export { ETHOS_RUNNER_NAME, EthosJobRunner } from './ethos-job-runner';
// Every background job runs in summary mode, whatever the runner: the parent
// re-ingests only a bounded digest. Exported so an out-of-process runner
// appends the SAME instruction rather than growing a third copy of it.
export { SUMMARY_INSTRUCTION } from './summary';

// ---------------------------------------------------------------------------
// BackgroundExecutor — the detached background engine for background sub-agents.
//
// It owns the pool of concurrently-running detached child turns. Each job is a
// durable row in a shared `jobs.db` (the JobStore); the executor claims queued
// rows, runs the child AgentLoop under its OWN AbortController (never chained to
// a parent turn signal — that is the load-bearing design point that makes a job
// survive the parent turn ending), heartbeats it, watches for cancellation and
// spend caps, and writes the terminal transition back to the store.
//
// Cap enforcement split (do NOT mistake this for a gap):
//   - Per-root / per-personality CONCURRENCY caps are enforced at the TOOL
//     boundary at spawn time (a different module owns that), not here.
//   - The executor enforces only (a) the global pool size (maxConcurrentJobs)
//     and (b) the aggregate per-root SPEND cap (maxRootBackgroundUsd).
// ---------------------------------------------------------------------------

export interface BackgroundExecutorConfig {
  /** Pool size — max jobs running concurrently in this process. */
  maxConcurrentJobs: number;
  /** Heartbeat-age threshold for the stale sweep. NOT the sweep cadence. */
  staleMs: number;
  /** Per-active-job heartbeat cadence, and the periodic stale-sweep cadence. */
  heartbeatMs: number;
  /** A queued row older than this is expired (no executor ever claimed it). */
  queuedTtlMs: number;
  /** Finite default 5.0; null opts out of the aggregate per-root spend cap. */
  maxRootBackgroundUsd: number | null;
  /** Backstop claim poll interval. Default 3_000. */
  pollMs?: number;
  /** Retention GC window: terminal rows older than this are pruned. 0/absent disables. */
  retentionMs?: number;
}

export interface BackgroundExecutorDeps {
  store: JobStore;
  /**
   * The in-process AgentLoop, used to build the DEFAULT runner (`EthosJobRunner`).
   * Still required: every deployment has one, and a job with no `runner` on its
   * row runs on it.
   */
  loop: AgentLoop;
  /**
   * Registry of additional runners, consulted when a job row names one
   * (`BackgroundJob.runner`). Only RESOLVED instances are visible — see
   * `DefaultJobRunnerRegistry`. Absent means "this deployment runs the default
   * runner and nothing else"; a row naming any other runner then fails with a
   * clear error rather than silently running on Ethos.
   */
  runners?: JobRunnerRegistry;
  /** This process's identity, stamped on claims. */
  owner: string;
  config: BackgroundExecutorConfig;
  /** Optional log sink. Library code never touches console.* — use this or nothing. */
  log?: (msg: string) => void;
  /**
   * Optional hook registry. When present, the executor fires the
   * `on_background_job_complete` void hook on every terminal transition, in
   * addition to any `onComplete` subscribers. Absent in standalone deployments.
   */
  hooks?: HookRegistry;
}

const DEFAULT_POLL_MS = 3_000;

// --- Child-text persistence bounds -----------------------------------------
// The child's text is persisted WHILE it runs so a crash mid-job does not lose
// everything it wrote. Three constants bound that, and each answers a different
// failure mode — do not collapse them into one:
//   CHARS  — one row per token would be write amplification of ~2000x. Buffer
//            until a chunk is worth a row.
//   MS     — a slow, chatty child would otherwise sit under the char threshold
//            for minutes with nothing durable. Time-bounds the loss window.
//   ROWS   — the only unbounded axis left is a child that writes forever. Past
//            the cap the stream stops growing and says so, once.
const TEXT_CHUNK_CHARS = 2_000;
const TEXT_FLUSH_MS = 5_000;
const TEXT_MAX_EVENTS = 100;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compact, single-line digest of a tool_start's args for the audit trail. Never
 * includes tool OUTPUT, only the invocation shape. Tiny and defensive — args may
 * be any shape or undefined (JSON.stringify(undefined) === undefined).
 */
function shortArgDigest(args: unknown): string {
  let raw: string;
  try {
    raw = typeof args === 'string' ? args : (JSON.stringify(args) ?? '');
  } catch {
    raw = String(args);
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}

/**
 * A no-op steer sink. The executor does not (yet) thread surface-typed steering
 * into a background job — nothing pushes onto a detached child's sink today.
 * The runner still receives a real sink so it never has to special-case its
 * absence, and wiring one up later is a change at the executor, not at every
 * runner.
 */
const NOOP_STEER_SINK: SteerSink = {
  push: () => false,
  drain: () => [],
  depth: () => 0,
};

export class BackgroundExecutor {
  private readonly store: JobStore;
  private readonly defaultRunner: JobRunner;
  private readonly runners: JobRunnerRegistry | undefined;
  /** This process's identity, stamped on claims. Read-only so callers (e.g. the
   *  gateway creating `/background` jobs) can stamp the same owner this executor
   *  claims by. */
  readonly owner: string;
  private readonly config: BackgroundExecutorConfig;
  private readonly pollMs: number;
  private readonly log: ((msg: string) => void) | undefined;
  private readonly hooks: HookRegistry | undefined;

  /** onComplete subscribers, invoked after every terminal transition. */
  private readonly completeHandlers: Array<(job: BackgroundJob) => void> = [];

  /** job.id -> the job's dedicated (unchained) AbortController. */
  private readonly activeControllers = new Map<string, AbortController>();
  /** job.id -> the in-flight run promise (resolves after its finish is written). */
  private readonly activeRuns = new Map<string, Promise<void>>();
  /**
   * job.id -> the requestId the run is parked on. Membership is the heartbeat
   * pause: while a job is in here its beat is skipped, so `reclaimStale` (which
   * only sweeps `running`) cannot mistake a parked question for a dead host.
   */
  private readonly blockedJobs = new Map<string, string>();

  private started = false;
  private shuttingDown = false;
  /** Re-entrancy guard so overlapping claim triggers coalesce into one loop. */
  private claiming = false;
  private claimAgain = false;
  private nudgeScheduled = false;

  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private retentionTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: BackgroundExecutorDeps) {
    this.store = deps.store;
    this.defaultRunner = new EthosJobRunner(deps.loop);
    this.runners = deps.runners;
    this.owner = deps.owner;
    this.config = deps.config;
    this.pollMs = deps.config.pollMs ?? DEFAULT_POLL_MS;
    this.log = deps.log;
    this.hooks = deps.hooks;
  }

  /**
   * Register a completion handler, fired after every terminal transition of a
   * job (`done` / `failed` / `aborted`, including the stale→terminal recovered
   * case) with the final persisted job row. The subscriber decides suppression
   * (e.g. stay silent on `aborted`). Returns an unsubscribe function.
   */
  onComplete(handler: (job: BackgroundJob) => void): () => void {
    this.completeHandlers.push(handler);
    return () => {
      const idx = this.completeHandlers.indexOf(handler);
      if (idx !== -1) this.completeHandlers.splice(idx, 1);
    };
  }

  /** Number of jobs currently running in the pool. */
  activeCount(): number {
    return this.activeControllers.size;
  }

  /**
   * Park a run on a human answer: `running` -> `blocked`, and pause its
   * heartbeat. THE SEAM for whatever asks the question — a runner's gate
   * escalating through the clarify bridge, or a child turn's own `clarify` call.
   * The executor deliberately does not know which; it only owns the state.
   *
   * Cancellation is NOT paused with the beat: the blocked card offers Cancel, so
   * the timer keeps observing `cancelRequested` and can still abort the run.
   *
   * Ignored for a job this executor is not running — another process owns that
   * row's beat, and tracking it here would leak a pause that nothing clears.
   */
  async markJobBlocked(jobId: string, requestId: string): Promise<void> {
    if (!this.activeControllers.has(jobId)) return;
    this.blockedJobs.set(jobId, requestId);
    await this.store.markBlocked(jobId, requestId);
  }

  /** The counterpart: `blocked` -> `running`, and the heartbeat resumes. */
  async resumeJob(jobId: string): Promise<void> {
    if (!this.blockedJobs.delete(jobId)) return;
    await this.store.resumeFromBlocked(jobId);
  }

  /**
   * Run the boot sweep ONCE, then start the periodic stale sweep and the backstop
   * claim poll. Idempotent — a second call is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    void this.bootSweep();

    // Stale/expiry sweep cadence is the heartbeat interval (a running peer beats
    // every heartbeatMs); the staleMs THRESHOLD is separate. See sweep().
    this.staleTimer = setInterval(() => void this.sweep(), this.config.heartbeatMs);
    this.staleTimer.unref?.();

    this.pollTimer = setInterval(() => void this.claimLoop(), this.pollMs);
    this.pollTimer.unref?.();

    // Retention GC — prune terminal rows older than the retention window. One
    // prune at boot, then a slow (hourly) timer. Disabled when retentionMs <= 0.
    const retentionMs = this.config.retentionMs ?? 0;
    if (retentionMs > 0) {
      void this.pruneRetention(retentionMs);
      this.retentionTimer = setInterval(() => void this.pruneRetention(retentionMs), 3_600_000);
      this.retentionTimer.unref?.();
    }
  }

  /** Delete terminal rows older than the retention window. Never crashes the executor. */
  private async pruneRetention(retentionMs: number): Promise<void> {
    try {
      const deleted = await this.store.pruneTerminal(Date.now() - retentionMs);
      if (deleted > 0) this.log?.(`retention GC pruned ${deleted} terminal job(s)`);
    } catch (err) {
      this.log?.(`retention prune failed: ${errMsg(err)}`);
    }
  }

  /**
   * Trigger an immediate claim attempt. Coalesced onto the next tick so a burst
   * of nudges (one per queued row) collapses into a single claim loop.
   */
  nudge(): void {
    if (this.shuttingDown || this.nudgeScheduled) return;
    this.nudgeScheduled = true;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeScheduled = false;
      void this.claimLoop();
    }, 0);
    this.nudgeTimer.unref?.();
  }

  /**
   * Graceful drain: stop timers, abort every active job's controller, and wait
   * for the in-flight runs to unwind. Each aborted run finishes itself as
   * ('aborted', 'process shutdown') via the shutdown terminal branch in runOne —
   * so shutdown does NOT call store.finish itself (a second finish on an
   * already-terminal row throws; runOne stays the single finish owner per job).
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.started = false;
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.staleTimer = undefined;
    this.pollTimer = undefined;
    this.nudgeTimer = undefined;
    this.retentionTimer = undefined;

    const runs = [...this.activeRuns.values()];
    for (const controller of this.activeControllers.values()) controller.abort();
    await Promise.allSettled(runs);
  }

  // -------------------------------------------------------------------------
  // Boot + periodic sweeps
  // -------------------------------------------------------------------------

  /**
   * Boot sweep (runs once at start). Uses the CONFIGURED staleMs threshold, NOT
   * reclaimStale(0). Rationale: under `run-all`, gateway + serve are separate
   * processes sharing one jobs.db with DIFFERENT owners. A 0-threshold sweep
   * would clobber a LIVE peer's running rows. The 90s staleMs threshold protects
   * a live peer (its heartbeats are <30s old) while still catching genuinely
   * orphaned rows (heartbeat aged past 90s) — here and on every periodic sweep.
   */
  private async bootSweep(): Promise<void> {
    try {
      await this.store.reclaimStale(this.config.staleMs);
    } catch (err) {
      this.log?.(`boot reclaimStale failed: ${errMsg(err)}`);
    }
    try {
      await this.store.expireQueued(this.config.queuedTtlMs);
    } catch (err) {
      this.log?.(`boot expireQueued failed: ${errMsg(err)}`);
    }
    await this.claimLoop();
  }

  private async sweep(): Promise<void> {
    try {
      await this.store.reclaimStale(this.config.staleMs);
    } catch (err) {
      this.log?.(`reclaimStale failed: ${errMsg(err)}`);
    }
    try {
      await this.store.expireQueued(this.config.queuedTtlMs);
    } catch (err) {
      this.log?.(`expireQueued failed: ${errMsg(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Claim / pool loop
  // -------------------------------------------------------------------------

  /**
   * Claim queued rows until the pool is full or nothing is queued. Serialized by
   * `claiming` so concurrent triggers (nudge, poll, a finishing job) never
   * stampede; `claimAgain` re-runs the loop once if a trigger arrived mid-claim
   * (e.g. a row queued after we last saw the queue empty).
   */
  private async claimLoop(): Promise<void> {
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = true;
    try {
      do {
        this.claimAgain = false;
        while (!this.shuttingDown && this.activeControllers.size < this.config.maxConcurrentJobs) {
          let job: BackgroundJob | null;
          try {
            job = await this.store.claimNextQueued(this.owner);
          } catch (err) {
            this.log?.(`claimNextQueued failed: ${errMsg(err)}`);
            break;
          }
          if (!job) break;
          this.startRun(job);
        }
      } while (this.claimAgain && !this.shuttingDown);
    } finally {
      this.claiming = false;
    }
  }

  /** Register the job's controller synchronously, then run it detached. */
  private startRun(job: BackgroundJob): void {
    const controller = new AbortController();
    this.activeControllers.set(job.id, controller);
    const run = this.runOne(job, controller).finally(() => {
      this.activeControllers.delete(job.id);
      this.activeRuns.delete(job.id);
      // A run that ended while parked (cancelled from the blocked card) must not
      // leave its pause behind.
      this.blockedJobs.delete(job.id);
      // A slot freed — pull the next queued row (unless we're draining).
      if (!this.shuttingDown) void this.claimLoop();
    });
    this.activeRuns.set(job.id, run);
  }

  // -------------------------------------------------------------------------
  // Running one job
  // -------------------------------------------------------------------------

  /**
   * Which runner executes this row. A row carries the runner it was spawned
   * for; an unset (or default-named) row runs on the default runner. A row
   * naming a runner this process has not resolved throws — the caller sees a
   * failed job with the reason, never a silent fallback onto Ethos, which would
   * run a task on a harness the requester deliberately did not choose.
   */
  private runnerFor(job: BackgroundJob): JobRunner {
    const name = job.runner;
    if (!name || name === this.defaultRunner.name) return this.defaultRunner;
    const runner = this.runners?.get(name);
    if (!runner) throw new Error(`job runner '${name}' is not available in this process`);
    return runner;
  }

  private async runOne(job: BackgroundJob, controller: AbortController): Promise<void> {
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    try {
      // Pre-start aggregate spend gate. Sum spend across the root's jobs
      // (excluding this one); refuse to run if the cap is already reached.
      const cap = this.config.maxRootBackgroundUsd;
      if (cap !== null) {
        const siblings = await this.store.listByRoot(job.rootSessionKey);
        const sum = siblings
          .filter((j) => j.id !== job.id)
          .reduce((acc, j) => acc + (j.spendUsd ?? 0), 0);
        if (sum >= cap) {
          await this.finishAndNotify(job.id, 'failed', {
            error: `root background spend cap $${cap} reached (already spent $${sum})`,
          });
          return;
        }
      }

      // Per-job heartbeat: bump the beat AND observe an out-of-band cancel.
      let cancelled = false;
      heartbeatTimer = setInterval(() => {
        void (async () => {
          try {
            // Paused while the run is parked on a human answer — see
            // markJobBlocked. The cancel observation below keeps running, so a
            // blocked run stays cancellable.
            if (!this.blockedJobs.has(job.id)) await this.store.heartbeat(job.id);
            const fresh = await this.store.get(job.id);
            if (fresh?.cancelRequested) {
              cancelled = true;
              controller.abort();
            }
          } catch (err) {
            this.log?.(`heartbeat failed for ${job.id}: ${errMsg(err)}`);
          }
        })();
      }, this.config.heartbeatMs);
      heartbeatTimer.unref?.();

      const runner = this.runnerFor(job);

      let output = '';
      let spend = 0;
      let errorText: string | undefined;
      let costBreached = false;

      const text = this.createTextSink(job.id);

      for await (const ev of runner.run(job, {
        signal: controller.signal,
        steerSink: NOOP_STEER_SINK,
        // Artifacts are a job-event-log concern, not an event-stream one. The
        // persistence path lands with the inspector's Diff tab; until then a
        // runner may emit and the executor drops it on the floor rather than
        // pretending to record it.
        emitArtifact: (_change: ArtifactChange) => {},
      })) {
        if (controller.signal.aborted) break;

        if (ev.type === 'text_delta') {
          output += ev.text;
          await text.push(ev.text);
        } else if (ev.type === 'thinking_delta') {
          // Ignore — thinking is not persisted to the job's output.
        } else if (ev.type === 'tool_start') {
          // Flush first so the stream's order matches the run's order: the text
          // that led to a tool call reads before the call, not after it.
          await text.flush();
          try {
            await this.store.appendEvent(job.id, 'tool_headline', {
              toolName: ev.toolName,
              arg: shortArgDigest(ev.args),
            });
          } catch (err) {
            this.log?.(`appendEvent failed for ${job.id}: ${errMsg(err)}`);
          }
        } else if (ev.type === 'tool_end') {
          try {
            await this.store.appendEvent(job.id, 'tool_end', {
              toolName: ev.toolName,
              ok: ev.ok,
              durationMs: ev.durationMs,
              // `error` is set only when ok is false (AgentEvent contract).
              ...(ev.error !== undefined ? { error: shortArgDigest(ev.error) } : {}),
            });
          } catch (err) {
            this.log?.(`appendEvent failed for ${job.id}: ${errMsg(err)}`);
          }
        } else if (ev.type === 'usage') {
          spend += ev.estimatedCostUsd ?? 0;
          try {
            await this.store.updateSpend(job.id, spend);
          } catch (err) {
            this.log?.(`updateSpend failed for ${job.id}: ${errMsg(err)}`);
          }
          if (job.maxCostUsd != null && spend > job.maxCostUsd) {
            costBreached = true;
            controller.abort();
          }
        } else if (ev.type === 'error') {
          errorText = ev.error;
        } else if (ev.type === 'done') {
          break;
        }
        // Forward-compat: any other event type is a no-op.
      }

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      // Whatever the terminal state, the tail of the child's text belongs in the
      // stream before the terminal event.
      await text.flush();

      // Terminal transition, in priority order.
      if (costBreached) {
        await this.finishAndNotify(job.id, 'failed', {
          error: `exceeded max_cost_usd $${job.maxCostUsd} (spent $${spend.toFixed(4)})`,
        });
      } else if (cancelled) {
        await this.finishAndNotify(job.id, 'aborted', { error: 'cancelled by task_cancel' });
      } else if (this.shuttingDown) {
        await this.finishAndNotify(job.id, 'aborted', { error: 'process shutdown' });
      } else if (errorText) {
        await this.finishAndNotify(job.id, 'failed', { error: errorText });
      } else {
        const summary = extractSummarySection(output) ?? output;
        await this.finishAndNotify(job.id, 'done', {
          summary: capText(summary, SUMMARY_RESULT_CAP),
        });
      }
    } catch (err) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // A thrown error fails the job — unless we're draining, where an abort is
      // the honest terminal state.
      try {
        if (this.shuttingDown) {
          await this.finishAndNotify(job.id, 'aborted', { error: 'process shutdown' });
        } else {
          await this.finishAndNotify(job.id, 'failed', { error: errMsg(err) });
        }
      } catch (finishErr) {
        this.log?.(`finish failed for ${job.id}: ${errMsg(finishErr)}`);
      }
    }
  }

  /**
   * Buffered writer for the child's text output. `push` accumulates and writes
   * a `text` event once a chunk is worth a row (size) or the loss window is
   * long enough (time); `flush` drains whatever is left. Both swallow store
   * errors — losing an audit row must never fail the job it describes.
   */
  private createTextSink(jobId: string): {
    push(t: string): Promise<void>;
    flush(): Promise<void>;
  } {
    let buffer = '';
    let lastFlush = Date.now();
    let written = 0;
    let capNoted = false;

    const write = async (chunk: string, payload: Record<string, unknown> = {}): Promise<void> => {
      try {
        await this.store.appendEvent(jobId, 'text', { text: chunk, ...payload });
      } catch (err) {
        this.log?.(`appendEvent(text) failed for ${jobId}: ${errMsg(err)}`);
      }
    };

    const drain = async (all: boolean): Promise<void> => {
      while (buffer.length > 0 && (all || buffer.length >= TEXT_CHUNK_CHARS)) {
        if (written >= TEXT_MAX_EVENTS) {
          buffer = '';
          if (!capNoted) {
            capNoted = true;
            written++;
            await write('', { truncated: true });
          }
          return;
        }
        const chunk = buffer.slice(0, TEXT_CHUNK_CHARS);
        buffer = buffer.slice(chunk.length);
        written++;
        await write(chunk);
      }
      lastFlush = Date.now();
    };

    return {
      async push(t: string): Promise<void> {
        buffer += t;
        // A stale buffer drains ENTIRELY (`all`) — a size-only drain would leave
        // the sub-chunk remainder in memory and reset the clock, so the
        // time-bound would never actually bound anything.
        const stale = Date.now() - lastFlush >= TEXT_FLUSH_MS;
        if (buffer.length >= TEXT_CHUNK_CHARS || stale) await drain(stale);
      },
      flush: () => drain(true),
    };
  }

  // -------------------------------------------------------------------------
  // Terminal transition + completion notification
  // -------------------------------------------------------------------------

  /**
   * Single owner of the terminal transition: writes the finish, then fetches the
   * fresh persisted row and notifies subscribers (onComplete handlers + the
   * optional `on_background_job_complete` void hook). Notification runs only
   * after `store.finish` succeeds. Fires for ALL terminal states — including
   * `aborted` — so the subscriber, not the executor, decides suppression.
   */
  private async finishAndNotify(
    id: string,
    terminal: 'done' | 'failed' | 'aborted',
    fields: { summary?: string; error?: string },
  ): Promise<void> {
    await this.store.finish(id, terminal, fields);
    const fresh = await this.store.get(id);
    if (!fresh) return;
    this.fireComplete(fresh);
    if (this.hooks) {
      try {
        await this.hooks.fireVoid('on_background_job_complete', { job: fresh });
      } catch (err) {
        this.log?.(`on_background_job_complete hook failed for ${id}: ${errMsg(err)}`);
      }
    }
  }

  /** Invoke every onComplete subscriber. A subscriber throwing never crashes the executor. */
  private fireComplete(job: BackgroundJob): void {
    for (const handler of [...this.completeHandlers]) {
      try {
        handler(job);
      } catch (err) {
        this.log?.(`onComplete handler failed for ${job.id}: ${errMsg(err)}`);
      }
    }
  }
}
