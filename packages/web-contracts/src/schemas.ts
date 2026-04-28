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

// ---------------------------------------------------------------------------
// Skills — learning pillar of v0.5
//
// The Library panel reads `~/.ethos/skills/*.md`. Each file is a markdown
// document with optional OpenClaw frontmatter. The wire schema preserves
// the parsed frontmatter as a record so the editor UI can surface it
// alongside the markdown body without round-tripping through YAML.
// ---------------------------------------------------------------------------

export const SkillSchema = z.object({
  /** Filename minus `.md`. Stable handle the client passes back on update/delete. */
  id: z.string(),
  /** Display name. Pulled from frontmatter `name` if present, otherwise derived from id. */
  name: z.string(),
  /** Frontmatter `description`, or null if absent. */
  description: z.string().nullable(),
  /** Frontmatter as a parsed key-value record. Empty when the file has none. */
  frontmatter: z.record(z.string(), z.unknown()),
  /** Markdown body without the frontmatter block. */
  body: z.string(),
  /** ISO-8601 mtime so the UI can show "edited 2h ago". */
  modifiedAt: z.string(),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * A pending skill is a candidate that the SkillEvolver wrote to
 * `~/.ethos/skills/.pending/`. Approving moves it into the live skills
 * directory; rejecting deletes it.
 */
export const PendingSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  body: z.string(),
  /** ISO-8601 of when the candidate file was written. */
  proposedAt: z.string(),
});
export type PendingSkill = z.infer<typeof PendingSkillSchema>;

export const EvolveConfigSchema = z.object({
  rewriteThreshold: z.number().min(0).max(1),
  newSkillPatternThreshold: z.number().min(0).max(1),
  minRunsBeforeEvolve: z.number().int().nonnegative(),
  minPatternCount: z.number().int().nonnegative(),
});
export type EvolveConfigWire = z.infer<typeof EvolveConfigSchema>;

export const EvolverRunSchema = z.object({
  /** ISO-8601 of when the run completed. */
  ranAt: z.string(),
  /** Source eval-output file the run analyzed. */
  evalOutputPath: z.string(),
  rewritesProposed: z.number().int().nonnegative(),
  newSkillsProposed: z.number().int().nonnegative(),
  /** Skipped candidates with their reason from the LLM. */
  skipped: z.array(
    z.object({
      kind: z.enum(['rewrite', 'new']),
      target: z.string(),
      reason: z.string(),
    }),
  ),
});
export type EvolverRun = z.infer<typeof EvolverRunSchema>;

// ---------------------------------------------------------------------------
// Mesh — swarm pillar of v0.5
//
// Surfaces the agent-mesh extension state. Each peer reports its
// capabilities + current load; the route-test endpoint asks the mesh to
// route a synthetic task so the user can verify discovery + delivery
// without sending real work.
// ---------------------------------------------------------------------------

export const MeshAgentSchema = z.object({
  agentId: z.string(),
  /** Capability tokens declared by the peer (e.g. `code`, `web`, `delegate`). */
  capabilities: z.array(z.string()),
  /** Open sessions the peer is currently handling. */
  activeSessions: z.number().int().nonnegative(),
  /** Last heartbeat from this peer (ISO-8601). */
  lastSeenAt: z.string(),
});
export type MeshAgent = z.infer<typeof MeshAgentSchema>;

// ---------------------------------------------------------------------------
// Memory — v1
//
// The web tab edits the two markdown files MarkdownFileMemoryProvider
// reads (MEMORY.md and USER.md, scoped to the active personality if
// memoryScope is 'per-personality'). Vector-mode CRUD lands later —
// the contract is markdown-shaped for now.
// ---------------------------------------------------------------------------

export const MemoryStoreSchema = z.enum(['memory', 'user']);
export type MemoryStoreId = z.infer<typeof MemoryStoreSchema>;

export const MemoryFileSchema = z.object({
  store: MemoryStoreSchema,
  /** Markdown body. Empty string when the file doesn't exist on disk. */
  content: z.string(),
  /** Server-side absolute path. Used for diagnostic display only. */
  path: z.string(),
  /** ISO-8601 mtime, or null when the file doesn't exist. */
  modifiedAt: z.string().nullable(),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

export const MeshRouteResultSchema = z.object({
  ok: z.boolean(),
  /** Agent the mesh selected for the synthetic task, or null when no peer
   *  could handle the requested capability. */
  routedTo: z.string().nullable(),
  /** Optional human-readable explanation (e.g. "no peer offers `code`"). */
  reason: z.string().nullable(),
});
export type MeshRouteResult = z.infer<typeof MeshRouteResultSchema>;
