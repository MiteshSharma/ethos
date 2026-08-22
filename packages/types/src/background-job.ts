// ---------------------------------------------------------------------------
// Background jobs — durable spawn-and-continue delegation contract.
//
// A background job is a detached child agent turn: the parent spawns it, keeps
// running, and the child executes to completion under its own budget/heartbeat.
// This file is the persistence-layer-agnostic contract. The SQLite JobStore is
// the first implementation; the same interface is ported to Postgres behind a
// SaaS deployment later, so keep every method backend-neutral (no SQLite types
// leak through). Zero runtime deps — types and interfaces only.
// ---------------------------------------------------------------------------

import type { AgentEvent } from './agent-event';
import type { Logger } from './logger';
import type { SteerSink } from './steer';

// ---------------------------------------------------------------------------
// Background job status
//
// Run lifecycle (pi-delegation §13.2). If a later change alters a transition,
// this diagram moves in the same commit.
//
//    delegate_task(background: true)
//             │
//             ▼
//          QUEUED ──executor claims──►  RUNNING  ◄──────────────┐
//             │                          │ │ │ │                │
//             │                          │ │ │ └── elicitation ─┴─► BLOCKED
//             │                          │ │ │                        │
//             │                          │ │ │  ◄─── answer ──────────┘
//             │                          │ │ │
//             │                          │ │ └── heartbeat lost ──► STALE
//             │                          │ │                          │
//             │                          │ │        Resume (explicit, human) ─┐
//             │                          │ │                          ▲       │
//             │                          │ │        NO AUTO-RESUME ───┘       │
//             │                          │ │                                  ▼
//             │                          │ ├── cancelRequested ──► ABORTED   (re-queued)
//             │                          │ ├── spend > cap ──────► ABORTED
//             │                          │ ├── error ────────────► FAILED
//             │                          │ └── task.done ────────► DONE
//             └── never claimed ────────────────────────────────► EXPIRED
//
// `blocked` is a run parked on a HUMAN answer — non-terminal, still occupying a
// concurrency slot, and deliberately invisible to the heartbeat-staleness sweep:
// a question waiting on a person is not a dead host.
// ---------------------------------------------------------------------------

export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'stale'
  | 'expired';

// ---------------------------------------------------------------------------
// Background job — one durable row per detached child turn
// ---------------------------------------------------------------------------

export interface BackgroundJob {
  id: string; // opaque unique id (crypto.randomUUID())
  owner: string; // executing process identity, stamped at spawn
  parentSessionKey: string; // who spawned it
  rootSessionKey: string; // scoping key for task_* tools and every cap/roll-up
  childSessionKey: string; // `${parentSessionKey}:job:${label}:${id.slice(0,8)}`
  personalityId?: string; // same as parent's (guard-enforced)
  depth: number; // child depth (parent depth + 1)
  status: BackgroundJobStatus;
  label?: string; // slug-restricted at the tool boundary: [a-z0-9-]{1,32}
  prompt: string; // the child's task, stored for audit
  summary?: string; // capped digest once done
  error?: string; // set for failed/aborted/stale/expired
  spendUsd: number; // accumulated from child usage events
  maxCostUsd?: number; // per-job cap; executor aborts on breach
  cancelRequested?: boolean; // `cancel_requested` INTEGER column — ANY process may set it
  heartbeatAt?: number; // epoch ms, bumped by the executor on a ~30s timer per active job
  /** Epoch ms the run parked on a human answer. Set with `blocked`, cleared on resume. */
  blockedSince?: number;
  /**
   * The pending question this run is parked on — the same id space as
   * `PendingClarify.requestId` (see `./clarify`), so a surface can join the
   * parked run to the question that parked it.
   */
  blockedRequestId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /**
   * Epoch ms at which this job's completion notice was CLAIMED for delivery to
   * its origin lane — not proof the platform confirmed it. The claim is the
   * exactly-once gate (atomic, cross-process); once claimed, the outbound
   * delivery ledger owns retry. Absent means "terminal but never announced",
   * which is exactly what the restart sweep looks for.
   */
  deliveredAt?: number;
  // --- Phase B lane-resolution fields, added now so Phase B is not a migration.
  // Populated only when the spawn happens under a gateway lane; nullable/optional.
  originPlatform?: string;
  originBotKey?: string;
  originChatId?: string;
  originThreadId?: string;
  /**
   * Which runner executed this row (`JobRunner.name`, e.g. `ethos`). Absent on
   * rows written before the seam existed, and on rows that ran on the default
   * runner. Persisted because the badge renders from the row, not from a live
   * handle — `owner` is process identity, not runner kind.
   */
  runner?: string;
  // Remote proxy: set when this row tracks a background job running on a mesh peer
  // (created by route_to_agent background:true). A reconciler polls the peer and
  // mirrors status/spend/summary onto this row. No local executor runs a proxy.
  remotePeer?: string; // peer coordinates, e.g. "host:port" or the peer agentId
  remoteJobId?: string; // the job id on the peer
}

// ---------------------------------------------------------------------------
// Background job event — ordered audit trail per job
// ---------------------------------------------------------------------------

export type BackgroundJobEventType =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'heartbeat'
  | 'spend'
  | 'cancel_requested'
  | 'tool_headline'
  /** One child tool call finished — duration, ok/error. Pairs with `tool_headline`. */
  | 'tool_end'
  /**
   * A CHUNK of the child's own text output, persisted while the job runs so a
   * crash mid-job does not lose everything the child wrote. Chunked (never one
   * row per delta) — see the executor's text-flush policy.
   */
  | 'text'
  /** The run parked on a human answer. Payload carries the `requestId`. */
  | 'blocked'
  /** The human answered (or the question was withdrawn) — the run is running again. */
  | 'resumed'
  /**
   * One file the runner changed — payload is an `ArtifactChange` (see below).
   * Artifacts travel HERE and never through `AgentEvent`, which is frozen at 17
   * variants and has no artifact slot; the inspector's Diff tab reads this row
   * type back out of the event log.
   */
  | 'artifact_change'
  /**
   * A batch of the runner subprocess's own stdout/stderr lines (I-LOG1).
   * Payload carries `lines: { stream: 'stdout' | 'stderr'; line: string }[]`
   * and an optional `dropped` count when the write-side buffer cap evicted
   * older lines to bound memory. Same rationale as `artifact_change`: this is
   * out-of-band audit-trail data, not an `AgentEvent` — `task_logs` reads this
   * row type back out of the event log the same way it reads every other kind.
   */
  | 'runner_log'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'stale'
  | 'expired'
  | 'recovered';

export interface BackgroundJobEvent {
  id: number;
  jobId: string;
  seq: number;
  eventType: BackgroundJobEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// JobStore — persistence contract
// ---------------------------------------------------------------------------

export interface CreateBackgroundJobInput {
  owner: string;
  parentSessionKey: string;
  rootSessionKey: string;
  childSessionKey: string;
  personalityId?: string;
  depth: number;
  label?: string;
  prompt: string;
  maxCostUsd?: number;
  /** Runner that should execute this job. Omitted means the executor's default. */
  runner?: string;
  originPlatform?: string;
  originBotKey?: string;
  originChatId?: string;
  originThreadId?: string;
  remotePeer?: string;
  remoteJobId?: string;
}

/** Window over a job's event trail. Both fields are optional; see `getEvents`. */
export interface GetJobEventsOptions {
  /** Return at most this many rows, taken from the NEWEST end. */
  limit?: number;
  /** Exclusive cursor — only rows with `seq` strictly less than this. */
  beforeSeq?: number;
}

export interface JobStore {
  /** Insert a new queued job. Returns the created row. */
  create(input: CreateBackgroundJobInput): Promise<BackgroundJob>;
  get(id: string): Promise<BackgroundJob | null>;
  /** Atomically transition the oldest queued row owned by `owner` to running; returns it, or null if none. */
  claimNextQueued(owner: string): Promise<BackgroundJob | null>;
  /** Bump heartbeatAt to now. No-op if the row is not running. */
  heartbeat(id: string): Promise<void>;
  /** Set accumulated spend for a job (absolute value). */
  updateSpend(id: string, spendUsd: number): Promise<void>;
  /** Set cancel_requested = 1. Any process may call. */
  requestCancel(id: string): Promise<void>;
  /**
   * Park a RUNNING job on a human answer: status -> `blocked`, stamping
   * `blockedSince` and `blockedRequestId`. No-op when the row is not `running`
   * (it was cancelled or finished out from under the caller) — same fail-quiet
   * shape as `heartbeat`.
   */
  markBlocked(id: string, requestId: string): Promise<void>;
  /**
   * Un-park a BLOCKED job: status -> `running`, clearing the blocked fields and
   * bumping `heartbeatAt` to now. The bump is load-bearing — a run parked longer
   * than `staleMs` would otherwise be swept stale in the window between resuming
   * and the executor's next beat. No-op when the row is not `blocked`.
   */
  resumeFromBlocked(id: string): Promise<void>;
  /**
   * Terminal transition. Valid from running, stale (a stale row that turns out
   * alive recovers) OR blocked (a parked run is still cancellable, and §4.1's
   * blocked card offers Cancel). `blocked` is never a terminal ARGUMENT — it is
   * a distinct transition, reached only through `markBlocked`.
   */
  finish(
    id: string,
    terminal: 'done' | 'failed' | 'aborted',
    fields: { summary?: string; error?: string },
  ): Promise<void>;
  /** All jobs whose rootSessionKey === the given key, newest first. */
  listByRoot(rootSessionKey: string): Promise<BackgroundJob[]>;
  /** Count non-terminal (queued|running|blocked) jobs for a root. A parked run still holds its slot. */
  countActiveByRoot(rootSessionKey: string): Promise<number>;
  /** Count non-terminal (queued|running|blocked) jobs for a personality. A parked run still holds its slot. */
  countActiveByPersonality(personalityId: string): Promise<number>;
  /**
   * running rows whose heartbeat is older than staleMs -> stale. Returns the rows
   * transitioned. `blocked` rows are IGNORED — a parked human question must never
   * look like a dead host.
   */
  reclaimStale(staleMs: number): Promise<BackgroundJob[]>;
  /** queued rows older than ttlMs -> expired. Returns the rows transitioned. */
  expireQueued(ttlMs: number): Promise<BackgroundJob[]>;
  /** Running rows that track a remote job (remoteJobId set) — for the mesh proxy reconciler. */
  listRunningRemote(): Promise<BackgroundJob[]>;
  /**
   * Announceable jobs (`done`/`failed`) that carry a full origin lane, are owned
   * by one of `originBotKeys`, and have never been claimed for delivery. Oldest
   * first — the restart sweep replays completions in the order they finished.
   *
   * Ownership is a filter, not a suggestion: a deployment sharing a jobs.db must
   * never announce another deployment's completions.
   */
  listUndelivered(originBotKeys: string[]): Promise<BackgroundJob[]>;
  /**
   * Atomically claim this job's completion for delivery: sets `deliveredAt` only
   * if it was unset. Returns whether THIS caller won. Two processes racing at
   * boot therefore announce a completion exactly once.
   */
  claimDelivery(id: string): Promise<boolean>;
  /** Hand a claim back (`deliveredAt` → unset) when the send could not be made durable. */
  releaseDelivery(id: string): Promise<void>;
  /**
   * G5 — the SECOND delivery claim, and deliberately not `deliveredAt`.
   *
   * `deliveredAt` is spent on the job's ONE completion notice. A mid-run
   * "needs you" push (§4.6 rung 3) is a different message, can happen more than
   * once per job (a run parks on a question, resumes, parks on another), and
   * must not consume the claim the done-notice needs. So it is keyed by the
   * pending question's `requestId`, not by the job id.
   *
   * Atomic and exactly-once across processes, same guarantee as
   * `claimDelivery`: returns whether THIS caller won. Two gateway processes
   * sweeping the same shared store push a given question's notice exactly once.
   * `jobId` is stored for the audit trail and for retention pruning, not for
   * the key.
   */
  claimNotice(requestId: string, jobId: string): Promise<boolean>;
  /** Hand a notice claim back when the send could not be made durable. */
  releaseNotice(requestId: string): Promise<void>;
  /** Delete terminal rows whose finishedAt (or createdAt when unfinished) is < cutoffMs, plus their job_events. Returns the count deleted. Retention GC. */
  pruneTerminal(cutoffMs: number): Promise<number>;
  /** Append an audit event. Returns nothing. */
  appendEvent(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Ordered audit trail for a job, ALWAYS returned seq ASC.
   *
   * `opts.limit` selects the NEWEST n rows (then returns them ascending — the
   * same most-recent-N contract `SessionStore.getMessages` uses), and
   * `opts.beforeSeq` is the backwards-paging cursor: pass the lowest `seq` you
   * already hold to get the page older than it. Omitting `opts` returns the
   * whole trail, unchanged — a caller that wants a bound says so, so nothing is
   * ever silently truncated under a reader expecting everything.
   */
  getEvents(jobId: string, opts?: GetJobEventsOptions): Promise<BackgroundJobEvent[]>;
}

// ---------------------------------------------------------------------------
// Run update digest — the run card's liveness feed (pi-delegation D11/D20, G9)
// ---------------------------------------------------------------------------

/**
 * One coalesced liveness sample for a run, published by the executor at <=1 Hz
 * per job. It exists because a job's own events fire on `childSessionKey`, which
 * nobody watching the PARENT chat is subscribed to — so a card fed by those
 * would render once and freeze at `queued` (G9).
 *
 * The digest is deliberately NOT an `AgentEvent` (that contract is frozen at 17
 * types, D3). The surface that owns a session stream maps this onto its own
 * push event — `run.update` in `@ethosagent/web-contracts` — which is why every
 * field below except `parentSessionKey` is exactly that event's payload.
 * `parentSessionKey` is the ROUTING key, not part of the payload: it says which
 * conversation the card lives in.
 */
export interface RunUpdateDigest {
  /** Where the card lives. The parent's session key, never the child's. */
  parentSessionKey: string;
  jobId: string;
  /** `JobRunner.name` — resolved to a label/accent by the surface, never rendered raw. */
  runner: string;
  status: BackgroundJobStatus;
  /**
   * The card's `now` line: one line of FACT about what the run is doing,
   * REPLACED never appended. The executor never puts UI copy here — a parked or
   * lost run sends an empty string and the surface substitutes its own normative
   * phrasing, so the copy contract stays in one place.
   */
  now: string;
  elapsedMs: number;
  spendUsd: number;
  toolCount: number;
}

// ---------------------------------------------------------------------------
// JobRunner — the pluggable seam between the executor and whatever actually
// runs the child turn.
//
// The executor owns the durable row, the abort controller, the heartbeat, the
// spend cap, and the terminal transition. A runner owns exactly one thing:
// turning a job into a stream of AgentEvents. `run()` is the only verb — the
// runner honours cancellation and steering, it does not own them.
// ---------------------------------------------------------------------------

/**
 * One row of the session detail grid. The shared rows are the UI's fixed
 * contract; these are the runner's own, so a second harness adds its vocabulary
 * without touching the component.
 *
 * `tone` is a claim about the value, not decoration: `safe` is a fact something
 * enforces, `warn` is a claim nothing enforces. A row is a fact or it is a
 * warning, never a hope.
 */
export interface DetailRow {
  label: string;
  value: string;
  tone?: 'accent' | 'safe' | 'warn';
}

/**
 * One file the runner changed. Artifacts never enter the AgentEvent stream (it
 * is frozen and has no artifact variant) — they travel out-of-band to the job
 * event log, and the inspector's Diff tab reads them from there.
 */
export interface ArtifactChange {
  /** Workspace-relative path. */
  path: string;
  change: 'created' | 'modified' | 'deleted';
  /** Line counts for the `+n / −n` file list. */
  added: number;
  removed: number;
  /** Unified diff, when the runner has one to give. */
  diff?: string;
}

export interface JobRunnerContext {
  /** The executor's per-job AbortController signal, driven by `cancelRequested`. */
  signal: AbortSignal;
  /** Steering channel — the runner drains it; it does not own the semantic. */
  steerSink: SteerSink;
  /** Out-of-band sink for file changes. NOT AgentEvents. */
  emitArtifact(change: ArtifactChange): void;
  /**
   * Out-of-band sink for the runner subprocess's own stdout/stderr (I-LOG1),
   * one already-split line at a time. NOT an AgentEvent — the executor
   * batches lines into a bounded `runner_log` job_event, same rationale as
   * `emitArtifact`. Synchronous by contract: a runner does not await the
   * audit trail.
   */
  appendLog(stream: 'stdout' | 'stderr', line: string): void;
}

/**
 * What this harness can actually do. Declared per runner, never inferred from
 * its name — surfaces hide affordances a runner does not support.
 */
export interface RunnerCapabilities {
  /** Interaction kinds this runner can emit. Open strings — never a union. */
  interactionKinds: readonly string[];
  /** Answer scopes the runner honours; a one-shot runner declares `['once']`. */
  answerScopes: readonly ('once' | 'run' | 'always')[];
  /** Terminal takeover: the attach button renders only for `'pty'`. */
  takeover: 'pty' | 'none';
  /** `'none'` means Resume is never offered. */
  resume: 'session' | 'fork' | 'none';
  /** `false` ⇒ hide Interrupt. */
  steer: boolean;
  sandbox: 'process' | 'external' | 'none';
  /** Informational, for the detail grid (e.g. `JSON-RPC 2.0 · stdio`). */
  transport: string;
}

export interface JobRunner {
  /**
   * Open string, resolved through `JobRunnerRegistry`. NOT a union — narrowing
   * this to a fixed set is what makes runner three a types-package change.
   */
  readonly name: string;
  readonly capabilities: RunnerCapabilities;
  isAvailable(): Promise<boolean>;
  /** Runner-specific rows for the session detail grid. */
  describe(job: BackgroundJob): DetailRow[];
  /** Run one job to completion, yielding the child turn's events. */
  run(job: BackgroundJob, ctx: JobRunnerContext): AsyncIterable<AgentEvent>;
}

export interface JobRunnerFactoryContext {
  logger: Logger;
}

export type JobRunnerFactory = (ctx: JobRunnerFactoryContext) => JobRunner | Promise<JobRunner>;

/** Mirrors `ExecutionBackendRegistry`: register a factory → resolve an instance → get it. */
export interface JobRunnerRegistry {
  register(name: string, factory: JobRunnerFactory): void;
  resolve(name: string, ctx: JobRunnerFactoryContext): Promise<JobRunner>;
  get(name: string): JobRunner | undefined;
  list(): string[];
}
