import { z } from 'zod';

// Wire-format schemas. These mirror the in-memory shapes from
// `@ethosagent/types` (Session, StoredMessage, PersonalityConfig, etc.) but
// strip server-internal fields (filesystem paths, loader-populated metadata)
// before they reach the client.
//
// All `Date` values cross the wire as ISO-8601 strings.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SessionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  apiCallCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  key: z.string(),
  platform: z.string(),
  model: z.string(),
  provider: z.string(),
  personalityId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  workingDir: z.string().nullable(),
  title: z.string().nullable(),
  usage: SessionUsageSchema,
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
});
export type Session = z.infer<typeof SessionSchema>;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'tool_result', 'system']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const StoredMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolCalls: z.array(ToolCallSchema).nullable(),
  timestamp: z.string(), // ISO-8601
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

// ---------------------------------------------------------------------------
// Personalities
//
// `id` / `name` / `description` / `model` / `memoryScope` / `streamingTimeoutMs`
// are user-facing fields from PersonalityConfig. `ethosFile` / `skillsDirs`
// (server filesystem paths) are intentionally NOT in the wire schema.
// ---------------------------------------------------------------------------

export const MemoryScopeSchema = z.enum(['global', 'per-personality']);

export const PersonalitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  toolset: z.array(z.string()).nullable(),
  capabilities: z.array(z.string()).nullable(),
  memoryScope: MemoryScopeSchema.nullable(),
  streamingTimeoutMs: z.number().int().positive().nullable(),
  /** True when the personality lives in the package's built-in data directory
   *  (read-only). User-created personalities under `~/.ethos/personalities/`
   *  are mutable. */
  builtin: z.boolean(),
});
export type Personality = z.infer<typeof PersonalitySchema>;

// ---------------------------------------------------------------------------
// Tool approval (used by SSE push + tools.approve/deny RPCs)
// ---------------------------------------------------------------------------

export const ApprovalScopeSchema = z.enum([
  'once', // Allow this single invocation
  'exact-args', // Allow this tool with these exact arguments
  'any-args', // Allow this tool with any arguments
]);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalRequestSchema = z.object({
  approvalId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  reason: z.string().nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const OnboardingStepSchema = z.enum([
  'welcome',
  'provider',
  'personality',
  'integrations',
  'first-turn',
  'done',
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const ProviderIdSchema = z.enum(['anthropic', 'openrouter', 'openai-compat', 'ollama']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

// ---------------------------------------------------------------------------
// Cron — proactive pillar of v0.5
//
// Mirrors the `CronJob` shape from `@ethosagent/cron`. Wire-side uses
// nullable instead of optional for fields that may legitimately be unset
// on disk, so the client doesn't have to guess between "missing" and
// "explicitly null".
// ---------------------------------------------------------------------------

export const JobStatusSchema = z.enum(['active', 'paused']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const MissedRunPolicySchema = z.enum(['run-once', 'skip']);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicySchema>;

export const CronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 5-field cron expression e.g. `0 8 * * 1-5`. */
  schedule: z.string(),
  prompt: z.string(),
  personality: z.string().nullable(),
  /** Delivery target — `cli` / `telegram` / etc. Null means "store output to disk only". */
  deliver: z.string().nullable(),
  status: JobStatusSchema,
  missedRunPolicy: MissedRunPolicySchema,
  /** ISO-8601 of last run, or null if never run. */
  lastRunAt: z.string().nullable(),
  /** ISO-8601 of next scheduled run, or null when paused / unscheduled. */
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CronJob = z.infer<typeof CronJobSchema>;

export const CronRunSchema = z.object({
  /** ISO-8601 timestamp parsed from the output filename. */
  ranAt: z.string(),
  /** Server-side absolute path to the output file. The client treats it
   *  as opaque and uses it to fetch full output via cron.history. */
  outputPath: z.string(),
  /** Full output body — present when the run is the head of `cron.history`
   *  and inline-fetched. Listed runs leave it absent for compactness. */
  output: z.string().nullable(),
});
export type CronRun = z.infer<typeof CronRunSchema>;
