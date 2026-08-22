import type { AgentMesh, NotifyMode } from '@ethosagent/agent-mesh';
import type { KanbanStore, Task } from '@ethosagent/kanban-store';
import { autonomyTier, type TrustPolicy, tierMaxRetries } from '@ethosagent/kanban-store';
import type { HookRegistry } from '@ethosagent/types';
import type { MemberRuntime } from './runtime';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Minimal supervisor view the dispatcher needs.
 *
 * Production wiring passes the real `Map<personality, MemberState>` from
 * `runSupervisor`; tests pass a small mock.
 */
export interface SupervisorState {
  /** Port the assignee personality is listening on (`null` if unknown). */
  portOf(personality: string): number | null;
  /** Lifecycle status for the assignee process. Only `running` is dispatchable. */
  statusOf(personality: string): MemberRuntime['status'] | null;
}

/**
 * Sends a one-shot prompt to a peer agent's `/rpc` endpoint. Mirrors
 * `callMeshAgent` from `tools-delegation` but exposed for the dispatcher,
 * which fires outside any agent turn. Injected so tests can substitute a stub.
 */
export type DispatchCall = (args: {
  host: string;
  port: number;
  prompt: string;
  personalityId: string;
  signal: AbortSignal;
  /**
   * Delivery mode for the peer's `/notify` endpoint (Lane C,
   * kanban-hooks-notify-parity, Phase 2). `wake`/`notify+wake` force a full
   * agent turn — today's only behavior. `notify` is a passive delivery: no
   * turn is forced, and the peer surfaces it later via the pending-notify
   * `ContextInjector` at its own next turn. Optional and defaults to
   * `notify+wake` in {@link defaultDispatchCall} — every existing caller
   * (including this dispatcher's own {@link Dispatcher.fireDispatch}, which
   * does not set it) keeps today's exact forced-turn behavior unless it
   * explicitly opts in to a different mode.
   */
  mode?: NotifyMode;
}) => Promise<string>;

/**
 * Dispatches a run to a peer as a durable BACKGROUND job via the peer's `/rpc`
 * `spawn` method. Unlike {@link DispatchCall}, this returns as soon as the peer
 * has recorded the job (yielding its `jobId`) — it does NOT await the run to
 * completion. Used only when `dispatchAsBackgroundJob` is enabled. Injected so
 * tests can substitute a stub.
 */
export type SpawnDispatchCall = (args: {
  host: string;
  port: number;
  prompt: string;
  personalityId: string;
  signal: AbortSignal;
}) => Promise<{ jobId: string }>;

export interface DispatcherOptions {
  board: KanbanStore;
  supervisor: SupervisorState;
  /** AgentMesh for address resolution. Falls back to supervisor.portOf() when absent. */
  mesh?: AgentMesh;
  /** Dispatch transport. Defaults to {@link defaultDispatchCall}. */
  dispatch?: DispatchCall;
  /**
   * OPT-IN. When true, ready+assigned tasks are dispatched to peers as durable
   * BACKGROUND jobs (via the peer's `/rpc` `spawn` method) instead of a blocking
   * one-shot prompt. The peer records a `BackgroundJob`, gaining a per-run
   * durable record, spend tracking, and Tasks-page visibility on the peer. The
   * kanban board remains the source of truth for task state (heartbeat,
   * staleness reclaim, and the verifier flow are unchanged); the peer's job
   * store supplements that execution record, it never replaces the board's run
   * state. Default: false — the blocking {@link DispatchCall} path is used.
   */
  dispatchAsBackgroundJob?: boolean;
  /**
   * Background-job dispatch transport, used only when `dispatchAsBackgroundJob`
   * is true. Defaults to {@link defaultSpawnDispatchCall}.
   */
  spawnDispatch?: SpawnDispatchCall;
  /**
   * Heartbeat threshold. A task whose open run hasn't heartbeated in this many
   * milliseconds gets marked `blocked` ("stalled — no heartbeat"). Default: 90 s.
   */
  staleMs?: number;
  /** Loop cadence for the polling fallback. Default 1 s. */
  pollMs?: number;
  /**
   * Per-dispatch timeout. A fetch that hasn't resolved in this many ms gets
   * aborted and the task is marked `blocked`. Without this, a hung worker
   * would leak an in-flight HTTP request indefinitely while the stale-heartbeat
   * reclaim runs alongside it (two outcomes racing for the same run). Default:
   * 300 s — generous enough to cover normal agent turns, tight enough that
   * crashed transports drain inside a few minutes.
   */
  dispatchTimeoutMs?: number;
  /** Optional callback fired on every dispatch error (logging hook). */
  onError?: (err: Error, taskId: string) => void;
  /**
   * Coordinator personality id from the team manifest. When set, the
   * dispatcher reassigns orphan tickets (assignee=null + no children) to the
   * coordinator each tick so no work is left without an owner. Unset on teams
   * without a coordinator (e.g. dispatch_mode: self-routing).
   */
  coordinator?: string;
  /**
   * Grace window for orphan adoption. Protects the race between
   * `kanban_create_goal` and the immediately-following `kanban_create` calls
   * that add the goal's children. Default 60 s.
   */
  orphanGracePeriodMs?: number;
  /**
   * Staleness threshold for reclaiming stuck `running` tasks. A task whose
   * `updated_at` (last activity — `heartbeatRun` bumps it) is older than this
   * gets reclaimed back to `ready` with reason `orphan_stale`. This is a
   * separate mechanism from `staleMs`: `staleMs` blocks heartbeat-stale runs;
   * this one re-queues them for another attempt (retry budget permitting).
   * Default: 5 min.
   */
  stalenessThresholdMs?: number;
  /**
   * Opt-in from `TeamManifest.dispatch_prefer_reliable`. When true, the dispatch
   * loop uses each assignee's success ratio (`tickets_completed / (completed +
   * failed + orphaned)`, from `team_member_stats`) as an *additional
   * tie-breaker within the same priority*: among equal-priority ready tasks,
   * those whose assignee has a higher success ratio dispatch first. It is never
   * an exclusion — every ready+assigned task is still dispatched, and priority
   * always dominates. A member with no recorded outcomes yet is treated as a
   * perfect record (ratio 1) so new members are not penalized. Default: false.
   */
  preferReliable?: boolean;
  trustPolicy?: TrustPolicy;
  /**
   * Fires `ticket_claimed` / `ticket_stale_reclaimed` / `dispatch_tick` as the
   * dispatcher's own lifecycle events (Lane B, kanban-hooks-notify-parity).
   * Void-only, fail-open, parallel via `Promise.allSettled` — a throwing or
   * slow handler never blocks `tick()`. Optional: a dispatcher built without
   * one fires zero hooks, matching today's exact behavior.
   */
  hooks?: HookRegistry;
  /**
   * Identifies this board/team in the `dispatch_tick` hook payload. Purely
   * descriptive — has no effect on dispatch behavior. Production wiring
   * passes the team manifest's name.
   */
  teamId?: string;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const DEFAULT_STALE_MS = 90_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 300_000;
const DEFAULT_ORPHAN_GRACE_MS = 60_000;
const DEFAULT_STALENESS_THRESHOLD_MS = 300_000;
const DISPATCH_HOST = 'localhost';

export class Dispatcher {
  private readonly board: KanbanStore;
  private readonly supervisor: SupervisorState;
  private readonly mesh: AgentMesh | null;
  private readonly dispatch: DispatchCall;
  private readonly dispatchAsBackgroundJob: boolean;
  private readonly spawnDispatch: SpawnDispatchCall;
  private readonly staleMs: number;
  private readonly pollMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly onError: (err: Error, taskId: string) => void;
  private readonly coordinator: string | null;
  private readonly orphanGracePeriodMs: number;
  private readonly stalenessThresholdMs: number;
  private readonly preferReliable: boolean;
  private readonly trustPolicy: TrustPolicy | undefined;
  private readonly hooks: HookRegistry | undefined;
  private readonly teamId: string | undefined;
  private readonly inflight = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: DispatcherOptions) {
    this.board = opts.board;
    this.supervisor = opts.supervisor;
    this.mesh = opts.mesh ?? null;
    this.dispatch = opts.dispatch ?? defaultDispatchCall;
    this.dispatchAsBackgroundJob = opts.dispatchAsBackgroundJob ?? false;
    this.spawnDispatch = opts.spawnDispatch ?? defaultSpawnDispatchCall;
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.onError = opts.onError ?? (() => {});
    this.coordinator = opts.coordinator ?? null;
    this.orphanGracePeriodMs = opts.orphanGracePeriodMs ?? DEFAULT_ORPHAN_GRACE_MS;
    this.stalenessThresholdMs = opts.stalenessThresholdMs ?? DEFAULT_STALENESS_THRESHOLD_MS;
    this.preferReliable = opts.preferReliable ?? false;
    this.trustPolicy = opts.trustPolicy;
    this.hooks = opts.hooks;
    this.teamId = opts.teamId;
  }

  /**
   * Run one full cycle: promote ready/scheduled, reclaim stalled, dispatch
   * ready-with-assignee. Exposed so tests can drive the dispatcher
   * deterministically. The polling loop is just `tick()` on a setInterval.
   */
  async tick(): Promise<void> {
    // Counters for the `dispatch_tick` hook (D9) — it only fires when at
    // least one of these is nonzero, so an idle tick fires zero hooks.
    let claimedCount = 0;
    let reclaimedCount = 0;

    // 1. Promote — parents-done and scheduled-time-passed both unblock work.
    this.board.promoteReady();
    this.board.promoteScheduled();
    // 1a. Roll up goals whose children have all finished. Closes the "Q3
    //     roadmap sits at ready forever after every sub-task completes" hole.
    this.board.rollupCompletedGoals('dispatcher');
    // 1b. Adopt orphan tickets — non-goal tasks without an assignee — into
    //     the coordinator's queue. Every ticket must have an owner; the
    //     coordinator triages from here. No-op on teams without a coordinator.
    if (this.coordinator !== null) {
      this.board.adoptOrphanTickets(this.coordinator, {
        gracePeriodMs: this.orphanGracePeriodMs,
        actor: 'dispatcher',
      });
    }

    // 2. Reclaim — any run with a stale heartbeat is treated as the worker
    //    crashing. We mark the task `blocked` so a human (or a future reassign)
    //    can decide next step. The run row is closed atomically by `blockRun`.
    for (const stalled of this.board.findStalledRuns(this.staleMs)) {
      try {
        this.board.blockRun(stalled.taskId, 'stalled — no heartbeat');
      } catch {
        // Race: another writer ended the run between our read and our write.
        // Acceptable — they handled it, we don't double-process.
      }
    }

    // 2a. Reclaim stuck `running` tasks — a second eligibility path on top of
    //     step 2's heartbeat-block. A task is stuck if its owner is gone
    //     (`orphan_no_owner`) or it stopped making progress (`orphan_stale`).
    //     Unlike step 2, this re-queues the task (`ready`) rather than blocking
    //     it: the same tick's dispatch loop re-claims it, which routes through
    //     `updateStatus('running')` and so spends the retry budget. We skip
    //     tasks still `inflight` from a prior tick — those are healthy.
    const staleIds = new Set(
      this.board.findStaleRunningTasks(this.stalenessThresholdMs).map((t) => t.id),
    );
    for (const task of this.board.listTasks({ status: 'running' })) {
      if (this.inflight.has(task.id)) continue;
      const assignee = task.assignee;
      const ownerGone = assignee === null || this.supervisor.statusOf(assignee) !== 'running';
      const reason: 'orphan_no_owner' | 'orphan_stale' | null = ownerGone
        ? 'orphan_no_owner'
        : staleIds.has(task.id)
          ? 'orphan_stale'
          : null;
      if (reason === null) continue;
      try {
        this.board.reclaimTask(task.id, reason, 'dispatcher');
        reclaimedCount++;
        if (this.hooks) {
          await this.hooks.fireVoid('ticket_stale_reclaimed', {
            taskId: task.id,
            previousAssignee: assignee,
            reason,
          });
        }
      } catch {
        // Race: another writer ended the run / changed status between our
        // read and our write. Acceptable — they handled it.
      }
    }

    // 3. Dispatch — claim each ready+assigned task and POST it to the assignee.
    //    The claim (status flip + open run + current_run_id) happens via
    //    updateStatus(running). If the assignee isn't reachable, we mark the
    //    task blocked so it surfaces on the board instead of disappearing.
    //
    //    `findReadyToDispatch()` already orders by `priority DESC, created_at
    //    ASC`. When `preferReliable` is set, we re-sort that list to add a
    //    success-ratio tie-breaker *within* each priority band — higher-success
    //    assignees dispatch first. It is never an exclusion: every task in the
    //    list is still dispatched, just possibly in a different order.
    const readyToDispatch = this.orderForDispatch(this.board.findReadyToDispatch());
    const memberStats =
      this.trustPolicy?.mode === 'tiered' ? this.board.getMemberStats() : undefined;
    for (const task of readyToDispatch) {
      if (this.inflight.has(task.id)) continue; // already in-flight from a prior tick
      const assignee = task.assignee;
      if (assignee === null) continue;
      let dispatchHost = DISPATCH_HOST;
      let dispatchPort: number | null = null;

      if (this.mesh) {
        const entries = await this.mesh.findByPersonality(assignee);
        const entry = entries[0];
        if (entry) {
          dispatchHost = entry.host;
          dispatchPort = entry.port;
        }
      } else {
        const status = this.supervisor.statusOf(assignee);
        if (status !== 'running') continue;
        dispatchPort = this.supervisor.portOf(assignee);
      }

      if (dispatchPort === null) continue;

      // Tier-based retry budget: when no explicit max_retries is set and a
      // trust_policy is configured, compute effective budget from the assignee's
      // tier. Check locally instead of persisting — the stored max_retries stays
      // null so reassignment or policy changes take effect on the next attempt.
      if (task.maxRetries === null && this.trustPolicy?.mode === 'tiered' && memberStats) {
        const stats = memberStats.get(assignee);
        if (stats) {
          const budget = tierMaxRetries(autonomyTier(stats, this.trustPolicy));
          if (task.retryCount > budget) {
            try {
              this.board.updateStatus(
                task.id,
                'failed',
                'tier_retry_budget_exhausted',
                'dispatcher',
              );
            } catch {
              /* already transitioned */
            }
            continue;
          }
        }
      }

      let claimed: Task;
      try {
        claimed = this.board.updateStatus(task.id, 'running', 'dispatched', 'dispatcher');
      } catch {
        continue;
      }
      if (claimed.status !== 'running') continue;
      claimedCount++;
      const runId = claimed.currentRunId;
      if (this.hooks && runId !== null) {
        await this.hooks.fireVoid('ticket_claimed', { taskId: task.id, assignee, runId });
      }

      const controller = new AbortController();
      this.inflight.set(task.id, controller);
      // OPT-IN background path: dispatch as a durable spawn job. The task stays
      // tracked by the kanban heartbeat/staleness machinery below — the worker
      // updates the board as the background job runs — so we do NOT await a full
      // run here. Default path (blocking prompt) is unchanged.
      if (this.dispatchAsBackgroundJob) {
        void this.fireSpawnDispatch(task, assignee, dispatchHost, dispatchPort, controller).finally(
          () => {
            this.inflight.delete(task.id);
          },
        );
      } else {
        void this.fireDispatch(task, assignee, dispatchHost, dispatchPort, controller).finally(
          () => {
            this.inflight.delete(task.id);
          },
        );
      }
    }

    // Per D9: fire only when something actually happened this tick — an idle
    // tick (nothing claimed, nothing reclaimed) fires zero hooks, so
    // listeners don't pay for 1Hz of empty notifications on an idle board.
    if (this.hooks && (claimedCount > 0 || reclaimedCount > 0)) {
      await this.hooks.fireVoid('dispatch_tick', {
        ...(this.teamId !== undefined ? { teamId: this.teamId } : {}),
        claimedCount,
        reclaimedCount,
      });
    }
  }

  /**
   * Apply the optional `dispatch_prefer_reliable` tie-breaker to the
   * already-ordered ready list. With the flag off this is a pass-through. With
   * it on, tasks are re-sorted by `priority DESC, successRatio DESC` — and
   * because `Array.prototype.sort` is stable, ties on both keys keep the
   * incoming `created_at ASC` order. The success ratio comes from the board's
   * `team_member_stats`.
   *
   * Cold-start policy: an assignee with no recorded outcomes sorts *after* a
   * proven 100%-success member but *ahead* of any member with a real failure
   * on record. This neither penalizes newcomers (the plan forbids that) nor
   * pretends unknown equals perfect (which would let a fresh member outrank a
   * long-running 99%-reliable one). It falls out of a clean two-key compare:
   * a newcomer is scored with `ratio = 1` (so it ties a perfect member) but
   * `hasRecord = false` (so it loses that tie). Sort by ratio first, then by
   * `hasRecord` — a perfect member (ratio 1, has record) leads, a newcomer
   * (ratio 1, no record) follows, and anyone with a failure (ratio < 1)
   * trails. Reordering only — nothing is excluded.
   */
  private orderForDispatch(ready: Task[]): Task[] {
    if (!this.preferReliable || ready.length < 2) return ready;
    const stats = this.board.getMemberStats();
    // `ratio`: success ratio — newcomers are scored 1 so they tie a perfect
    // member on this key. `hasRecord`: whether there is a real record behind
    // that ratio — breaks the newcomer-vs-perfect tie in the perfect member's
    // favour.
    const reliabilityOf = (assignee: string | null): { ratio: number; hasRecord: boolean } => {
      if (assignee === null) return { ratio: 1, hasRecord: false };
      const s = stats.get(assignee);
      if (s === undefined) return { ratio: 1, hasRecord: false };
      const total = s.ticketsCompleted + s.ticketsFailed + s.ticketsOrphaned;
      if (total === 0) return { ratio: 1, hasRecord: false };
      return { ratio: s.ticketsCompleted / total, hasRecord: true };
    };
    return [...ready].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const ra = reliabilityOf(a.assignee);
      const rb = reliabilityOf(b.assignee);
      if (ra.ratio !== rb.ratio) return rb.ratio - ra.ratio;
      // Equal ratio: a member with a real record sorts ahead of a newcomer.
      // Two newcomers tie here, so the stable sort keeps their incoming
      // `created_at ASC` order.
      if (ra.hasRecord !== rb.hasRecord) return ra.hasRecord ? -1 : 1;
      return 0;
    });
  }

  /** Start the polling loop. Safe to call once; no-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.onError(err as Error, 'tick');
      }
      this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
  }

  /**
   * Stop the polling loop and abort any in-flight HTTP calls. The runs they
   * left open stay `running` on disk — the reclaim path picks them up on
   * supervisor restart once their heartbeats go stale.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
  }

  private async fireDispatch(
    task: Task,
    assignee: string,
    host: string,
    port: number,
    controller: AbortController,
  ): Promise<void> {
    const prompt = renderTaskPrompt(task);

    // Per-dispatch timeout so a hung transport doesn't outlive its task. Without
    // this, the stale-heartbeat reclaim path could mark the task `blocked` while
    // an in-flight fetch is still running — two outcomes racing for one run.
    const timer = setTimeout(() => {
      controller.abort(new Error(`dispatch timeout after ${this.dispatchTimeoutMs}ms`));
    }, this.dispatchTimeoutMs);

    try {
      await this.dispatch({
        host,
        port,
        prompt,
        personalityId: assignee,
        signal: controller.signal,
      });
      // We do not auto-complete here — the assignee is responsible for calling
      // `kanban_complete` / `kanban_block` to record the outcome on the board.
    } catch (err) {
      // Graceful-shutdown aborts skip the block-write. Timeout-driven aborts
      // (signal.reason is an Error from our setTimeout above) flow through the
      // failure path so the task ends up `blocked` with a clear reason.
      const reason = controller.signal.reason;
      const timedOut = reason instanceof Error && /dispatch timeout/.test(reason.message);
      if (controller.signal.aborted && !timedOut) return;

      const error = timedOut
        ? (reason as Error)
        : err instanceof Error
          ? err
          : new Error(String(err));
      this.onError(error, task.id);
      try {
        this.board.blockRun(task.id, `dispatch failed: ${error.message}`);
      } catch {
        /* run may already be ended */
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Background-job variant of {@link fireDispatch}. Instead of awaiting a full
   * blocking run, it fires the peer's `/rpc` `spawn` method and returns as soon
   * as the peer has recorded the job. We do NOT mark the task done/blocked on
   * success — there is no completion to await here. The task remains tracked by
   * the kanban heartbeat/staleness machinery; the worker updates the board via
   * kanban tools as the background job runs. On a real transport failure (peer
   * unreachable, spawn rejected) we block the run, exactly like the blocking
   * path, so a claimed-but-never-started task surfaces on the board instead of
   * silently waiting for a heartbeat that will never come.
   */
  private async fireSpawnDispatch(
    task: Task,
    assignee: string,
    host: string,
    port: number,
    controller: AbortController,
  ): Promise<void> {
    const prompt = renderTaskPrompt(task);

    const timer = setTimeout(() => {
      controller.abort(new Error(`dispatch timeout after ${this.dispatchTimeoutMs}ms`));
    }, this.dispatchTimeoutMs);

    try {
      const { jobId } = await this.spawnDispatch({
        host,
        port,
        prompt,
        personalityId: assignee,
        signal: controller.signal,
      });
      // Job accepted and durably recorded on the peer (jobId). We intentionally
      // do not await completion: the assignee heartbeats and calls
      // `kanban_complete` / `kanban_block` as the background job progresses.
      void jobId;
    } catch (err) {
      const reason = controller.signal.reason;
      const timedOut = reason instanceof Error && /dispatch timeout/.test(reason.message);
      if (controller.signal.aborted && !timedOut) return;

      const error = timedOut
        ? (reason as Error)
        : err instanceof Error
          ? err
          : new Error(String(err));
      this.onError(error, task.id);
      try {
        this.board.blockRun(task.id, `dispatch failed: ${error.message}`);
      } catch {
        /* run may already be ended */
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

// Known limitation: this prompt assumes the assignee personality has
// kanban_complete / kanban_block / kanban_heartbeat in its toolset. The role
// gate would block the call if they DO have the tools but aren't the assignee;
// it doesn't help if the tools are absent entirely. Teams must add the kanban
// closer-tools to every member personality that can be assigned work. A future
// pass should validate this at `ethos team start` time, loading each member's
// toolset and refusing to boot when a closer-tool is missing.
function renderTaskPrompt(task: Task): string {
  const lines = [
    `## Task ${task.id}: ${task.title}`,
    '',
    task.body || '(no body)',
    '',
    `When you finish, call \`kanban_complete\` with a one-line summary.`,
    `If you get stuck, call \`kanban_block\` with the reason.`,
    `Heartbeat with \`kanban_heartbeat\` if the work takes longer than a minute.`,
    `Task id: \`${task.id}\` — pass this exact id to the kanban tools.`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default HTTP transport — doorbell POST to /notify
// ---------------------------------------------------------------------------

export const defaultDispatchCall: DispatchCall = async ({
  host,
  port,
  prompt,
  personalityId: _personalityId,
  signal,
  mode = 'notify+wake',
}) => {
  const url = `http://${host}:${port}/notify`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'kanban', ref: prompt, mode }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`/notify failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`/notify error: ${data.error ?? 'unknown'}`);
  }
  return 'notified';
};

// ---------------------------------------------------------------------------
// Background-job transport — JSON-RPC `spawn` over POST /rpc
// ---------------------------------------------------------------------------

export const defaultSpawnDispatchCall: SpawnDispatchCall = async ({
  host,
  port,
  prompt,
  personalityId,
  signal,
}) => {
  const url = `http://${host}:${port}/rpc`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'spawn',
      params: { text: prompt, personalityId },
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`/rpc spawn failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    result?: { jobId?: string; status?: string };
    error?: { message?: string };
  };
  if (data.error) {
    throw new Error(`/rpc spawn error: ${data.error.message ?? 'unknown'}`);
  }
  const jobId = data.result?.jobId;
  if (!jobId) {
    throw new Error('/rpc spawn error: response missing jobId');
  }
  return { jobId };
};
