import { z } from 'zod';
import { ApprovalRequestSchema, BackgroundJobStatusSchema, MessageRoleSchema } from './schemas';

// SSE event union. The server writes these as `data: <JSON>` lines on the
// `/sse/sessions/:id` endpoint, with monotonic `id:` lines so the browser
// auto-resumes via `Last-Event-ID` after a disconnect.
//
// Two families of events flow through the same channel:
//   1. Per-turn events (mirror `AgentEvent` from @ethosagent/core)
//   2. Push events surfaced regardless of which session the user is viewing
//      (cron firings, mesh changes, evolved-skill review queue, multi-window
//      approval resolution from another tab).
//
// Both families share a discriminator `type` so the client can `switch (e.type)`
// without first checking which family it belongs to.

// ---------------------------------------------------------------------------
// Per-turn events
// ---------------------------------------------------------------------------

export const TextDeltaEventSchema = z.object({
  type: z.literal('text_delta'),
  text: z.string(),
});

export const ThinkingDeltaEventSchema = z.object({
  type: z.literal('thinking_delta'),
  thinking: z.string(),
});

export const ToolStartEventSchema = z.object({
  type: z.literal('tool_start'),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  /** Lane E (tools-as-code-api) — 'internal' marks in-script inner calls;
   *  the web chat MUST NOT render a chip for them. */
  audience: z.enum(['internal', 'user', 'dashboard']).optional(),
});

export const ToolProgressEventSchema = z.object({
  type: z.literal('tool_progress'),
  toolName: z.string(),
  message: z.string(),
  percent: z.number().min(0).max(100).optional(),
  audience: z.enum(['internal', 'user', 'dashboard']),
});

export const ToolEndEventSchema = z.object({
  type: z.literal('tool_end'),
  toolCallId: z.string(),
  toolName: z.string(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  audience: z.enum(['internal', 'user', 'dashboard']).optional(),
  /** Tool output body — success value or error message. The web chip
   *  surfaces it on click-to-expand without a follow-up history fetch. */
  result: z.string().optional(),
  /** Structured payload for rich-content rendering (e.g. _uiType: 'image' | 'html'). */
  structured: z.record(z.string(), z.unknown()).optional(),
});

export const UsageEventSchema = z.object({
  type: z.literal('usage'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
});

export const ContextMetaEventSchema = z.object({
  type: z.literal('context_meta'),
  data: z.record(z.string(), z.unknown()),
});

export const TurnDoneEventSchema = z.object({
  type: z.literal('done'),
  text: z.string(),
  turnCount: z.number().int().nonnegative(),
  /** B3 (additive-optional) — the turn's observability trace id, mirrored from
   *  the `done` AgentEvent. Absent when the server has no observability
   *  adapter wired. */
  traceId: z.string().optional(),
});

export const TurnErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z.string(),
  code: z.string(),
});

export const MessagePersistedEventSchema = z.object({
  type: z.literal('message_persisted'),
  messageId: z.string(),
  role: MessageRoleSchema,
});

// ---------------------------------------------------------------------------
// Push events (not tied to the active turn)
// ---------------------------------------------------------------------------

export const ToolApprovalRequiredEventSchema = z.object({
  type: z.literal('tool.approval_required'),
  request: ApprovalRequestSchema,
});

export const ApprovalResolvedEventSchema = z.object({
  type: z.literal('approval.resolved'),
  approvalId: z.string(),
  decision: z.enum(['allow', 'deny']),
  decidedBy: z.string(), // clientId of the resolving tab
});

export const CronFiredEventSchema = z.object({
  type: z.literal('cron.fired'),
  jobId: z.string(),
  ranAt: z.string(), // ISO-8601
  outputPath: z.string().nullable(),
  sessionKey: z.string().optional(),
});

// The `clarify` tool asked the user a question mid-turn. Pushed (not a turn
// event) so a browser refresh / SSE reconnect re-presents any pending clarify.
export const ClarifyRequestEventSchema = z.object({
  type: z.literal('clarify.request'),
  requestId: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
  default: z.string().optional(),
  /**
   * The delegated run that asked, when one did (`PendingClarify.jobId`, D22).
   * Absent for a foreground clarify. This is what lets a question be drawn
   * INSIDE its run card (§4.5) instead of as a floating modal that says
   * nothing about who is waiting on the answer.
   */
  jobId: z.string().optional(),
  /**
   * ISO-8601 — when the timeout fires and the default is used. `null` while
   * queued behind another clarify in the same lane (D2) — a queued row has no
   * timer running yet. In practice this event is only pushed once a row is
   * actually presented, so `null` should not occur here today; nullable for
   * type-level parity with `PendingClarify.defaultDeadlineAt`.
   */
  defaultDeadlineAt: z.string().nullable(),
});

// A delegated run's coalesced liveness digest, published by the executor onto
// the PARENT session's stream at <=1 Hz per run (pi-delegation D11/D20). It is a
// PUSH-family event and deliberately NOT an `AgentEvent`: the run card is fed by
// this digest alone — no second SSE connection — while the runner's full event
// stream stays on the child session. Adding an 18th `AgentEvent` type instead
// would void D3.
export const RunUpdateEventSchema = z.object({
  type: z.literal('run.update'),
  jobId: z.string(),
  /** Which harness is executing — resolved through the `RUNNERS` identity map (D19), never rendered raw. */
  runner: z.string(),
  status: BackgroundJobStatusSchema,
  /**
   * The card's `now` line: one line of prose, REPLACED never appended
   * (`editing packages/core/src/auth/session-token.ts`,
   * `paused — waiting on you`, `finished — 5 files changed`).
   */
  now: z.string(),
  elapsedMs: z.number().nonnegative(),
  spendUsd: z.number().nonnegative(),
  toolCount: z.number().int().nonnegative(),
});

export const ClarifyResolvedEventSchema = z.object({
  type: z.literal('clarify.resolved'),
  requestId: z.string(),
  source: z.enum(['user', 'timeout-default', 'timeout-no-default', 'cancel']),
});

export const MeshChangedEventSchema = z.object({
  type: z.literal('mesh.changed'),
  agents: z.array(
    z.object({
      agentId: z.string(),
      capabilities: z.array(z.string()),
      activeSessions: z.number().int().nonnegative(),
    }),
  ),
});

export const EvolveSkillPendingEventSchema = z.object({
  type: z.literal('evolve.skill_pending'),
  skillId: z.string(),
  personalityId: z.string().nullable(),
  proposedAt: z.string(), // ISO-8601
});

export const EvolveSkillAppliedEventSchema = z.object({
  type: z.literal('evolve.skill_applied'),
  skillId: z.string(),
  personalityId: z.string().nullable(),
  appliedAt: z.string(), // ISO-8601
});

export const NotificationEventSchema = z.object({
  type: z.literal('notification'),
  message: z.string(),
  source: z.string().optional(),
});

// Proactive memory capture landed a durable fact (memory-experience §3.3).
// Pushed (not a turn event) because capture completes AFTER the turn's chat
// stream closes — it's queued post-`done` and runs a cheap extraction pass, so
// it can't ride the turn SSE as an AgentEvent. The web UI surfaces it as a
// quiet "· remembered: …" toast, the same live feedback the CLI already prints.
export const MemoryCapturedEventSchema = z.object({
  type: z.literal('memory.captured'),
  summary: z.string(),
});

export const DryRunToolPlanSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
});

export const DryRunSummaryEventSchema = z.object({
  type: z.literal('dry_run_summary'),
  plan: z.array(DryRunToolPlanSchema),
  capped: z.number().int().nonnegative(),
});

export const RunStartEventSchema = z.object({
  type: z.literal('run_start'),
  provider: z.string(),
  model: z.string(),
  source: z.enum(['team-coordinator', 'team-personality', 'personality', 'global']),
  /** B3 (additive-optional) — the turn's observability trace id. This is the
   *  turn identity a tab quotes in a bug report; it joins the SSE stream to
   *  `observability.db`, `messages.trace_id`, and (later) the provider request
   *  ids on the turn's `llm_call` spans. */
  traceId: z.string().optional(),
});

// B1 — the FIRST frame of every `/sse/sessions/:id` stream. Carries the
// `x-request-id` of the SSE request itself. The same id is on the response's
// `x-request-id` header, but `EventSource` gives browser clients no way to
// read response headers, so the id has to ride the stream to be quotable from
// the UI. Written outside the replay buffer (no `id:` line), so it never
// disturbs `Last-Event-ID` resume.
export const StreamMetaEventSchema = z.object({
  type: z.literal('stream_meta'),
  requestId: z.string(),
});

export const ProtocolUpgradeRequiredEventSchema = z.object({
  type: z.literal('protocol.upgrade_required'),
  serverVersion: z.string(),
  clientVersionExpected: z.string(),
});

// ---------------------------------------------------------------------------
// Combined union — one schema covers every event the server may send.
// ---------------------------------------------------------------------------

export const SseEventSchema = z.discriminatedUnion('type', [
  TextDeltaEventSchema,
  ThinkingDeltaEventSchema,
  ToolStartEventSchema,
  ToolProgressEventSchema,
  ToolEndEventSchema,
  UsageEventSchema,
  ContextMetaEventSchema,
  TurnDoneEventSchema,
  TurnErrorEventSchema,
  MessagePersistedEventSchema,
  ToolApprovalRequiredEventSchema,
  ApprovalResolvedEventSchema,
  ClarifyRequestEventSchema,
  RunUpdateEventSchema,
  ClarifyResolvedEventSchema,
  CronFiredEventSchema,
  MeshChangedEventSchema,
  EvolveSkillPendingEventSchema,
  EvolveSkillAppliedEventSchema,
  NotificationEventSchema,
  MemoryCapturedEventSchema,
  DryRunSummaryEventSchema,
  RunStartEventSchema,
  StreamMetaEventSchema,
  ProtocolUpgradeRequiredEventSchema,
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

/** Discriminator literal for narrowing in client code. */
export type SseEventType = SseEvent['type'];

/** The `clarify.request` push event — surfaced as a card in the web UI. */
export type ClarifyRequestEvent = z.infer<typeof ClarifyRequestEventSchema>;

/** The `run.update` push event — the run card's ≤1 Hz liveness digest. */
export type RunUpdateEvent = z.infer<typeof RunUpdateEventSchema>;

// ---------------------------------------------------------------------------
// Activity envelope — NOT a member of the `SseEvent` union; it WRAPS one.
// ---------------------------------------------------------------------------

/**
 * One row on the merged activity stream (`GET /sse/activity`). The same
 * `SseEvent` the per-session stream carries, tagged with the session it came
 * from and that session's personality so a subscriber can scope the feed to a
 * single agent (or watch every agent at once).
 *
 * `personalityId` is null when the session has no personality, or when the
 * server could not attribute it at append time (see `ChatService`'s
 * best-effort session→personality cache).
 */
export const ActivityEventSchema = z.object({
  sessionId: z.string(),
  personalityId: z.string().nullable(),
  event: SseEventSchema,
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/**
 * The `SseEvent` types the activity feed carries — the ONE list, shared by both
 * ends. The server (`ChatService.append`) drops everything else before it ever
 * reaches the activity buffer, and the client's `convertSseEvent` drops
 * everything else before it becomes a row. Two lists would drift, and the cost
 * of that drift is asymmetric: a type the server admits but the client discards
 * is a system-wide fan-out of events nobody renders.
 *
 * Excluded on purpose: `text_delta`, `thinking_delta`, `usage`, `context_meta`,
 * `stream_meta`, `protocol.upgrade_required`. Those are per-token /
 * per-connection plumbing, not discrete actions — fanning every streamed token
 * of every session out to every activity listener would also burn the replay
 * buffer down in seconds, collapsing the resume window for everything real.
 */
export const ACTIVITY_EVENT_TYPES: ReadonlySet<SseEventType> = new Set<SseEventType>([
  'tool_start',
  'tool_progress',
  'tool_end',
  'done',
  'error',
  'message_persisted',
  'tool.approval_required',
  'approval.resolved',
  'cron.fired',
  'clarify.request',
  'clarify.resolved',
  'run.update',
  'run_start',
  'mesh.changed',
  'evolve.skill_pending',
  'evolve.skill_applied',
  'notification',
  'memory.captured',
  'dry_run_summary',
]);
