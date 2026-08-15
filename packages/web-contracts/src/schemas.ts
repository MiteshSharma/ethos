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
  pinned: z.boolean(),
  usage: SessionUsageSchema,
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
  /** Optimistic-concurrency version. v1 always returns 1. */
  version: z.number().int(),
});
export type Session = z.infer<typeof SessionSchema>;

export const MessageRoleSchema = z.enum([
  'user',
  'assistant',
  'tool_result',
  'system',
  'user_steer',
]);
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
// `id` / `name` / `description` / `model` / `streamingTimeoutMs`
// are user-facing fields from PersonalityConfig. `soulFile` / `skillsDirs`
// (server filesystem paths) are intentionally NOT in the wire schema.
// ---------------------------------------------------------------------------

export const ModelTierConfigSchema = z.object({
  trivial: z.string().optional(),
  default: z.string().optional(),
  deep: z.string().optional(),
});
export type ModelTierConfigWire = z.infer<typeof ModelTierConfigSchema>;

export const PersonalitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  model: z.union([z.string(), ModelTierConfigSchema]).nullable(),
  provider: z.string().nullable(),
  toolset: z.array(z.string()).nullable(),
  capabilities: z.array(z.string()).nullable(),
  streamingTimeoutMs: z.number().int().positive().nullable(),
  /** Allowed MCP server names. null = not configured (no access). */
  mcp_servers: z.array(z.string()).nullable(),
  /** Attached plugin ids. null = not configured (default-deny). */
  plugins: z.array(z.string()).nullable(),
  fs_reach: z
    .object({
      read: z.array(z.string()).nullable(),
      write: z.array(z.string()).nullable(),
      /** Declared working directory, substitution tokens unresolved. null =
       *  undeclared (the agent falls back to the process working directory). */
      workdir: z.string().nullable(),
    })
    .nullable(),
  /** Idle-time dreaming state. Optional (omitted when unset) so the editor
   *  can read the current toggle and cadence without affecting other surfaces. */
  dreaming: z
    .object({
      enable: z.boolean(),
      idleMinutes: z.number().int().optional(),
      maxPerDay: z.number().int().optional(),
    })
    .optional(),
  /** Governed-learning approval dial. Optional (omitted when unset) so the
   *  editor can read the current value to populate its form. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  /** Skill-evolution tuning. Optional (omitted when unset) so the editor can
   *  read the current values to populate its form. */
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().optional(),
      cooldown_minutes: z.number().int().optional(),
      model: z.string().optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Per-personality safety dial. Optional (omitted when unset) so the editor
   *  can read the current approval mode to populate its form. */
  safety: z.object({ approvalMode: z.enum(['manual', 'smart', 'off']).optional() }).optional(),
  /** Per-personality memory backend. Optional (omitted when unset) so the
   *  editor can read the current provider to populate its form. */
  memory: z.object({ provider: z.string().optional() }).optional(),
  /** Nightly governed-learning gates. Optional (omitted when unset) so the
   *  editor can read the current toggles to populate its form. */
  nightly: z
    .object({
      enabled: z.boolean().optional(),
      judge: z
        .object({
          enabled: z.boolean().optional(),
          minInteractions: z.number().int().optional(),
        })
        .optional(),
      expression: z.boolean().optional(),
    })
    .optional(),
  /** How this personality sounds, listens, and looks on a call — the sub-keys
   *  the editor writes: `voice.tts_provider` / `voice.stt_provider` /
   *  `voice.realtime_provider` (roster labels), `voice.tts_voice`,
   *  `voice.call_style`, `voice.tier`, `voice.model` and the
   *  `voice.languages.<tag>` map. Read back so the editor can populate its form
   *  — a field the editor cannot READ is a field a save silently erases.
   *  Omitted when the personality declares no voice. */
  voice: z
    .object({
      tts_provider: z.string().optional(),
      stt_provider: z.string().optional(),
      realtime_provider: z.string().optional(),
      tts_voice: z.string().optional(),
      call_style: z.enum(['liquid', 'orb', 'rings']).optional(),
      tier: z.enum(['pipeline', 'realtime']).optional(),
      model: z.string().optional(),
      languages: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  system: z.boolean(),
  /** True when the personality lives in the package's built-in data directory
   *  (read-only). User-created personalities under `~/.ethos/personalities/`
   *  are mutable. */
  builtin: z.boolean(),
  /** Optimistic-concurrency version. v1 always returns 1. */
  version: z.number().int(),
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

export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'openrouter',
  'openai-compat',
  'ollama',
  'azure',
  'codex',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderEntrySchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  apiKeyPreview: z.string(),
  baseUrl: z.string().nullable(),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

// ---------------------------------------------------------------------------
// Cron — proactive pillar of v0.5
//
// Mirrors the `CronJob` shape from `@ethosagent/cron`. Wire-side uses
// nullable instead of optional for fields that may legitimately be unset
// on disk, so the client doesn't have to guess between "missing" and
// "explicitly null".
// ---------------------------------------------------------------------------

export const JobStatusSchema = z.enum(['active', 'paused', 'done']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const MissedRunPolicySchema = z.enum(['run-once', 'skip']);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicySchema>;

export const CronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 5-field cron expression e.g. `0 8 * * 1-5`. */
  schedule: z.string(),
  prompt: z.string(),
  personalityId: z.string(),
  /** Delivery target — derived from origin platform. Null means "store output to disk only". */
  deliver: z.string().nullable(),
  status: JobStatusSchema,
  missedRunPolicy: MissedRunPolicySchema,
  source: z.enum(['system', 'user']).default('user'),
  systemTask: z.string().nullable().optional(),
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
  source: z.enum(['system', 'user', 'evolver', 'personality']),
  readonly: z.boolean(),
  /** Gap 11 — non-null when the skill failed an `ethos.requires` gate at load time. */
  unavailableReason: z.string().nullable().optional(),
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
  autoApprove: z.boolean(),
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
// Lab — Batch + Eval (v1)
//
// Both surfaces wrap long-running runners (BatchRunner, EvalRunner)
// from their respective extensions. The wire shape is "submit
// + poll" — start returns a run id, list/get return live state, the
// runner streams progress through `onProgress` callbacks the service
// caches into the run state. Cancel is deferred — the existing
// checkpoint mechanism makes re-runs idempotent.
// ---------------------------------------------------------------------------

export const BatchRunStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type BatchRunStatus = z.infer<typeof BatchRunStatusSchema>;

export const BatchRunInfoSchema = z.object({
  id: z.string(),
  status: BatchRunStatusSchema,
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outputPath: z.string(),
  errorMessage: z.string().nullable(),
});
export type BatchRunInfo = z.infer<typeof BatchRunInfoSchema>;

export const EvalScorerSchema = z.enum(['exact', 'contains', 'regex', 'llm']);
export type EvalScorer = z.infer<typeof EvalScorerSchema>;

export const EvalRunInfoSchema = z.object({
  id: z.string(),
  status: BatchRunStatusSchema,
  scorer: EvalScorerSchema,
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** 0-1 average score across all tasks. */
  avgScore: z.number().min(0).max(1),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outputPath: z.string(),
  errorMessage: z.string().nullable(),
});
export type EvalRunInfo = z.infer<typeof EvalRunInfoSchema>;

// ---------------------------------------------------------------------------
// Personality skills — v1
//
// Per-personality skills/*.md files (under
// ~/.ethos/personalities/<id>/skills/). Same shape as the global
// SkillSchema but scoped to one personality. Surfaces under the
// Personalities tab's editor.
// ---------------------------------------------------------------------------

export const PersonalitySkillSchema = z.object({
  /** Filename minus `.md`. */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  body: z.string(),
  /** ISO-8601 mtime. */
  modifiedAt: z.string(),
});
export type PersonalitySkill = z.infer<typeof PersonalitySkillSchema>;

// ---------------------------------------------------------------------------
// Communications — v1
//
// Per-platform connection state. The web tab edits four platforms by
// writing the same flat keys the gateway already reads from
// ~/.ethos/config.yaml (telegramToken, slackBotToken, …). Sensitive
// values never cross the wire on read; only `configured: boolean` is
// emitted. The setup form posts plaintext on update, then the read
// flips to configured = true.
// ---------------------------------------------------------------------------

export const PlatformIdSchema = z.enum(['telegram', 'discord', 'slack', 'email', 'whatsapp']);
export type PlatformId = z.infer<typeof PlatformIdSchema>;

export const PlatformStatusSchema = z.object({
  id: PlatformIdSchema,
  /** True when every required secret field has a non-empty value. */
  configured: z.boolean(),
  /** Per-field configured-ness so the form can show partial state. */
  fields: z.record(z.string(), z.boolean()),
});
export type PlatformStatus = z.infer<typeof PlatformStatusSchema>;

// ---------------------------------------------------------------------------
// Multi-bot routing — per-entry shapes for telegram.bots[] / slack.apps[]
// ---------------------------------------------------------------------------

export const BotBindingSchema = z.object({
  type: z.enum(['personality', 'team']),
  name: z.string(),
});
export type BotBinding = z.infer<typeof BotBindingSchema>;

export const TelegramBotEntrySchema = z.object({
  /** Stable identifier derived from token sha256 or explicit `id` field. */
  botKey: z.string(),
  /** True when the token is stored in config (tokens never cross the wire). */
  tokenConfigured: z.boolean(),
  username: z.string().optional(),
  bind: BotBindingSchema,
});
export type TelegramBotEntry = z.infer<typeof TelegramBotEntrySchema>;

export const SlackAppEntrySchema = z.object({
  botKey: z.string(),
  botTokenConfigured: z.boolean(),
  appTokenConfigured: z.boolean(),
  signingSecretConfigured: z.boolean(),
  bind: BotBindingSchema,
});
export type SlackAppEntry = z.infer<typeof SlackAppEntrySchema>;

// WhatsApp pairs via QR code, not a config-form token — an entry is routing
// knobs + a `paired` flag derived from whether the Baileys session dir on disk
// holds saved credentials. Saving a bot requires a `bind` (see the
// botsAddWhatsApp router input), but `bind` is optional on the entry so that
// listing a legacy bind-less config doesn't throw.
export const WhatsAppEntrySchema = z.object({
  botKey: z.string(),
  defaultMode: z.enum(['all', 'mention_only']),
  allowedNumbers: z.array(z.string()),
  /** Phone number this bot links via pairing code, when configured. Absent for
   *  QR-linked bots. Lets the UI show which number is being paired. */
  phoneNumber: z.string().optional(),
  /** True when the Baileys session dir for this bot is non-empty (QR pairing
   *  completed and credentials were persisted). */
  paired: z.boolean(),
  /** Personality/team this bot routes to. Required when saving via
   *  botsAddWhatsApp; optional here so legacy bind-less configs still list. */
  bind: BotBindingSchema.optional(),
});
export type WhatsAppEntry = z.infer<typeof WhatsAppEntrySchema>;

export const ChannelPlatformFilterSchema = z.object({
  enabled: z.boolean(),
  ownerUserId: z.string(),
  allowlist: z.array(z.string()),
});
export type ChannelPlatformFilter = z.infer<typeof ChannelPlatformFilterSchema>;

// ---------------------------------------------------------------------------
// Plugins + MCP — v1
//
// Read-only inventory of what's discoverable on disk. Full install /
// remove flows live in `ethos plugin` CLI for now; the web tab
// surfaces what's loaded so users can see the contract surface their
// agents currently have. MCP server CRUD is similar — `~/.ethos/mcp.json`
// is the editable shape (CLI: `ethos plugin add-mcp`).
// ---------------------------------------------------------------------------

export const PluginSourceSchema = z.enum(['user', 'project', 'npm']);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const PluginInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  /** Where the plugin was discovered. `user` → ~/.ethos/plugins, `project` → .ethos/plugins, `npm` → resolved from node_modules. */
  source: PluginSourceSchema,
  /** Server-side absolute path to the plugin directory (for diagnostics). */
  path: z.string(),
  /** Declared plugin contract major version, or null when the manifest doesn't pin one. */
  pluginContractMajor: z.number().int().nullable(),
  hasHomePanel: z.boolean().optional(),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

export const CredentialKeyInfoSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['secret', 'text']),
  description: z.string().nullable(),
  refreshHint: z.enum(['daily', 'weekly', 'manual']).nullable(),
  required: z.boolean().nullable(),
  isSet: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type CredentialKeyInfo = z.infer<typeof CredentialKeyInfoSchema>;

export const McpTransportSchema = z.enum(['stdio', 'sse', 'streamable-http']);

export const McpServerInfoSchema = z.object({
  name: z.string(),
  transport: McpTransportSchema,
  /** Stdio: the command. */
  command: z.string().nullable(),
  /** SSE: the endpoint. */
  url: z.string().nullable(),
  auth_status: z.enum(['none', 'authorized', 'expired', 'missing', 'pending']).nullable(),
  created_via: z.enum(['cli', 'ui']).nullable(),
  mcpResultLimitChars: z.number().int().positive().nullable(),
  deprecated: z.boolean().nullable(),
});
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

// ---------------------------------------------------------------------------
// MCP install flow — v1
// ---------------------------------------------------------------------------

export const McpStartInputSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(64).optional(),
  personalityId: z.string().min(1).optional(),
});

export const McpStartOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    state: z.string(),
    authorizeUrl: z.string(),
    serverName: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'discovery_failed',
      'dcr_unsupported',
      'dcr_failed',
      'name_taken',
      'webBaseUrl_missing',
      'ssrf_blocked',
      'invalid_origin',
    ]),
    detail: z.string().optional(),
  }),
]);

export const McpCompleteInputSchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});

export const McpCompleteOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), serverName: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'missing_pending_cookie',
      'expired_state',
      'state_mismatch',
      'code_exchange_failed',
      'upstream_error',
      'name_taken',
      'addserver_failed',
    ]),
    detail: z.string().optional(),
  }),
]);

export const McpStatusOutputSchema = z.object({
  status: z.enum(['pending', 'connected', 'error', 'expired']),
  serverName: z.string().optional(),
  error: z.string().optional(),
});

export const McpCancelInputSchema = z.object({
  state: z.string(),
});

export const McpAttachInputSchema = z.object({
  serverName: z.string(),
  personalityIds: z.array(z.string()),
});

export const McpAttachOutputSchema = z.object({
  updated: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

export const McpDeleteInputSchema = z.object({
  name: z.string(),
});

export const McpAddServerInputSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('streamable-http'),
    name: z.string().min(1).max(64),
    url: z.string().url(),
    authType: z.enum(['bearer', 'none']).optional(),
    token: z.string().min(1).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
  z.object({
    transport: z.literal('sse'),
    name: z.string().min(1).max(64),
    url: z.string().url(),
    authType: z.enum(['bearer', 'none']).optional(),
    token: z.string().min(1).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
  z.object({
    transport: z.literal('stdio'),
    name: z.string().min(1).max(64),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
]);

export const McpAddServerOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), serverName: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['ssrf_blocked', 'name_taken', 'invalid_url']),
    detail: z.string().optional(),
  }),
]);

export type McpAddServerInput = z.infer<typeof McpAddServerInputSchema>;

export const McpReconnectInputSchema = z.object({
  name: z.string(),
  personalityId: z.string().min(1).optional(),
});

export const McpListOutputSchema = z.object({
  servers: z.array(McpServerInfoSchema),
});

// ---------------------------------------------------------------------------
// MCP per-personality tool policy — mcp.yaml shape, surfaced so the editor
// can initialize the per-server tool checklist from disk. Mirrors
// `McpPolicy` / `McpServerPolicy` in @ethosagent/types. Tool names are BARE
// (no `mcp__<server>__` prefix) — that's what mcp.yaml stores.
// ---------------------------------------------------------------------------

export const McpServerPolicySchema = z.object({
  /** Bare tool names the server may expose. Absent = all tools allowed. */
  tools: z.array(z.string()).optional(),
  reject_args: z.record(z.string(), z.record(z.string(), z.array(z.string()))).optional(),
  enabled: z.boolean().optional(),
});

export const McpPolicySchema = z.object({
  servers: z.record(z.string(), McpServerPolicySchema).optional(),
});
export type McpPolicy = z.infer<typeof McpPolicySchema>;

// MCP server tool discovery — lists the tools a server exposes so the
// editor can render the per-server checklist. `available: false` signals
// the server is unreachable (not connected / no credentials); the UI then
// shows a note instead of an empty checklist.
export const McpServerToolsInputSchema = z.object({
  /** Personality the discovery runs under — OAuth credentials are scoped per personality. */
  personalityId: z.string().min(1),
  serverName: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

export const McpServerToolsOutputSchema = z.object({
  /** False when the server could not be reached — `tools` will be empty. */
  available: z.boolean(),
  /** Bare tool names (prefix stripped). */
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

// MCP per-personality server listing — returns the servers attached to a
// personality with their OAuth auth status.

export const McpPersonalityServersInputSchema = z.object({
  personalityId: z.string().min(1),
});

export const McpPersonalityServersOutputSchema = z.object({
  servers: z.array(
    z.object({
      name: z.string(),
      transport: z.string().optional(),
      url: z.string().optional(),
      auth_status: z.enum(['authorized', 'expired', 'missing']),
      auth_type: z.enum(['oauth2', 'bearer', 'none']).optional(),
    }),
  ),
});

export const McpRefreshTokenInputSchema = z.object({
  serverName: z.string().min(1),
});
export const McpRefreshTokenOutputSchema = z.object({
  ok: z.boolean(),
  expiresAt: z.string().nullable(),
  error: z.string().optional(),
});

export const McpRenameInputSchema = z.object({
  oldName: z.string().min(1),
  newName: z.string().min(1).max(64),
});
export const McpRenameOutputSchema = z.object({
  ok: z.literal(true),
});

export const McpUpdateTokenInputSchema = z.object({
  serverName: z.string().min(1),
  token: z.string().min(1),
});
export const McpUpdateTokenOutputSchema = z.object({
  ok: z.literal(true),
});

export const McpScopeStatusInputSchema = z.object({
  serverName: z.string().min(1),
});
export const McpScopeStatusOutputSchema = z.object({
  outcome: z.enum(['match', 'mismatch', 'inactive', 'no-introspection', 'error', 'unknown']),
  declaredScopes: z.array(z.string()),
  actualScopes: z.array(z.string()),
  error: z.string().optional(),
});

export const McpValidateConfigInputSchema = z.object({
  transport: z.enum(['streamable-http', 'sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  name: z.string().optional(),
});
export const McpValidateConfigOutputSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      field: z.string(),
      message: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Memory — v1
//
// The web tab edits the two markdown files MarkdownFileMemoryProvider
// reads (MEMORY.md and USER.md, always scoped per-personality).
// Vector-mode CRUD lands later — the contract is markdown-shaped for now.
// ---------------------------------------------------------------------------

export const MemoryStoreSchema = z.enum(['memory', 'user']);
export type MemoryStoreId = z.infer<typeof MemoryStoreSchema>;

export const MemoryFileSchema = z.object({
  store: MemoryStoreSchema,
  /** Markdown body. Empty string when the entry doesn't exist yet. */
  content: z.string(),
  /** Backend-local address (file path for the markdown backend; null for
   *  remote / DB / encrypted backends without one). Diagnostic display only. */
  path: z.string().nullable(),
  /** ISO-8601 mtime, or null when the entry doesn't exist. */
  modifiedAt: z.string().nullable(),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

// Provenance history (memory-experience pillar D, §5). One wire entry per
// memory mutation, mirroring the `HistoryEntry` shape the M1 HistoryStore
// records — minus the capture dedup hashes, which are an internal concern.
export const MemoryHistorySourceSchema = z.enum([
  'tool',
  'consolidation',
  'dream',
  'capture',
  'web-editor',
  'global-entry',
  'restore',
]);
export type MemoryHistorySource = z.infer<typeof MemoryHistorySourceSchema>;

export const MemoryHistoryEntrySchema = z.object({
  /** epoch-ms of the mutation. */
  ts: z.number(),
  scopeId: z.string(),
  key: z.string(),
  /** The `MemoryUpdate.action`s applied to this key in the batch. */
  actions: z.array(z.string()),
  source: MemoryHistorySourceSchema,
  sessionId: z.string(),
  sessionKey: z.string(),
  beforeHash: z.string(),
  afterHash: z.string(),
  /** Unified diff (before → after), inline-capped; truncated when `blob` is set. */
  diff: z.string(),
  /** Candidate importance in [0,1] — present on `capture` entries only. */
  hint: z.number().optional(),
  /** Content-address of the full before-state blob (§2.1). When set, `diff` is
   *  truncated and the full before-content is fetched via `memory.historyBlob`. */
  blob: z.string().optional(),
  sizeBefore: z.number(),
  sizeAfter: z.number(),
});
export type MemoryHistoryEntry = z.infer<typeof MemoryHistoryEntrySchema>;

// Approve-before-store pending queue (memory-lifecycle L3, §3b). One parked
// candidate write awaiting an approve/reject decision — the wire projection of
// `PendingEntry` from `@ethosagent/memory-approval`. The capture dedup fact-hash
// is carried so the queue can render provenance, but is otherwise a server-side
// tombstone key.
export const MemoryUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), key: z.string(), content: z.string() }),
  z.object({ action: z.literal('replace'), key: z.string(), content: z.string() }),
  z.object({ action: z.literal('remove'), key: z.string(), substringMatch: z.string() }),
  z.object({ action: z.literal('delete'), key: z.string() }),
]);
export type MemoryUpdateWire = z.infer<typeof MemoryUpdateSchema>;

export const PendingMemorySchema = z.object({
  /** Opaque queue id (uuid). */
  id: z.string(),
  /** Memory scope the write targets (`personality:<id>` / `team:<id>` / …). */
  scopeId: z.string(),
  /** The single candidate mutation, replayed verbatim on approve. */
  update: MemoryUpdateSchema,
  /** Original writer, so approve records honest provenance. */
  source: MemoryHistorySourceSchema,
  /** Normalized fact-hash for a capture candidate (tombstone key on reject). */
  factHash: z.string().optional(),
  /** Session the candidate originated in. */
  sessionId: z.string().optional(),
  sessionKey: z.string().optional(),
  /** epoch-ms the candidate was queued. */
  proposedAt: z.number(),
});
export type PendingMemory = z.infer<typeof PendingMemorySchema>;

export const IdentityMapEntrySchema = z.object({
  userId: z.string(),
  displayLabel: z.string(),
  platform: z.string(),
  firstSeenAt: z.string(),
});
export type IdentityMapEntryWire = z.infer<typeof IdentityMapEntrySchema>;

export const MeshRouteResultSchema = z.object({
  ok: z.boolean(),
  /** Agent the mesh selected for the synthetic task, or null when no peer
   *  could handle the requested capability. */
  routedTo: z.string().nullable(),
  /** Optional human-readable explanation (e.g. "no peer offers `code`"). */
  reason: z.string().nullable(),
});
export type MeshRouteResult = z.infer<typeof MeshRouteResultSchema>;

// ---------------------------------------------------------------------------
// Kanban — Plan B Control Center surface
//
// Wire-format mirrors of `@ethosagent/kanban-store` types, with epoch-ms
// timestamps converted to ISO-8601 strings and snake_case columns mapped to
// camelCase for the client. Mutations route through the server (the human
// "actor" is `human:<sessionLabel>`).
// ---------------------------------------------------------------------------

export const KanbanTaskStatusSchema = z.enum([
  'todo',
  'ready',
  'running',
  'blocked',
  'done',
  'archived',
  'scheduled',
  'failed',
  'needs_revision',
]);
export type KanbanTaskStatus = z.infer<typeof KanbanTaskStatusSchema>;

export const KanbanTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: KanbanTaskStatusSchema,
  assignee: z.string().nullable(),
  priority: z.number().int(),
  workspaceMode: z.enum(['scratch', 'worktree', 'dir']),
  workspacePath: z.string().nullable(),
  scheduledFor: z.string().nullable(), // ISO-8601
  currentRunId: z.string().nullable(),
  /** Times the task has been re-claimed after a prior run ended. */
  retryCount: z.number().int().nonnegative(),
  /** Retry budget; `null` = unlimited. */
  maxRetries: z.number().int().nonnegative().nullable(),
  /** Acceptance criteria a `before_ticket_complete` verifier checks; `null` = none set. */
  acceptanceCriteria: z.string().nullable(),
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
});
export type KanbanTask = z.infer<typeof KanbanTaskSchema>;

export const KanbanCommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(), // ISO-8601
});
export type KanbanComment = z.infer<typeof KanbanCommentSchema>;

export const KanbanRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  startedAt: z.string(), // ISO-8601
  endedAt: z.string().nullable(), // ISO-8601
  outcome: z.enum(['completed', 'blocked', 'stalled', 'cancelled']).nullable(),
  summary: z.string().nullable(),
  lastHeartbeatAt: z.string(), // ISO-8601
  completedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type KanbanRun = z.infer<typeof KanbanRunSchema>;

export const KanbanEventSchema = z.object({
  id: z.number().int(),
  taskId: z.string(),
  kind: z.enum([
    'created',
    'status_changed',
    'commented',
    'assigned',
    'linked',
    'unlinked',
    'run_started',
    'run_completed',
    'heartbeat',
    'archived',
  ]),
  actor: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(), // ISO-8601
});
export type KanbanEvent = z.infer<typeof KanbanEventSchema>;

export const KanbanLinkSchema = z.object({
  parentId: z.string(),
  childId: z.string(),
});
export type KanbanLink = z.infer<typeof KanbanLinkSchema>;

export const KanbanTeamSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  dispatchMode: z.enum(['coordinator', 'self-routing', 'broadcast']),
  /** Health label derived from the runtime file: `running`, `stopped`, `stale`. */
  health: z.enum(['running', 'stopped', 'stale']),
  memberCount: z.number().int().nonnegative(),
  /** Members whose runtime status is `running`. */
  runningCount: z.number().int().nonnegative(),
  /** ISO-8601 mtime of the board.db, or null when no board exists. */
  boardModifiedAt: z.string().nullable(),
});
export type KanbanTeamSummary = z.infer<typeof KanbanTeamSummarySchema>;

export const KanbanMemberStatsSchema = z.object({
  teamId: z.string(),
  memberId: z.string(),
  /** Tasks this member completed (`done`). */
  ticketsCompleted: z.number().int().nonnegative(),
  /** Tasks that ended `failed` or `needs_revision` while claimed by this member. */
  ticketsFailed: z.number().int().nonnegative(),
  /** Tasks whose claim by this member was reclaimed by another agent. */
  ticketsOrphaned: z.number().int().nonnegative(),
  /** ISO-8601 timestamp of the most recent counter bump. */
  lastUpdatedAt: z.string(),
});
export type KanbanMemberStats = z.infer<typeof KanbanMemberStatsSchema>;

export const KanbanBoardSnapshotSchema = z.object({
  team: KanbanTeamSummarySchema,
  tasks: z.array(KanbanTaskSchema),
  links: z.array(KanbanLinkSchema),
  /** Most-recent events, oldest→newest, capped at 100. */
  recentEvents: z.array(KanbanEventSchema),
  /** Per-member work-outcome stats for the team. Empty on solo boards. */
  memberStats: z.array(KanbanMemberStatsSchema),
});
export type KanbanBoardSnapshot = z.infer<typeof KanbanBoardSnapshotSchema>;

export const KanbanAgentSchema = z.object({
  personalityId: z.string(),
  displayName: z.string(),
  agentId: z.string(),
  online: z.boolean(),
});
export type KanbanAgent = z.infer<typeof KanbanAgentSchema>;

// ---------------------------------------------------------------------------
// API Keys — Control-Plane SDK auth
//
// Metadata returned by the admin namespace. The plaintext secret is only
// returned on create; subsequent reads never expose it.
// ---------------------------------------------------------------------------

// Two scopes read as "chat" and they are NOT interchangeable:
//
//   `chat`      gates the whole OpenAI-compatible `/v1/*` surface
//               (`/v1/models`, `/v1/chat/completions`). Asserted by
//               `bearerAuth` at the `/v1` mount in
//               apps/web-api/src/routes/openai/index.ts.
//   `chat:send` gates the `chat.send` / `chat.abort` RPC procedures on the
//               browser-facing `/rpc/*` surface, via SCOPE_MAP in
//               apps/web-api/src/middleware/dual-auth.ts.
//
// A key needs `chat` to drive Cursor/Aider/the OpenAI SDKs, and `chat:send` to
// drive a Mission Control built on `@ethosagent/sdk`. Neither implies the other.
export const ApiKeyScopeSchema = z.enum([
  'sessions:read',
  'sessions:write',
  'chat',
  'chat:send',
  'personalities:read',
  'memory:read',
  'memory:write',
  'tools:approve',
  'events:subscribe',
]);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeyMetadataSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  allowedOrigins: z.array(z.string()),
  createdAt: z.string(), // ISO-8601
  lastUsed: z.string().nullable(), // ISO-8601
  revokedAt: z.string().nullable(), // ISO-8601
});
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;

// ---------------------------------------------------------------------------
// Goals — convergence-loop execution
// ---------------------------------------------------------------------------

export const GoalStatusSchema = z.enum([
  'planning',
  'running',
  'judging',
  'retrying',
  'needs_clarification',
  'completed',
  'exhausted',
  'failed',
  'cancelled',
  'interrupted',
]);
export type GoalStatusWire = z.infer<typeof GoalStatusSchema>;

export const CriterionResultSchema = z.object({
  id: z.string(),
  pass: z.boolean().optional(),
  score: z.number().optional(),
  evidence: z.string(),
  gap: z.string().optional(),
});

export const VerdictSchema = z.object({
  score: z.number(),
  perCriterion: z.array(CriterionResultSchema),
});

export const GoalAttemptSchema = z.object({
  id: z.string(),
  goalId: z.string(),
  n: z.number().int(),
  sessionKey: z.string(),
  outputMd: z.string().nullable(),
  artifacts: z.unknown().nullable(),
  verdict: VerdictSchema.nullable(),
  strategyUsed: z.enum(['first', 'patch', 'pivot']),
  costUsd: z.number().nullable(),
  traceId: z.string().nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
});
export type GoalAttemptWire = z.infer<typeof GoalAttemptSchema>;

export const GoalEventTypeSchema = z.enum([
  'run_start',
  'plan_start',
  'plan_ready',
  'attempt_start',
  'turn_text',
  'tool_start',
  'tool_end',
  'steer',
  'usage',
  'complete_attempt',
  'complete_rejected',
  'error',
  'done',
]);

export const GoalEventSchema = z.object({
  id: z.number().int(),
  goalId: z.string(),
  seq: z.number().int(),
  eventType: GoalEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type GoalEventWire = z.infer<typeof GoalEventSchema>;

export const GoalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  personalityId: z.string(),
  origin: z.string(),
  sourceSession: z.string().nullable(),
  title: z.string(),
  goalText: z.string(),
  acceptanceCriteria: z.unknown().nullable(),
  planMd: z.string().nullable(),
  status: GoalStatusSchema,
  maxAttempts: z.number().int(),
  maxCostUsd: z.number().nullable(),
  deadline: z.string().nullable(),
  outputMd: z.string().nullable(),
  outputPartial: z.string().nullable(),
  errorText: z.string().nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  resumeCount: z.number().int(),
  turnCount: z.number().int().nullable(),
  toolCount: z.number().int().nullable(),
  tokenCount: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  maxToolCallsPerTurn: z.number().int().min(1).nullable().optional(),
  maxIdenticalToolCalls: z.number().int().min(1).nullable().optional(),
  allowDangerousToolCalls: z.boolean().nullable().optional(),
  maxRecoveryAttempts: z.number().int().min(0).nullable().optional(),
});
export type GoalWire = z.infer<typeof GoalSchema>;

// ---------------------------------------------------------------------------
// Background jobs — detached spawn-and-continue delegation (Tasks surface)
//
// Wire-format mirror of `@ethosagent/types` BackgroundJob / BackgroundJobEvent.
// Epoch-ms timestamps pass through as numbers (the Tasks page formats them
// client-side); optional columns are surfaced as `null` rather than absent.
// The `tasks` RPC namespace lists jobs, reads one job with its ordered event
// trail, and requests cancellation.
// ---------------------------------------------------------------------------

export const BackgroundJobStatusSchema = z.enum([
  'queued',
  'running',
  'done',
  'failed',
  'aborted',
  'stale',
  'expired',
]);
export type BackgroundJobStatusWire = z.infer<typeof BackgroundJobStatusSchema>;

export const BackgroundJobEventTypeSchema = z.enum([
  'queued',
  'claimed',
  'running',
  'heartbeat',
  'spend',
  'cancel_requested',
  'tool_headline',
  'tool_end',
  'text',
  'done',
  'failed',
  'aborted',
  'stale',
  'expired',
  'recovered',
]);
export type BackgroundJobEventTypeWire = z.infer<typeof BackgroundJobEventTypeSchema>;

export const BackgroundJobEventSchema = z.object({
  id: z.number().int(),
  jobId: z.string(),
  seq: z.number().int(),
  eventType: BackgroundJobEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type BackgroundJobEventWire = z.infer<typeof BackgroundJobEventSchema>;

export const BackgroundJobSummarySchema = z.object({
  id: z.string(),
  status: BackgroundJobStatusSchema,
  label: z.string().nullable(),
  personalityId: z.string().nullable(),
  spendUsd: z.number(),
  maxCostUsd: z.number().nullable(),
  depth: z.number().int(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  heartbeatAt: z.number().nullable(),
  owner: z.string(),
  rootSessionKey: z.string(),
  parentSessionKey: z.string(),
});
export type BackgroundJobSummaryWire = z.infer<typeof BackgroundJobSummarySchema>;

export const BackgroundJobDetailSchema = BackgroundJobSummarySchema.extend({
  prompt: z.string(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  events: z.array(BackgroundJobEventSchema),
});
export type BackgroundJobDetailWire = z.infer<typeof BackgroundJobDetailSchema>;

// ---------------------------------------------------------------------------
// Digest — weekly governed-learning report (read-only)
//
// The CLI / cron writes Markdown to `~/.ethos/digests/<ISO-week>.md`.
// `digest.latest` returns the newest file's body, its `<ISO-week>` label
// (filename minus `.md`), and the file mtime as an ISO-8601 string.
// ---------------------------------------------------------------------------

export const DigestLatestSchema = z.object({
  /** Filename minus `.md`, e.g. `2026-W07`. */
  label: z.string(),
  /** Full Markdown body of the digest file. */
  markdown: z.string(),
  /** File mtime as ISO-8601. */
  generatedAt: z.string(),
});
export type DigestLatest = z.infer<typeof DigestLatestSchema>;

// ---------------------------------------------------------------------------
// A2A peering (admin surface)
//
// Wire mirrors of `A2aPeerRow` / `A2aIdentityView` from `@ethosagent/wiring`.
// The A2A admin RPC (`a2a.*`) rides the same cookie/bearer `/rpc` auth as the
// other management namespaces — distinct from the peer-facing `/a2a` endpoints.
// `access` is the literal `'full'` in v1 (scope `['*']`, plan §2a).
// ---------------------------------------------------------------------------

export const A2aPeerRowSchema = z.object({
  fingerprint: z.string(),
  /** Local display name (from the allowlist entry). */
  label: z.string().optional(),
  /** The peer's self-reported name (from the peer store card). */
  cardName: z.string().optional(),
  /** The peer's well-known URL (from the allowlist entry). */
  url: z.string().optional(),
  /** v1 always full access, bounded by the owner's exposed skills. */
  access: z.literal('full'),
  enabled: z.boolean(),
  /** ms epoch of the last inbound authenticated interaction; absent → never. */
  lastSeenAt: z.number().optional(),
});
export type A2aPeerRowWire = z.infer<typeof A2aPeerRowSchema>;

export const A2aIdentityViewSchema = z.object({
  personalityId: z.string(),
  name: z.string(),
  fingerprint: z.string(),
  wellKnownUrl: z.string(),
  jsonRpcUrl: z.string(),
  authUrl: z.string(),
  did: z.string().optional(),
  exposedSkills: z.array(z.string()),
});
export type A2aIdentityViewWire = z.infer<typeof A2aIdentityViewSchema>;
