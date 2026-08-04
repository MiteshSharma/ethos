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

// ---------------------------------------------------------------------------
// Background job status
// ---------------------------------------------------------------------------

export type BackgroundJobStatus =
  | 'queued'
  | 'running'
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
  originPlatform?: string;
  originBotKey?: string;
  originChatId?: string;
  originThreadId?: string;
  remotePeer?: string;
  remoteJobId?: string;
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
  /** Terminal transition. Valid from running OR stale (a stale row that turns out alive recovers). */
  finish(
    id: string,
    terminal: 'done' | 'failed' | 'aborted',
    fields: { summary?: string; error?: string },
  ): Promise<void>;
  /** All jobs whose rootSessionKey === the given key, newest first. */
  listByRoot(rootSessionKey: string): Promise<BackgroundJob[]>;
  /** Count non-terminal (queued|running) jobs for a root. */
  countActiveByRoot(rootSessionKey: string): Promise<number>;
  /** Count non-terminal (queued|running) jobs for a personality. */
  countActiveByPersonality(personalityId: string): Promise<number>;
  /** running rows whose heartbeat is older than staleMs -> stale. Returns the rows transitioned. */
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
  /** Delete terminal rows whose finishedAt (or createdAt when unfinished) is < cutoffMs, plus their job_events. Returns the count deleted. Retention GC. */
  pruneTerminal(cutoffMs: number): Promise<number>;
  /** Append an audit event. Returns nothing. */
  appendEvent(
    jobId: string,
    eventType: BackgroundJobEventType,
    payload: Record<string, unknown>,
  ): Promise<void>;
  /** Ordered audit trail for a job (seq ASC). */
  getEvents(jobId: string): Promise<BackgroundJobEvent[]>;
}
