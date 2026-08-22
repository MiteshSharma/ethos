import type { AgentLoop } from '@ethosagent/core';
import type {
  ArtifactChange,
  BackgroundJob,
  BackgroundJobStatus,
  HookRegistry,
  JobRunner,
  JobRunnerRegistry,
  JobStore,
  RunUpdateDigest,
  SteerSink,
} from '@ethosagent/types';
import { EthosJobRunner } from './ethos-job-runner';
import { BoundedLogBuffer } from './log-buffer';
import { capText, extractSummarySection, SUMMARY_RESULT_CAP } from './summary';

export { ETHOS_RUNNER_NAME, EthosJobRunner } from './ethos-job-runner';
export { BoundedLogBuffer, type RunnerLogLine } from './log-buffer';
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
  /**
   * Phase 5 — withdraw whatever question this job is parked on when its run is
   * aborted (cancel, spend cap, shutdown drain). Injected rather than imported:
   * the thing that owns pending questions is `ClarifyBridge` in
   * `@ethosagent/core`, and the executor deliberately does not know who asked
   * (§13.1's "THE SEAM" comment on `markJobBlocked` says the same).
   *
   * Without it, cancelling a `blocked` run aborts the controller but leaves the
   * question live on someone's phone for the rest of its window, and the
   * escalator's `finally` — which is what un-pauses the heartbeat — never runs.
   * Absent means today's behaviour: abort only.
   */
  cancelInteractions?: (jobId: string) => Promise<void>;
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

/**
 * Per-artifact cap on the unified diff a runner hands over. The file list
 * (`path`, `+n / −n`) is always exact; only the diff BODY is bounded, because a
 * single generated-file rewrite would otherwise put megabytes in one audit row
 * that the inspector then has to read back. Same `[truncated]` marker the text
 * sink uses.
 */
const ARTIFACT_DIFF_CAP = 20_000;

// --- Runner-log persistence bounds (I-LOG1) ---------------------------------
// A runner subprocess's own stdout/stderr is batched into `runner_log`
// job_events rather than one write per line: `@ethosagent/sqlite` is
// synchronous, so a chatty child would otherwise burst many blocking writes
// onto the executor's event loop. Two independent triggers flush a batch,
// whichever fires first — the same two-trigger shape `createTextSink` already
// uses for the child's own text output, for the same reason:
const LOG_BATCH_LINES = 20;
const LOG_BATCH_MS = 250;
// Hard cap on lines held in the IN-MEMORY buffer awaiting flush, so a
// subprocess that out-produces the flush cadence cannot grow memory without
// bound. In normal operation the batch triggers above empty this well before
// it's ever reached — it's a defensive backstop, not the retention cap. The
// OLDEST buffered line is dropped first here — for a log tail, the freshest
// output is the one worth keeping.
const LOG_MAX_BUFFERED_LINES = 100;
// Separate concern: the total number of runner-log LINES persisted to the
// store over a job's whole lifetime. Without this, a long-running chatty
// job's `runner_log` rows would accumulate in `job_events` forever — the
// same unbounded-growth failure mode `TEXT_MAX_EVENTS` above already guards
// against for `text` rows. Matches `task_logs`'s existing `tail` cap (100
// events) and `TEXT_MAX_EVENTS`, per the plan's Open Question 4
// recommendation. Uses the SAME cap-and-stop policy as `TEXT_MAX_EVENTS`
// (write one final marker, then stop), not oldest-eviction: evicting already
// -persisted rows would need a delete/prune method on `JobStore`, which the
// interface doesn't have — out of scope here, and worth a follow-up if a
// true "keep the freshest" retention policy is wanted later.
const LOG_TOTAL_MAX_LINES = 100;

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
 * The card's `now` line for a tool call in flight: what the run is doing right
 * now, in one line. A FACT — never phrasing the copy module owns.
 */
function nowLine(toolName: string, args: unknown): string {
  const arg = shortArgDigest(args);
  const line = arg ? `${toolName} ${arg}` : toolName;
  return line.length > NOW_LINE_MAX_CHARS ? `${line.slice(0, NOW_LINE_MAX_CHARS - 1)}…` : line;
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

/**
 * Minimum gap between two digests for the SAME run (D11's "≤1 Hz per run").
 * Per-run, not global: ten concurrent runs each get their own second.
 */
const RUN_UPDATE_MIN_INTERVAL_MS = 1_000;

/** Cap on the `now` line — one line of the card, not a paragraph. */
const NOW_LINE_MAX_CHARS = 120;

/**
 * Live digest state for one running job. `pending` is the trailing-edge timer:
 * a burst of tool events inside one second collapses into a single publish at
 * the end of it, which is the whole point of coalescing rather than throttling.
 */
interface RunDigest {
  parentSessionKey: string;
  runner: string;
  status: BackgroundJobStatus;
  now: string;
  startedAt: number;
  spendUsd: number;
  toolCount: number;
  lastPublishedAt: number;
  pending: ReturnType<typeof setTimeout> | undefined;
}

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
  private readonly cancelInteractions: ((jobId: string) => Promise<void>) | undefined;

  /** onComplete subscribers, invoked after every terminal transition. */
  private readonly completeHandlers: Array<(job: BackgroundJob) => void> = [];

  /** onRunUpdate subscribers — the run card's liveness feed (G9/D11/D20). */
  private readonly runUpdateHandlers: Array<(update: RunUpdateDigest) => void> = [];

  /** job.id -> its coalescing digest state, for the lifetime of the run. */
  private readonly runDigests = new Map<string, RunDigest>();

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
    this.cancelInteractions = deps.cancelInteractions;
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

  /**
   * Subscribe to the coalesced run digest (G9/D11/D20). Fires at most once per
   * `RUN_UPDATE_MIN_INTERVAL_MS` per run, plus immediately on every status
   * change — a status is the one thing that must never wait out a coalescing
   * window. Returns an unsubscribe function.
   *
   * The executor publishes a routing key (`parentSessionKey`) and facts; it does
   * NOT know what a session stream is. The surface that owns one — web-api's
   * SSE layer — resolves the key to its own session and maps the digest onto
   * its `run.update` push event.
   */
  onRunUpdate(handler: (update: RunUpdateDigest) => void): () => void {
    this.runUpdateHandlers.push(handler);
    return () => {
      const idx = this.runUpdateHandlers.indexOf(handler);
      if (idx !== -1) this.runUpdateHandlers.splice(idx, 1);
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
    // Empty `now`: "paused — waiting on you" is UI copy and lives in the copy
    // module, not here. The status is the fact; the phrasing is the surface's.
    this.updateDigest(jobId, { status: 'blocked', now: '' });
  }

  /** The counterpart: `blocked` -> `running`, and the heartbeat resumes. */
  async resumeJob(jobId: string): Promise<void> {
    if (!this.blockedJobs.delete(jobId)) return;
    await this.store.resumeFromBlocked(jobId);
    this.updateDigest(jobId, { status: 'running' });
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

    // Each run's own teardown drops its digest; anything left here belongs to a
    // run that never unwound, and its trailing timer must not outlive us.
    for (const digest of this.runDigests.values()) {
      if (digest.pending) clearTimeout(digest.pending);
    }
    this.runDigests.clear();
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
    // One listener covers every abort reason — cancel, spend cap, shutdown
    // drain — instead of a call at each `controller.abort()` site, where the
    // next reason added would silently miss it.
    controller.signal.addEventListener(
      'abort',
      () => {
        void this.cancelInteractions?.(job.id).catch((err) => {
          this.log?.(`cancelling pending questions failed for ${job.id}: ${errMsg(err)}`);
        });
      },
      { once: true },
    );
    this.activeControllers.set(job.id, controller);
    const run = this.runOne(job, controller).finally(() => {
      this.activeControllers.delete(job.id);
      this.activeRuns.delete(job.id);
      // A run that ended while parked (cancelled from the blocked card) must not
      // leave its pause behind.
      this.blockedJobs.delete(job.id);
      // Belt and braces: `finishAndNotify` closes the digest on every path it
      // owns, but a throw between openDigest and the finish would strand a
      // timer. Dropping a live digest here can only orphan a card the run no
      // longer feeds anyway.
      const digest = this.runDigests.get(job.id);
      if (digest) {
        if (digest.pending) clearTimeout(digest.pending);
        this.runDigests.delete(job.id);
      }
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

      // G9/D11 — from here the card is fed by the digest and nothing else. Open
      // it AFTER the spend gate above, which can end the run before it starts.
      this.openDigest(job);

      let output = '';
      let spend = 0;
      let errorText: string | undefined;
      let costBreached = false;

      const text = this.createTextSink(job.id);
      const logSink = this.createLogSink(job.id);

      for await (const ev of runner.run(job, {
        signal: controller.signal,
        steerSink: NOOP_STEER_SINK,
        // Artifacts are a job-event-log concern, not an event-stream one:
        // `AgentEvent` is frozen at 17 variants with no artifact slot, so a
        // file change becomes an `artifact_change` ROW and the inspector's Diff
        // tab reads it back from there. `emitArtifact` is synchronous by
        // contract — a runner does not await the audit trail — so the write is
        // fire-and-forget with the same swallow-and-log policy as every other
        // appendEvent here: losing an audit row must never fail the job it
        // describes.
        emitArtifact: (change: ArtifactChange) => {
          void this.store
            .appendEvent(job.id, 'artifact_change', {
              ...change,
              ...(change.diff !== undefined
                ? { diff: capText(change.diff, ARTIFACT_DIFF_CAP) }
                : {}),
            })
            .catch((err) =>
              this.log?.(`appendEvent(artifact_change) failed for ${job.id}: ${errMsg(err)}`),
            );
        },
        // I-LOG1 — same out-of-band, synchronous-by-contract shape as
        // `emitArtifact` above, batched by `createLogSink` into bounded
        // `runner_log` rows instead of one write per line.
        appendLog: (stream, line) => logSink.appendLog(stream, line),
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
          this.updateDigest(job.id, { now: nowLine(ev.toolName, ev.args) });
        } else if (ev.type === 'tool_end') {
          this.updateDigest(job.id, {
            toolCount: (this.runDigests.get(job.id)?.toolCount ?? 0) + 1,
          });
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
          this.updateDigest(job.id, { spendUsd: spend });
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
      // Same for whatever runner-log lines are still buffered. Known gap,
      // matching `stderrTail`'s existing crash tradeoff: a throw between here
      // and process exit — or a crash mid-buffer before this point — loses
      // whatever hasn't flushed yet. No crash-durability is built for this.
      await logSink.flush();

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

  /**
   * Buffered writer for the runner subprocess's own stdout/stderr
   * (`JobRunnerContext.appendLog`, I-LOG1). Batches already-split lines into
   * one `runner_log` job_event per flush — either `LOG_BATCH_LINES` lines or
   * `LOG_BATCH_MS` have elapsed since the oldest still-buffered line, whichever
   * comes first. The in-memory buffer is bounded independently of the flush
   * cadence (`LOG_MAX_BUFFERED_LINES`, oldest dropped first) as a defensive
   * backstop. Separately, and this is the actual per-job retention cap:
   * `LOG_TOTAL_MAX_LINES` bounds how many lines get PERSISTED over the job's
   * whole life, same cap-and-stop shape as `TEXT_MAX_EVENTS` above — past the
   * cap, one final marker row is written and the rest is dropped, so
   * `job_events` can't grow without bound for a long-running chatty job.
   * Swallows store errors — losing an audit row must never fail the job it
   * describes.
   */
  private createLogSink(jobId: string): {
    appendLog(stream: 'stdout' | 'stderr', line: string): void;
    flush(): Promise<void>;
  } {
    const buffer = new BoundedLogBuffer(LOG_MAX_BUFFERED_LINES);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let totalWritten = 0;
    let cappedNoted = false;

    const doFlush = async (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (buffer.length === 0) return;
      const { entries, dropped } = buffer.drain();
      if (totalWritten >= LOG_TOTAL_MAX_LINES) {
        if (!cappedNoted) {
          cappedNoted = true;
          try {
            await this.store.appendEvent(jobId, 'runner_log', { lines: [], truncated: true });
          } catch (err) {
            this.log?.(`appendEvent(runner_log) failed for ${jobId}: ${errMsg(err)}`);
          }
        }
        return;
      }
      totalWritten += entries.length;
      try {
        await this.store.appendEvent(jobId, 'runner_log', {
          lines: entries,
          ...(dropped > 0 ? { dropped } : {}),
        });
      } catch (err) {
        this.log?.(`appendEvent(runner_log) failed for ${jobId}: ${errMsg(err)}`);
      }
    };

    return {
      appendLog(stream: 'stdout' | 'stderr', line: string): void {
        buffer.push({ stream, line });
        if (buffer.length >= LOG_BATCH_LINES) {
          void doFlush();
          return;
        }
        if (!timer) {
          timer = setTimeout(() => void doFlush(), LOG_BATCH_MS);
          timer.unref?.();
        }
      },
      flush: () => doFlush(),
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
    // The card's last sample. Published before the completion notice so the run
    // card is already terminal when Ethos's hand-back message lands under it.
    this.closeDigest(id, terminal);
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

  // -------------------------------------------------------------------------
  // Run digest — the run card's liveness feed (G9/D11/D20)
  // -------------------------------------------------------------------------

  /** Open the digest for a run and publish its first sample immediately. */
  private openDigest(job: BackgroundJob): void {
    this.runDigests.set(job.id, {
      parentSessionKey: job.parentSessionKey,
      runner: job.runner ?? this.defaultRunner.name,
      status: 'running',
      now: '',
      startedAt: job.startedAt ?? Date.now(),
      spendUsd: job.spendUsd ?? 0,
      toolCount: 0,
      lastPublishedAt: 0,
      pending: undefined,
    });
    this.publishDigest(job.id);
  }

  /**
   * Fold new facts into a run's digest and schedule its publication. A status
   * change publishes immediately; everything else coalesces.
   *
   * A no-op for a job with no open digest — `markJobBlocked` may be called for a
   * row this process is not running, and a completion write races the run's own
   * teardown.
   */
  private updateDigest(
    jobId: string,
    patch: Partial<Pick<RunDigest, 'status' | 'now' | 'spendUsd' | 'toolCount'>>,
  ): void {
    const digest = this.runDigests.get(jobId);
    if (!digest) return;
    const statusChanged = patch.status !== undefined && patch.status !== digest.status;
    Object.assign(digest, patch);
    if (statusChanged) {
      this.publishDigest(jobId);
      return;
    }
    const wait = RUN_UPDATE_MIN_INTERVAL_MS - (Date.now() - digest.lastPublishedAt);
    if (wait <= 0) {
      this.publishDigest(jobId);
      return;
    }
    // Trailing edge: one publish at the end of the window carrying the LATEST
    // state, not the sample that happened to arrive first.
    if (digest.pending) return;
    digest.pending = setTimeout(() => this.publishDigest(jobId), wait);
    digest.pending.unref?.();
  }

  /** Emit the digest's current state and reset its coalescing window. */
  private publishDigest(jobId: string): void {
    const digest = this.runDigests.get(jobId);
    if (!digest) return;
    if (digest.pending) {
      clearTimeout(digest.pending);
      digest.pending = undefined;
    }
    digest.lastPublishedAt = Date.now();
    const update: RunUpdateDigest = {
      parentSessionKey: digest.parentSessionKey,
      jobId,
      runner: digest.runner,
      status: digest.status,
      now: digest.now,
      elapsedMs: Math.max(0, Date.now() - digest.startedAt),
      spendUsd: digest.spendUsd,
      toolCount: digest.toolCount,
    };
    for (const handler of [...this.runUpdateHandlers]) {
      try {
        handler(update);
      } catch (err) {
        this.log?.(`onRunUpdate handler failed for ${jobId}: ${errMsg(err)}`);
      }
    }
  }

  /** Publish the terminal sample, then drop the digest and its timer. */
  private closeDigest(jobId: string, status: BackgroundJobStatus): void {
    const digest = this.runDigests.get(jobId);
    if (!digest) return;
    digest.status = status;
    digest.now = '';
    this.publishDigest(jobId);
    if (digest.pending) clearTimeout(digest.pending);
    this.runDigests.delete(jobId);
  }
}
