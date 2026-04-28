import { z } from 'zod';
import { ApprovalRequestSchema, MessageRoleSchema } from './schemas';

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
});

export const ToolProgressEventSchema = z.object({
  type: z.literal('tool_progress'),
  toolName: z.string(),
  message: z.string(),
  percent: z.number().min(0).max(100).optional(),
  audience: z.enum(['internal', 'user']),
});

export const ToolEndEventSchema = z.object({
  type: z.literal('tool_end'),
  toolCallId: z.string(),
  toolName: z.string(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  audience: z.enum(['internal', 'user']).optional(),
  /** Tool output body — success value or error message. The web chip
   *  surfaces it on click-to-expand without a follow-up history fetch. */
  result: z.string().optional(),
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
  CronFiredEventSchema,
  MeshChangedEventSchema,
  EvolveSkillPendingEventSchema,
  ProtocolUpgradeRequiredEventSchema,
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

/** Discriminator literal for narrowing in client code. */
export type SseEventType = SseEvent['type'];
