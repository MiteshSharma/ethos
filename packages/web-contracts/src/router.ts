import { oc } from '@orpc/contract';
import { z } from 'zod';
import { SessionCardSchema } from './cards';
import {
  A2aIdentityViewSchema,
  A2aPeerRowSchema,
  ApiKeyMetadataSchema,
  ApiKeyScopeSchema,
  ApprovalScopeSchema,
  BackgroundJobDetailSchema,
  BackgroundJobSummarySchema,
  BatchRunInfoSchema,
  BotBindingSchema,
  ChannelPlatformFilterSchema,
  CredentialKeyInfoSchema,
  CronJobSchema,
  CronRunSchema,
  DigestLatestSchema,
  EvalRunInfoSchema,
  EvalScorerSchema,
  EvolveConfigSchema,
  EvolverRunSchema,
  GoalAttemptSchema,
  GoalEventSchema,
  GoalSchema,
  GoalStatusSchema,
  IdentityMapEntrySchema,
  KanbanAgentSchema,
  KanbanBoardSnapshotSchema,
  KanbanCommentSchema,
  KanbanRunSchema,
  KanbanTaskSchema,
  KanbanTaskStatusSchema,
  KanbanTeamSummarySchema,
  McpAddServerInputSchema,
  McpAddServerOutputSchema,
  McpAttachInputSchema,
  McpAttachOutputSchema,
  McpCancelInputSchema,
  McpCompleteInputSchema,
  McpCompleteOutputSchema,
  McpDeleteInputSchema,
  McpListOutputSchema,
  McpPersonalityServersInputSchema,
  McpPersonalityServersOutputSchema,
  McpPolicySchema,
  McpReconnectInputSchema,
  McpRefreshTokenInputSchema,
  McpRefreshTokenOutputSchema,
  McpRenameInputSchema,
  McpRenameOutputSchema,
  McpScopeStatusInputSchema,
  McpScopeStatusOutputSchema,
  McpServerInfoSchema,
  McpServerToolsInputSchema,
  McpServerToolsOutputSchema,
  McpStartInputSchema,
  McpStartOutputSchema,
  McpStatusOutputSchema,
  McpUpdateTokenInputSchema,
  McpUpdateTokenOutputSchema,
  McpValidateConfigInputSchema,
  McpValidateConfigOutputSchema,
  MemoryFileSchema,
  MemoryHistoryEntrySchema,
  MemoryHistorySourceSchema,
  MemoryStoreSchema,
  MeshAgentSchema,
  MeshRouteResultSchema,
  MissedRunPolicySchema,
  ModelTierConfigSchema,
  OnboardingStepSchema,
  PendingMemorySchema,
  PendingSkillSchema,
  PersonalitySchema,
  PersonalitySkillSchema,
  PlatformIdSchema,
  PlatformStatusSchema,
  PluginInfoSchema,
  ProviderEntrySchema,
  ProviderIdSchema,
  SessionSchema,
  SkillSchema,
  SlackAppEntrySchema,
  StoredMessageSchema,
  TelegramBotEntrySchema,
  WhatsAppEntrySchema,
} from './schemas';

// oRPC contract — single source of truth for the web control plane.
// `apps/web-api` (server) calls `implement(contract)` against this.
// `apps/web` (client) calls `createORPCClient(link)` typed as
// `ContractRouterClient<typeof contract>`. Both ends fail to compile if the
// shapes drift.
//
// v0 surface: sessions / personalities (read-only) / chat / tools /
// onboarding / config. v0.5 (cron, skills, mesh) and v1 (memory, comms,
// plugins, settings, batch, eval) namespaces land in their own phases.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SessionListInput = z.object({
  /** Full-text query (FTS5). Empty / omitted returns recent sessions. */
  q: z.string().optional(),
  /** Page size; max 200 to keep payloads bounded. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Opaque rowid cursor from the previous response's `nextCursor`. */
  cursor: z.string().nullable().optional(),
  personalityId: z.string().optional(),
});
const SessionListOutput = z.object({
  items: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
});

const SessionGetInput = z.object({ id: z.string() });
const SessionGetOutput = z.object({
  session: SessionSchema,
  messages: z.array(StoredMessageSchema),
  /** Card envelopes emitted during this session, for replay. Empty when none. */
  cards: z.array(SessionCardSchema),
});

const SessionForkInput = z.object({
  id: z.string(),
  personalityId: z.string().optional(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionForkOutput = z.object({ session: SessionSchema });

const SessionDeleteInput = z.object({
  id: z.string(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionDeleteOutput = z.object({ ok: z.literal(true) });

const SessionUpdateInput = z.object({
  id: z.string(),
  /** New human-readable title. Pass null to clear the title. */
  title: z.string().max(200).nullable(),
  /** Optimistic-concurrency guard. v1 ignores this. */
  expectedVersion: z.number().int().optional(),
});
const SessionUpdateOutput = z.object({ session: SessionSchema });

const SessionExportInput = z.object({
  id: z.string(),
  format: z.enum(['markdown']),
});
const SessionExportOutput = z.object({
  content: z.string(),
  filename: z.string(),
});

const SessionPinInput = z.object({ id: z.string() });
const SessionPinOutput = z.object({ session: SessionSchema });

// Phase 0 — per-session context anatomy, aggregated from observability.db
// `llm_call` spans (never the sessions.db message rows, so nothing
// double-counts). Null when there is no span data yet.
const ContextAnatomySchema = z.object({
  system: z.number(),
  tools: z.number(),
  messages: z.number(),
  total: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  llmCallCount: z.number(),
});
const SessionContextAnatomyInput = z.object({ id: z.string() });
const SessionContextAnatomyOutput = z.object({ anatomy: ContextAnatomySchema.nullable() });
export type ContextAnatomyWire = z.infer<typeof ContextAnatomySchema>;

/** @stable v1 */
const sessions = {
  list: oc.input(SessionListInput).output(SessionListOutput),
  get: oc.input(SessionGetInput).output(SessionGetOutput),
  fork: oc.input(SessionForkInput).output(SessionForkOutput),
  delete: oc.input(SessionDeleteInput).output(SessionDeleteOutput),
  update: oc.input(SessionUpdateInput).output(SessionUpdateOutput),
  export: oc.input(SessionExportInput).output(SessionExportOutput),
  pin: oc.input(SessionPinInput).output(SessionPinOutput),
  unpin: oc.input(SessionPinInput).output(SessionPinOutput),
  contextAnatomy: oc.input(SessionContextAnatomyInput).output(SessionContextAnatomyOutput),
  undoTurns: oc
    .input(z.object({ id: z.string(), n: z.number().int().min(1).default(1) }))
    .output(z.object({ removed: z.number() })),
  // Phase 2 — manual `/compact`. Forces a compaction outside a turn and persists
  // a watermark so it survives into later turns. `instructions` is the optional
  // `/compact <focus…>` hint threaded into the summarizer.
  compact: oc.input(z.object({ id: z.string(), instructions: z.string().optional() })).output(
    z.object({
      ok: z.boolean(),
      engineName: z.string(),
      droppedCount: z.number(),
      preTotalTokens: z.number(),
      postTotalTokens: z.number(),
      summariesEnabled: z.boolean(),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Personalities (v0 read-only — create/edit lands in v1)
// ---------------------------------------------------------------------------

const PersonalityListInput = z.object({
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
});
const PersonalityListOutput = z.object({
  items: z.array(PersonalitySchema),
  nextCursor: z.string().nullable(),
  defaultId: z.string(),
});
const PersonalityGetInput = z.object({ id: z.string() });
const PersonalityGetOutput = z.object({
  personality: PersonalitySchema,
  /** Markdown body of SOUL.md. Empty string when the file isn't present. */
  soulMd: z.string(),
  /** Per-personality MCP tool policy from `mcp.yaml`. Null when the
   *  personality has no `mcp.yaml`. A server with no `tools` entry means
   *  "all tools allowed" (default-allow). */
  mcpPolicy: McpPolicySchema.nullable(),
});

const PersonalityCharacterSheetInput = z.object({ id: z.string() });

// Structured execution posture (Phase 2a, lane E1). Mirrors the
// `ExecutionPosture` / `DockerAbsentDecision` contracts in
// `@ethosagent/types`; the web Execution UI consumes this directly rather than
// re-computing posture from the toolset (single source of truth = the resolver
// behind `buildExecutionPosture`).
const DockerAbsentSchema = z.object({
  blocked: z.literal(true),
  canInstall: z.literal(true),
  canConsentLocal: z.boolean(),
  consentForbiddenReason: z.string().optional(),
});
const ExecutionPostureSchema = z.object({
  backend: z.enum(['docker', 'local', 'ssh', 'none']),
  networkMode: z.enum(['none', 'bridge']),
  memoryMb: z.number(),
  containerized: z.boolean(),
  mounts: z.array(
    z.object({
      hostPath: z.string(),
      containerPath: z.string(),
      mode: z.enum(['ro', 'rw']),
    }),
  ),
  scratchPaths: z.array(z.string()),
  dockerAbsent: DockerAbsentSchema.optional(),
});
/** Wire shape of the resolved execution posture (Phase 2a, lane E1). */
export type ExecutionPostureWire = z.infer<typeof ExecutionPostureSchema>;
export type DockerAbsentWire = z.infer<typeof DockerAbsentSchema>;
const PersonalityCharacterSheetOutput = z.object({
  /** Generated Markdown character sheet — the same artifact `ethos personality
   *  show` prints. Regenerated on each call; see `renderCharacterSheet` in
   *  @ethosagent/personalities. */
  markdown: z.string(),
  /** Resolved execution posture (Phase 2a, lane E1). Null when the server has
   *  no data directory wired and therefore cannot resolve the posture. */
  posture: ExecutionPostureSchema.nullable(),
});

const PersonalityIdRegex = /^[a-z0-9_-]+$/;

/** Nightly governed-learning gates. Defaults reproduce today's behavior
 *  (pass + judge + expression all run). Shared by create + update. */
const PersonalityNightlyInput = z
  .object({
    enabled: z.boolean().optional(),
    judge: z
      .object({
        enabled: z.boolean().optional(),
        minInteractions: z.number().int().min(1).optional(),
      })
      .optional(),
    expression: z.boolean().optional(),
  })
  .optional();

const PersonalityCreateInput = z.object({
  /** Lowercase id; becomes the directory name. */
  id: z.string().min(1).regex(PersonalityIdRegex),
  name: z.string().min(1),
  description: z.string().optional(),
  model: z.union([z.string(), ModelTierConfigSchema]).optional(),
  toolset: z.array(z.string()),
  /** Markdown body of SOUL.md. May be empty. */
  soulMd: z.string(),
  provider: ProviderIdSchema.or(z.literal('')).optional(),
  capabilities: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  fs_reach: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
      /** Declared working directory. Tokens (`${ETHOS_HOME}`, `${self}`,
       *  `${CWD}`) are stored verbatim and resolved at turn setup. */
      workdir: z.string().optional(),
    })
    .optional(),
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().min(1).max(20).optional(),
      cooldown_minutes: z.number().int().min(0).optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  nightly: PersonalityNightlyInput,
});
const PersonalityCreateOutput = z.object({ personality: PersonalitySchema });

const PersonalityUpdateInput = z.object({
  id: z.string().min(1),
  /** Patch — only present fields are written. */
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.union([z.string(), ModelTierConfigSchema]).optional(),
  toolset: z.array(z.string()).optional(),
  soulMd: z.string().optional(),
  mcp_servers: z.array(z.string()).optional(),
  /** Per-server MCP tool subsets, written to `mcp.yaml`. Maps a server name
   *  to the BARE tool names that server may expose. Only include a server
   *  here when it is a STRICT subset — a server with every tool selected
   *  should be omitted (that records "all tools allowed"). Servers attached
   *  via `mcp_servers` but absent here have any prior `tools` entry cleared.
   *  Ignored unless `mcp_servers` is also present. */
  mcp_tools: z.record(z.string(), z.array(z.string())).optional(),
  plugins: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  provider: ProviderIdSchema.or(z.literal('')).optional(),
  /** Sub-keys are shallow-merged onto the stored block, so a patch carrying
   *  only `read`/`write` leaves an existing `workdir` in place. `''` clears
   *  the workdir. */
  fs_reach: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
      workdir: z.string().optional(),
    })
    .optional(),
  /** Idle-time dreaming controls. `enable` toggles dreaming; idleMinutes /
   *  maxPerDay tune the cadence (kept at their persisted values when omitted). */
  dreaming: z
    .object({
      enable: z.boolean(),
      idleMinutes: z.number().int().min(0).optional(),
      maxPerDay: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  /** Skill-evolution tuning. Retunable after creation. */
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().min(1).max(20).optional(),
      cooldown_minutes: z.number().int().min(0).optional(),
      model: z.string().optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Per-personality safety dial. Only `approvalMode` is editable from the
   *  web; sibling safety fields are preserved by the registry merge. */
  safety: z.object({ approvalMode: z.enum(['manual', 'smart', 'off']).optional() }).optional(),
  /** Per-personality memory backend. Built-ins: 'markdown', 'vector'. */
  memory: z.object({ provider: z.string().optional() }).optional(),
  /** Nightly governed-learning gates. The UI sends the FULL nightly object
   *  (including the full judge sub-object); the registry one-level-merges it. */
  nightly: PersonalityNightlyInput,
});
const PersonalityUpdateOutput = z.object({ personality: PersonalitySchema });

const PersonalityDeleteInput = z.object({ id: z.string().min(1) });
const PersonalityOkOutput = z.object({ ok: z.literal(true) });

const PersonalityDuplicateInput = z.object({
  id: z.string().min(1),
  newId: z.string().min(1).regex(PersonalityIdRegex),
});
const PersonalityDuplicateOutput = z.object({ personality: PersonalitySchema });

// Per-personality skills (gate 19).
const PersonalitySkillsListInput = z.object({ personalityId: z.string().min(1) });
const PersonalitySkillsListOutput = z.object({ skills: z.array(PersonalitySkillSchema) });

// Renderer capabilities (`ethos.renders`) declared by the personality's
// resolved skill set — `<renderer>@<spec-version>` entries a chat surface
// checks against its own curated registry before upgrading a fenced block
// from a code block. Empty array = code block, which is also the failure mode.
const PersonalityRenderersInput = z.object({ id: z.string().min(1) });
const PersonalityRenderersOutput = z.object({ renderers: z.array(z.string()) });

const PersonalitySkillsGetInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
});
const PersonalitySkillsGetOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsCreateInput = z.object({
  personalityId: z.string().min(1),
  skillId: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  body: z.string(),
});
const PersonalitySkillsCreateOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsUpdateInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
  body: z.string(),
});
const PersonalitySkillsUpdateOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsDeleteInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
});

const PersonalitySkillsImportInput = z.object({
  personalityId: z.string().min(1),
  /** Global skill ids to copy from ~/.ethos/skills/<id>.md into the personality's skills/. */
  skillIds: z.array(z.string().min(1)),
});
const PersonalitySkillsImportOutput = z.object({ imported: z.array(PersonalitySkillSchema) });

// Pending skill-candidate review queue. The nightly skill-evolver (manual
// mode) drafts candidates into `<dataDir>/skills/.pending/<personalityId>/`;
// these procedures let a human list / approve (promote to the live skills
// dir) / reject (delete) them.
const PersonalitySkillCandidateFileName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+\.md$/);
const PersonalitySkillCandidatesListInput = z.object({ personalityId: z.string().min(1) });
const PersonalitySkillCandidatesListOutput = z.object({
  candidates: z.array(z.object({ fileName: z.string(), content: z.string() })),
});
const PersonalitySkillCandidateActionInput = z.object({
  personalityId: z.string().min(1),
  fileName: PersonalitySkillCandidateFileName,
});
const PersonalitySkillCandidateApproveOutput = z.object({
  ok: z.literal(true),
  promotedTo: z.string(),
});

// Per-personality MCP bearer-token management (headless gap 4).
const PersonalityMcpSetTokenInput = z.object({
  personalityId: z.string().min(1),
  server: z.string().min(1),
  token: z.string().min(1),
});
const PersonalityMcpSetTokenOutput = z.object({ ok: z.literal(true) });

const PersonalityMcpDeleteTokenInput = z.object({
  personalityId: z.string().min(1),
  server: z.string().min(1),
});
const PersonalityMcpDeleteTokenOutput = z.object({ ok: z.literal(true) });

const LearningLogEntrySchema = z.object({
  revisionId: z.string(),
  at: z.string(),
  summary: z.string(),
  evidenceRef: z.string(),
  prevExpressionRef: z.string(),
});

const PersonalityJudgeSchema = z.object({
  alignmentScore: z.number(),
  signal: z.enum(['drift', 'underspecified_soul']).nullable(),
  lowStreak: z.number(),
  at: z.string().optional(),
  perDimension: z.array(z.object({ dimension: z.string(), score: z.number() })).optional(),
});

const PersonalityNightlySchema = z.object({
  windowEnd: z.string(),
  completed: z.array(z.string()),
});

const PersonalityLivingSoulInput = z.object({ id: z.string().min(1) });
const PersonalityLivingSoulOutput = z.object({
  core: z.string(),
  expression: z.string(),
  learningLog: z.array(LearningLogEntrySchema),
  /** Latest Personality-Judge alignment read from
   *  `.judge-history/state.json`. Omitted when no judge run is recorded. */
  judge: PersonalityJudgeSchema.optional(),
  /** Latest nightly-pass status read from `.nightly-state.json`. Omitted when
   *  no nightly pass has run (missing or malformed file). */
  nightly: PersonalityNightlySchema.optional(),
});

const PersonalityProposeExpressionInput = z.object({ id: z.string().min(1) });
const PersonalityProposeExpressionOutput = z.object({
  currentExpression: z.string(),
  newExpression: z.string(),
  rationale: z.string(),
  evidence: z.string(),
});

const PersonalityApplyExpressionInput = z.object({
  id: z.string().min(1),
  newExpression: z.string(),
  summary: z.string(),
  evidenceRef: z.string(),
});
const PersonalityApplyExpressionOutput = z.object({ revisionId: z.string() });

const PersonalityRevertExpressionInput = z.object({ id: z.string().min(1) });
const PersonalityRevertExpressionOutput = z.object({
  ok: z.literal(true),
  revertedTo: z.string(),
});

const PersonalityProposeSoulSplitInput = z.object({ soulMd: z.string() });
const PersonalityProposeSoulSplitOutput = z.object({
  core: z.string(),
  expression: z.string(),
  rationale: z.string(),
});

/** @stable v1 */
const personalities = {
  list: oc.input(PersonalityListInput).output(PersonalityListOutput),
  get: oc.input(PersonalityGetInput).output(PersonalityGetOutput),
  characterSheet: oc.input(PersonalityCharacterSheetInput).output(PersonalityCharacterSheetOutput),
  create: oc.input(PersonalityCreateInput).output(PersonalityCreateOutput),
  update: oc.input(PersonalityUpdateInput).output(PersonalityUpdateOutput),
  delete: oc.input(PersonalityDeleteInput).output(PersonalityOkOutput),
  duplicate: oc.input(PersonalityDuplicateInput).output(PersonalityDuplicateOutput),
  renderers: oc.input(PersonalityRenderersInput).output(PersonalityRenderersOutput),
  skillsList: oc.input(PersonalitySkillsListInput).output(PersonalitySkillsListOutput),
  skillsGet: oc.input(PersonalitySkillsGetInput).output(PersonalitySkillsGetOutput),
  skillsCreate: oc.input(PersonalitySkillsCreateInput).output(PersonalitySkillsCreateOutput),
  skillsUpdate: oc.input(PersonalitySkillsUpdateInput).output(PersonalitySkillsUpdateOutput),
  skillsDelete: oc.input(PersonalitySkillsDeleteInput).output(PersonalityOkOutput),
  skillsImportGlobal: oc.input(PersonalitySkillsImportInput).output(PersonalitySkillsImportOutput),
  skillCandidatesList: oc
    .input(PersonalitySkillCandidatesListInput)
    .output(PersonalitySkillCandidatesListOutput),
  skillCandidateApprove: oc
    .input(PersonalitySkillCandidateActionInput)
    .output(PersonalitySkillCandidateApproveOutput),
  skillCandidateReject: oc.input(PersonalitySkillCandidateActionInput).output(PersonalityOkOutput),
  mcpSetToken: oc.input(PersonalityMcpSetTokenInput).output(PersonalityMcpSetTokenOutput),
  mcpDeleteToken: oc.input(PersonalityMcpDeleteTokenInput).output(PersonalityMcpDeleteTokenOutput),
  livingSoul: oc.input(PersonalityLivingSoulInput).output(PersonalityLivingSoulOutput),
  proposeExpression: oc
    .input(PersonalityProposeExpressionInput)
    .output(PersonalityProposeExpressionOutput),
  applyExpression: oc
    .input(PersonalityApplyExpressionInput)
    .output(PersonalityApplyExpressionOutput),
  revertExpression: oc
    .input(PersonalityRevertExpressionInput)
    .output(PersonalityRevertExpressionOutput),
  proposeSoulSplit: oc
    .input(PersonalityProposeSoulSplitInput)
    .output(PersonalityProposeSoulSplitOutput),
};

// ---------------------------------------------------------------------------
// Chat
//
// `chat.send` is fire-and-(quickly)-forget — it returns once the turn has
// been kicked off on the server. The agent's actual response streams over
// SSE on `/sse/sessions/:sessionId`. `clientId` distinguishes multiple
// browser tabs writing to the same session (CEO finding 4.1).
// ---------------------------------------------------------------------------

const ChatSendInput = z.object({
  /** Existing session ID, or omit to start a new session. */
  sessionId: z.string().optional(),
  clientId: z.string().min(1),
  text: z.string().min(1),
  personalityId: z.string().optional(),
  userId: z.string().optional(),
  /** When true, the agent plans tool calls without executing them. The SSE
   *  stream emits a `dry_run_summary` event with the tool plan instead of
   *  running the tools. */
  dryRun: z.boolean().optional(),
  /**
   * How this turn's text reached the client. `voice` means `text` is a
   * transcript of the user speaking (talk-mode), which the server turns into a
   * MESSAGE-LEVEL voice-origin annotation on the turn — never a system-prompt
   * section, because one session mixes typed and spoken turns. Default `text`.
   */
  origin: z.enum(['text', 'voice']).optional(),
  attachments: z
    .array(
      z.object({
        type: z.enum(['image', 'file']),
        data: z.string(),
        mimeType: z.string(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});
const ChatSendOutput = z.object({
  sessionId: z.string(),
  /** Echoed back so a tab knows which turn the SSE stream belongs to. */
  turnId: z.string(),
});

const ChatAbortInput = z.object({ sessionId: z.string() });
const ChatAbortOutput = z.object({ ok: z.literal(true) });

const ChatSteerInput = z.object({ sessionId: z.string(), text: z.string().min(1) });
const ChatSteerOutput = z.object({ ok: z.boolean() });

/** @stable v1 */
const chat = {
  send: oc.input(ChatSendInput).output(ChatSendOutput),
  abort: oc.input(ChatAbortInput).output(ChatAbortOutput),
  steer: oc.input(ChatSteerInput).output(ChatSteerOutput),
};

// ---------------------------------------------------------------------------
// Tools — approval workflow for dangerous tool calls
// ---------------------------------------------------------------------------

const ToolApproveInput = z.object({
  approvalId: z.string(),
  /** Tab identity. Other tabs viewing this session see `decidedBy: clientId`
   *  on the `approval.resolved` SSE event so the modal auto-dismisses with
   *  "approved by another window." */
  clientId: z.string().min(1),
  scope: ApprovalScopeSchema,
});
const ToolApproveOutput = z.object({ ok: z.literal(true) });

const ToolDenyInput = z.object({
  approvalId: z.string(),
  clientId: z.string().min(1),
  reason: z.string().optional(),
});
const ToolDenyOutput = z.object({ ok: z.literal(true) });

const ToolsCatalogInput = z.object({});
const ToolsCatalogOutput = z.object({
  groups: z.array(
    z.object({
      group: z.string(),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
    }),
  ),
});

/** @experimental */
const tools = {
  approve: oc.input(ToolApproveInput).output(ToolApproveOutput),
  deny: oc.input(ToolDenyInput).output(ToolDenyOutput),
  catalog: oc.input(ToolsCatalogInput).output(ToolsCatalogOutput),
};

// ---------------------------------------------------------------------------
// Clarify — resolve a pending `clarify` request (the agent asked the user a
// question mid-turn). The request side flows out over SSE; this is the answer
// path back, mirroring the tool-approval transport.
// ---------------------------------------------------------------------------

const ClarifyRespondInput = z.object({
  requestId: z.string(),
  /** The user's answer — free-form text, or one of the offered options. */
  answer: z.string(),
  /** `user` for a real answer, `cancel` when the user dismissed the card. */
  source: z.enum(['user', 'cancel']),
});
const ClarifyRespondOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const clarify = {
  respond: oc.input(ClarifyRespondInput).output(ClarifyRespondOutput),
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const OnboardingStateOutput = z.object({
  step: OnboardingStepSchema,
  /** True once `~/.ethos/config.yaml` has a valid provider + key. */
  hasProvider: z.boolean(),
  /** Set after step 3. */
  selectedPersonalityId: z.string().nullable(),
});

const OnboardingValidateProviderInput = z.object({
  provider: ProviderIdSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});
const OnboardingValidateProviderOutput = z.object({
  ok: z.boolean(),
  /** Models returned by the provider's catalog endpoint when validation succeeds. */
  models: z.array(z.string()).nullable(),
  error: z.string().nullable(),
  completionTested: z.boolean(),
});

const OnboardingCompleteInput = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  personalityId: z.string().min(1),
});
const OnboardingCompleteOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const onboarding = {
  state: oc.output(OnboardingStateOutput),
  validateProvider: oc
    .input(OnboardingValidateProviderInput)
    .output(OnboardingValidateProviderOutput),
  complete: oc.input(OnboardingCompleteInput).output(OnboardingCompleteOutput),
};

// ---------------------------------------------------------------------------
// Config
//
// Read-only view of the parts of `~/.ethos/config.yaml` the web UI can edit.
// The full file (with raw API keys) never crosses the wire — `apiKey` is
// returned as a redacted preview ("sk-…abc1") so users can confirm which key
// is active without leaking it to the browser.
// ---------------------------------------------------------------------------

// -- Settings sub-schemas (Settings page groups without another UI home) ----

/** Retention duration grammar (extensions/observability-sqlite `parseDuration`):
 *  `forever` or `<n>` + d(ays) | w(eeks) | m(onths) | y(ears), e.g. `90d`. */
const RetentionDurationSchema = z.string().regex(/^(forever|\d+[dwmy])$/);

/** Flat retention subkeys — the `<subkey>` in `retention.<subkey>` and
 *  `personalities.<id>.retention.<subkey>` config.yaml keys. */
const RetentionSubkeySchema = z.enum([
  'messages',
  'traces',
  'spans',
  'blobs',
  'archive',
  'events.error',
  'events.audit',
  'events.channel',
  'events.install',
]);

/** Record keys written as `<prefix>.<key>.<field>` config.yaml lines must
 *  round-trip through the line-based format — same identifier rule as bot ids. */
const ConfigRecordKeySchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** One inbound webhook as returned by `config.get` (`webhooks.<hookId>.*`).
 *  The bearer secret NEVER round-trips — only a redacted preview. */
const WebhookGetSchema = z.object({
  /** config.yaml: `webhooks.<hookId>.personalityId` */
  personalityId: z.string(),
  /** Redacted preview of `webhooks.<hookId>.secret` (e.g. "abc…wxyz"). */
  secretPreview: z.string(),
  /** config.yaml: `webhooks.<hookId>.sessionKey` */
  sessionKey: z.string().nullable(),
  /** config.yaml: `webhooks.<hookId>.prefilter` (script under ~/.ethos/scripts/) */
  prefilter: z.string().nullable(),
  /** config.yaml: `webhooks.<hookId>.prefilterTimeoutSeconds` (1-600) */
  prefilterTimeoutSeconds: z.number().nullable(),
  /** config.yaml: `webhooks.<hookId>.mode` — default 'sync'. */
  mode: z.enum(['sync', 'ack']),
});

/** One inbound webhook as accepted by `config.update`. `secret` is write-only:
 *  omit it to keep the stored secret (a brand-new hook gets a generated one). */
const WebhookUpdateSchema = z
  .object({
    personalityId: z.string().min(1),
    /** Write-only bearer secret; never echoed back. Omit to keep/generate. */
    secret: z.string().min(8).optional(),
    sessionKey: z.string().optional(),
    prefilter: z.string().optional(),
    prefilterTimeoutSeconds: z.number().int().min(1).max(600).optional(),
    mode: z.enum(['sync', 'ack']).optional(),
  })
  .refine((h) => h.prefilterTimeoutSeconds === undefined || h.prefilter !== undefined, {
    message: "prefilterTimeoutSeconds requires 'prefilter'",
  });

/** One `/name` quick command (`quick_commands.<name>.*`). `exec` runs an
 *  operator-authored shell command; `reply` returns a canned string. */
const QuickCommandGetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec'),
    command: z.string(),
    gateway: z.boolean(),
    channels: z.array(z.string()),
  }),
  z.object({
    type: z.literal('reply'),
    reply: z.string(),
    gateway: z.boolean(),
    channels: z.array(z.string()),
  }),
]);
const QuickCommandUpdateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec'),
    command: z.string().min(1),
    gateway: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('reply'),
    reply: z.string().min(1),
    gateway: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
  }),
]);

/** Auxiliary model wiring (`auxiliary.<slot>.*` where slot is compression /
 *  vision / web). API key never round-trips — preview only. */
const AuxModelGetSchema = z.object({
  model: z.string().nullable(),
  provider: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
});
/** Update shape for an auxiliary model slot. `null` clears the stored key. */
const AuxModelUpdateSchema = z.object({
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  /** Write-only; never echoed back. Null deletes the stored key. */
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
});

const ConfigGetOutput = z.object({
  provider: z.string(),
  model: z.string(),
  apiKeyPreview: z.string(), // e.g. "sk-…abc1"
  baseUrl: z.string().nullable(),
  personality: z.string(),
  memory: z.enum(['markdown', 'vector', 'vault']),
  modelRouting: z.record(z.string(), z.string()),
  /** Currently selected skin (one of the BUILTIN_SKINS names). */
  skin: z.string(),
  providers: z.array(ProviderEntrySchema),
  approvalMode: z.enum(['manual', 'smart', 'off']),
  verbosity: z.enum(['concise', 'balanced', 'verbose']),
  debugMode: z.boolean(),
  contextLayering: z.boolean(),
  debugPanelEnabled: z.boolean(),
  debugPanelModel: z.string().nullable(),
  adminEnabled: z.boolean(),
  /** Channel streaming draft edits (display.streaming_edits). */
  streamingEdits: z.enum(['off', 'dms', 'all']),
  /** Auto-compact long sessions near the model window (compaction.autoCompact). */
  autoCompact: z.boolean(),
  /** Silent memory-flush turn (memoryConsolidation.enabled). */
  memoryConsolidationEnabled: z.boolean(),
  /** Proactive mid-conversation fact capture (memoryCapture.enabled). */
  memoryCaptureEnabled: z.boolean(),
  /** Cheap model for capture extraction (memoryCapture.model); null = default. */
  memoryCaptureModel: z.string().nullable(),
  /** CLI "· remembered: …" capture notice (display.memory_notices). */
  memoryNotices: z.boolean(),
  /** Talk-mode processing chime / earcon (display.voice_chime); default true. */
  voiceChime: z.boolean(),
  /** VAD endpoint silence in ms (display.voice_endpoint_silence_ms); default 700. */
  voiceEndpointSilenceMs: z.number(),
  /** Barge-in RMS threshold during playout (display.voice_barge_threshold); default 0.06. */
  voiceBargeThreshold: z.number(),
  /** Sustained-speech ms before barge-in (display.voice_barge_sustain_ms); default 250. */
  voiceBargeSustainMs: z.number(),
  /** Listening speech RMS threshold (display.voice_speech_threshold); default 0.02. */
  voiceSpeechThreshold: z.number(),
  /** Minimum speech ms before an utterance counts (display.voice_speech_min_ms); default 150. */
  voiceSpeechMinMs: z.number(),
  voiceProvider: z.string().nullable(),
  voiceApiKeyPreview: z.string().nullable(),
  voiceBaseUrl: z.string().nullable(),
  voiceModel: z.string().nullable(),
  voiceTtsProvider: z.string().nullable(),
  voiceTtsApiKeyPreview: z.string().nullable(),
  voiceTtsVoice: z.string().nullable(),
  voiceTtsBaseUrl: z.string().nullable(),
  voiceTtsModel: z.string().nullable(),
  /** `auxiliary.asr.command` — shell template the `command-stt` provider runs. */
  voiceSttCommand: z.string().nullable(),
  /** `auxiliary.tts.command` — shell template the `command-tts` provider runs. */
  voiceTtsCommand: z.string().nullable(),
  /** `auxiliary.tts.outputFormat` — container the TTS provider is asked for. */
  voiceTtsOutputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).nullable(),
  /** `auxiliary.tts.timeout`, ms. */
  voiceTtsTimeoutMs: z.number().nullable(),
  /** `auxiliary.tts.maxTextLength` — chars per synthesis request. */
  voiceTtsMaxTextLength: z.number().nullable(),
  /** `auxiliary.asr.timeout`, ms. */
  voiceSttTimeoutMs: z.number().nullable(),
  /** `voice.trustedPlugins` — the local-only egress allowlist. `null` = key
   *  absent = gate OFF; a list arms it (providers with `caps.local` always pass). */
  voiceTrustedPlugins: z.array(z.string()).nullable(),
  /** `voice.defaultMode` — where a new channel lane starts. */
  voiceDefaultMode: z.enum(['off', 'mirror_inbound', 'all']).nullable(),
  // -- Settings-page additions (keys with no other UI home) ------------------
  /** Azure-only REST API version (`apiVersion`); null when unset. */
  apiVersion: z.string().nullable(),
  /** Per-turn timing summary after every response (`verbose`); default false. */
  verbose: z.boolean(),
  /** Chat-surface verbosity (`display.verbosity`); default 'default'. */
  displayVerbosity: z.enum(['quiet', 'default', 'verbose', 'debug']),
  /** What Enter does mid-turn (`display.busy_input_mode`); default 'interrupt'. */
  displayBusyInputMode: z.enum(['interrupt', 'queue', 'steer']),
  /** Tool feed arg truncation, 0 = none (`display.tool_preview_length`); default 0. */
  displayToolPreviewLength: z.number(),
  /** Show resume hint on chat exit (`display.resume_hint`); default true. */
  displayResumeHint: z.boolean(),
  /** Turn pairs in the resume recap panel, 0 disables (`display.resume_recap_turns`); default 3. */
  displayResumeRecapTurns: z.number(),
  /** Terminal bell when a background task finishes (`display.bell_on_complete`); default false. */
  displayBellOnComplete: z.boolean(),
  /** Context-compaction gate thresholds (`compaction.*`). `autoCompact` is the
   *  sibling top-level field above; the rest of the group lives here. */
  compaction: z.object({
    /** `compaction.pressure` — gate fraction in (0,1]; null = 0.8 default. */
    pressure: z.number().nullable(),
    /** `compaction.target` — shrink-to fraction in (0,1]; null = 0.7 default. */
    target: z.number().nullable(),
    /** `compaction.gateDelta` — token headroom, integer >= 0; null = unset. */
    gateDelta: z.number().nullable(),
    /** `compaction.retryOnOverflow` — compact-and-retry on overflow; default true. */
    retryOnOverflow: z.boolean(),
    /** `compaction.smallWindow` — small-window-mode override; default 'auto'. */
    smallWindow: z.enum(['auto', 'on', 'off']),
  }),
  /** Bring-your-own-vault backend (`memoryVault.*`); read when memory = 'vault'. */
  memoryVault: z.object({
    /** `memoryVault.path` — absolute vault root; null = unset. */
    path: z.string().nullable(),
    /** `memoryVault.agentDir` — subtree the agent owns; null = 'Ethos' default. */
    agentDir: z.string().nullable(),
    /** `memoryVault.prefetch` — keys prefetched into the prompt tail. */
    prefetch: z.array(z.string()),
    /** `memoryVault.exclude` — names hidden from list + search. */
    exclude: z.array(z.string()),
  }),
  /** Approve-before-store gate (`memoryApproval.*`). */
  memoryApproval: z.object({
    /** `memoryApproval.mode` — default 'off'. */
    mode: z.enum(['off', 'automated', 'all']),
    /** `memoryApproval.cap` — per-scope pending-queue cap; default 200. */
    cap: z.number(),
    /** `memoryApproval.ttlDays` — pending-candidate TTL; default 30. */
    ttlDays: z.number(),
  }),
  /** Decay tuning + silent-flush tunables (`memoryConsolidation.*`). The
   *  `enabled` flag is the sibling `memoryConsolidationEnabled` field above. */
  memoryConsolidation: z.object({
    /** `memoryConsolidation.halfLifeDays` — recency half-life; default 30. */
    halfLifeDays: z.number(),
    /** `memoryConsolidation.threshold` — archive-below weight; default 0.05. */
    threshold: z.number(),
    /** `memoryConsolidation.exemptUser` — exempt USER.md from decay; default true. */
    exemptUser: z.boolean(),
    /** `memoryConsolidation.flushThreshold` — flush trigger fraction; default 0.7. */
    flushThreshold: z.number(),
    /** `memoryConsolidation.timeboxMs` — flush-turn timebox; default 30000. */
    timeboxMs: z.number(),
    /** `memoryConsolidation.maxTokens` — flush-turn token cap; default 1024. */
    maxTokens: z.number(),
    /** `memoryConsolidation.maxDeltaChars` — max chars written per flush; default 4000. */
    maxDeltaChars: z.number(),
    /** `memoryConsolidation.minMessagesSinceFlush` — flush spacing; default 8. */
    minMessagesSinceFlush: z.number(),
  }),
  /** Proactive capture wiring (`memoryCapture.*`). `enabled`/`model` are the
   *  sibling `memoryCaptureEnabled`/`memoryCaptureModel` fields above. */
  memoryCapture: z.object({
    /** `memoryCapture.provider` — aux provider; null = primary provider. */
    provider: z.string().nullable(),
    /** Redacted preview of `memoryCapture.apiKey`; null when unset. */
    apiKeyPreview: z.string().nullable(),
    /** `memoryCapture.baseUrl`; null = primary baseUrl. */
    baseUrl: z.string().nullable(),
    /** `memoryCapture.maxPerHour` — captures/hour per scope; default 6. */
    maxPerHour: z.number(),
    /** `memoryCapture.maxPerDay` — captures/day per scope; default 30. */
    maxPerDay: z.number(),
  }),
  /** Background sub-agent job pool (`background.<snake_case>` keys). */
  background: z.object({
    /** `background.enabled`; default false. */
    enabled: z.boolean(),
    /** `background.max_concurrent_jobs`; default 2. */
    maxConcurrentJobs: z.number(),
    /** `background.max_jobs_per_root`; default 3. */
    maxJobsPerRoot: z.number(),
    /** `background.max_jobs_per_personality`; default 5. */
    maxJobsPerPersonality: z.number(),
    /** `background.default_max_cost_usd`; default 1. */
    defaultMaxCostUsd: z.number(),
    /** `background.max_root_background_usd`; default 5. */
    maxRootBackgroundUsd: z.number(),
    /** `background.queued_ttl_ms`; default 900000. */
    queuedTtlMs: z.number(),
    /** `background.stale_ms`; default 90000. */
    staleMs: z.number(),
    /** `background.heartbeat_ms`; default 30000. */
    heartbeatMs: z.number(),
    /** `background.retention_days`; default 30. */
    retentionDays: z.number(),
  }),
  /** Global retention TTLs (`retention.<subkey>`), only the keys actually set. */
  retention: z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema),
  /** Per-personality retention overrides (`personalities.<id>.retention.<subkey>`). */
  personalityRetention: z.record(
    z.string(),
    z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema),
  ),
  /** Inbound webhooks (`webhooks.<hookId>.*`); secrets redacted. */
  webhooks: z.record(z.string(), WebhookGetSchema),
  /** User-defined `/name` shortcuts (`quick_commands.<name>.*`). */
  quickCommands: z.record(z.string(), QuickCommandGetSchema),
  /** Per-channel toolset narrowing (`channel_toolsets.<platform>`). */
  channelToolsets: z.record(z.string(), z.array(z.string())),
  /** Governed-learning nightly pass (`nightlyPass.*`). */
  nightlyPass: z.object({
    /** `nightlyPass.enabled`; default false. */
    enabled: z.boolean(),
    /** `nightlyPass.cron` — 5-field cron; default '0 3 * * *'. */
    cron: z.string(),
  }),
  /** Weekly governed-learning digest (`weeklyDigest.*`). */
  weeklyDigest: z.object({
    /** `weeklyDigest.enabled`; default false. */
    enabled: z.boolean(),
    /** `weeklyDigest.cron`; default '0 9 * * 1'. */
    cron: z.string(),
    /** `weeklyDigest.recipients` — email allowlist for --email delivery. */
    recipients: z.array(z.string()),
  }),
  /** Remote model catalog (`modelCatalog.*`); per-provider URL overrides stay file-only. */
  modelCatalog: z.object({
    /** `modelCatalog.enabled`; default true. */
    enabled: z.boolean(),
    /** `modelCatalog.url`; null = built-in endpoint. */
    url: z.string().nullable(),
    /** `modelCatalog.ttlHours`; default 24. */
    ttlHours: z.number(),
  }),
  /** Error-log rotation (`logs.rotation.*`). */
  logsRotation: z.object({
    /** `logs.rotation.enabled`; default true. */
    enabled: z.boolean(),
    /** `logs.rotation.maxBytes`; null = built-in default. */
    maxBytes: z.number().nullable(),
    /** `logs.rotation.maxFiles`; null = built-in default. */
    maxFiles: z.number().nullable(),
  }),
  /** `web.search_backend` — web_search backend; null = auto. */
  webSearchBackend: z.enum(['exa', 'tavily', 'brave']).nullable(),
  /** `web.extract_backend` — web_extract backend; null = auto. */
  webExtractBackend: z.enum(['htmltext']).nullable(),
  /** Context-compression summarizer model (`auxiliary.compression.*`). */
  auxCompression: AuxModelGetSchema,
  /** Vision fallback model (`auxiliary.vision.*`). */
  auxVision: AuxModelGetSchema,
  /** web_extract summarizer model (`auxiliary.web.*`). */
  auxWeb: AuxModelGetSchema,
  /** Agent-to-Agent surface gate (`a2a.enabled`); default false. */
  a2aEnabled: z.boolean(),
  /** Auto-install plugins from plugins.lock (`plugins.auto_install`); null = unset. */
  pluginsAutoInstall: z.boolean().nullable(),
  /** Public web UI URL, OAuth redirect base (`webBaseUrl`); null = localhost default. */
  webBaseUrl: z.string().nullable(),
});

// For the Settings-page additions below, every scalar accepts `null` meaning
// "delete the config.yaml key and fall back to the built-in default" —
// `undefined`/omitted always means "leave unchanged". Record fields
// (webhooks, quickCommands, channelToolsets, retention, personalityRetention)
// are full replacements: entries absent from the provided record are removed.
const ConfigUpdateInput = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  personality: z.string().optional(),
  memory: z.enum(['markdown', 'vector', 'vault']).optional(),
  modelRouting: z.record(z.string(), z.string()).optional(),
  skin: z.string().optional(),
  providers: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
      }),
    )
    .optional(),
  approvalMode: z.enum(['manual', 'smart', 'off']).optional(),
  verbosity: z.enum(['concise', 'balanced', 'verbose']).optional(),
  debugMode: z.boolean().optional(),
  contextLayering: z.boolean().optional(),
  debugPanelEnabled: z.boolean().optional(),
  debugPanelModel: z.string().nullable().optional(),
  adminEnabled: z.boolean().optional(),
  streamingEdits: z.enum(['off', 'dms', 'all']).optional(),
  autoCompact: z.boolean().optional(),
  memoryConsolidationEnabled: z.boolean().optional(),
  memoryCaptureEnabled: z.boolean().optional(),
  memoryCaptureModel: z.string().optional(),
  memoryNotices: z.boolean().optional(),
  voiceChime: z.boolean().optional(),
  voiceEndpointSilenceMs: z.number().min(300).max(1500).optional(),
  voiceBargeThreshold: z.number().min(0.02).max(0.2).optional(),
  voiceBargeSustainMs: z.number().min(100).max(800).optional(),
  voiceSpeechThreshold: z.number().min(0.005).max(0.1).optional(),
  voiceSpeechMinMs: z.number().min(100).max(500).optional(),
  voiceProvider: z.string().optional(),
  voiceApiKey: z.string().optional(),
  voiceBaseUrl: z.string().optional(),
  voiceModel: z.string().optional(),
  voiceTtsProvider: z.string().optional(),
  voiceTtsApiKey: z.string().optional(),
  voiceTtsVoice: z.string().optional(),
  voiceTtsBaseUrl: z.string().optional(),
  voiceTtsModel: z.string().optional(),
  /** `auxiliary.asr.command` — `command-stt`'s shell template; null clears the key. */
  voiceSttCommand: z.string().nullable().optional(),
  /** `auxiliary.tts.command` — `command-tts`'s shell template; null clears the key. */
  voiceTtsCommand: z.string().nullable().optional(),
  /** `auxiliary.tts.outputFormat`; null clears the key. */
  voiceTtsOutputFormat: z.enum(['opus', 'mp3', 'wav', 'pcm']).nullable().optional(),
  /** `auxiliary.tts.timeout`, ms; null clears the key. */
  voiceTtsTimeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
  /** `auxiliary.tts.maxTextLength`, chars; null clears the key. */
  voiceTtsMaxTextLength: z.number().int().min(100).max(100_000).nullable().optional(),
  /** `auxiliary.asr.timeout`, ms; null clears the key. */
  voiceSttTimeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
  /** `voice.trustedPlugins`; null (or an empty list) clears the key, which
   *  turns the local-only egress gate OFF. */
  voiceTrustedPlugins: z.array(z.string()).nullable().optional(),
  /** `voice.defaultMode`; null clears the key (back to `mirror_inbound`). */
  voiceDefaultMode: z.enum(['off', 'mirror_inbound', 'all']).nullable().optional(),
  // -- Settings-page additions (see the null-clears note above) --------------
  /** Azure-only REST API version (`apiVersion`). */
  apiVersion: z.string().nullable().optional(),
  /** Per-turn timing summary (`verbose`). */
  verbose: z.boolean().nullable().optional(),
  /** `display.verbosity` */
  displayVerbosity: z.enum(['quiet', 'default', 'verbose', 'debug']).nullable().optional(),
  /** `display.busy_input_mode` */
  displayBusyInputMode: z.enum(['interrupt', 'queue', 'steer']).nullable().optional(),
  /** `display.tool_preview_length` — integer >= 0 (0 = no truncation). */
  displayToolPreviewLength: z.number().int().min(0).nullable().optional(),
  /** `display.resume_hint` */
  displayResumeHint: z.boolean().nullable().optional(),
  /** `display.resume_recap_turns` — integer 0-10. */
  displayResumeRecapTurns: z.number().int().min(0).max(10).nullable().optional(),
  /** `display.bell_on_complete` */
  displayBellOnComplete: z.boolean().nullable().optional(),
  /** `compaction.*` thresholds. Per-field merge; null clears one key. */
  compaction: z
    .object({
      /** `compaction.pressure` — fraction in (0,1]. */
      pressure: z.number().gt(0).max(1).nullable().optional(),
      /** `compaction.target` — fraction in (0,1]. */
      target: z.number().gt(0).max(1).nullable().optional(),
      /** `compaction.gateDelta` — integer >= 0. */
      gateDelta: z.number().int().min(0).nullable().optional(),
      /** `compaction.retryOnOverflow` */
      retryOnOverflow: z.boolean().nullable().optional(),
      /** `compaction.smallWindow` */
      smallWindow: z.enum(['auto', 'on', 'off']).nullable().optional(),
    })
    .optional(),
  /** `memoryVault.*`. Per-field merge; null / empty array clears one key. */
  memoryVault: z
    .object({
      path: z.string().nullable().optional(),
      agentDir: z.string().nullable().optional(),
      prefetch: z.array(z.string()).nullable().optional(),
      exclude: z.array(z.string()).nullable().optional(),
    })
    .optional(),
  /** `memoryApproval.*`. Per-field merge; null clears one key. */
  memoryApproval: z
    .object({
      mode: z.enum(['off', 'automated', 'all']).nullable().optional(),
      /** Positive integer. */
      cap: z.number().int().min(1).nullable().optional(),
      /** Positive integer. */
      ttlDays: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `memoryConsolidation.*` decay + flush tunables. Per-field merge. */
  memoryConsolidation: z
    .object({
      halfLifeDays: z.number().gt(0).nullable().optional(),
      threshold: z.number().min(0).max(1).nullable().optional(),
      exemptUser: z.boolean().nullable().optional(),
      /** Fraction in (0,1]. */
      flushThreshold: z.number().gt(0).max(1).nullable().optional(),
      timeboxMs: z.number().int().min(0).nullable().optional(),
      maxTokens: z.number().int().min(0).nullable().optional(),
      maxDeltaChars: z.number().int().min(0).nullable().optional(),
      minMessagesSinceFlush: z.number().int().min(0).nullable().optional(),
    })
    .optional(),
  /** `memoryCapture.*` aux wiring + rate caps. `apiKey` is write-only. */
  memoryCapture: z
    .object({
      provider: z.string().nullable().optional(),
      /** Write-only; never echoed back. Null deletes the stored key. */
      apiKey: z.string().nullable().optional(),
      baseUrl: z.string().nullable().optional(),
      maxPerHour: z.number().int().min(1).nullable().optional(),
      maxPerDay: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `background.<snake_case>` job-pool caps. Per-field merge. */
  background: z
    .object({
      enabled: z.boolean().nullable().optional(),
      maxConcurrentJobs: z.number().int().min(1).nullable().optional(),
      maxJobsPerRoot: z.number().int().min(1).nullable().optional(),
      maxJobsPerPersonality: z.number().int().min(1).nullable().optional(),
      defaultMaxCostUsd: z.number().min(0).nullable().optional(),
      maxRootBackgroundUsd: z.number().min(0).nullable().optional(),
      queuedTtlMs: z.number().int().min(0).nullable().optional(),
      staleMs: z.number().int().min(0).nullable().optional(),
      heartbeatMs: z.number().int().min(0).nullable().optional(),
      retentionDays: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** Global retention TTLs — full replacement of all `retention.<subkey>` keys. */
  retention: z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema).optional(),
  /** Per-personality retention — full replacement of `personalities.<id>.retention.*`. */
  personalityRetention: z
    .record(ConfigRecordKeySchema, z.partialRecord(RetentionSubkeySchema, RetentionDurationSchema))
    .optional(),
  /** Inbound webhooks — full replacement of `webhooks.*` (secrets preserved per hook). */
  webhooks: z.record(ConfigRecordKeySchema, WebhookUpdateSchema).optional(),
  /** Quick commands — full replacement of `quick_commands.*`. */
  quickCommands: z.record(ConfigRecordKeySchema, QuickCommandUpdateSchema).optional(),
  /** Channel toolsets — full replacement of `channel_toolsets.*`. */
  channelToolsets: z.record(ConfigRecordKeySchema, z.array(z.string())).optional(),
  /** `nightlyPass.*`. Per-field merge; null clears one key. */
  nightlyPass: z
    .object({
      enabled: z.boolean().nullable().optional(),
      cron: z.string().min(1).nullable().optional(),
    })
    .optional(),
  /** `weeklyDigest.*`. Per-field merge; null / empty array clears one key. */
  weeklyDigest: z
    .object({
      enabled: z.boolean().nullable().optional(),
      cron: z.string().min(1).nullable().optional(),
      recipients: z.array(z.string()).nullable().optional(),
    })
    .optional(),
  /** `modelCatalog.*` scalars. Per-field merge; null clears one key. */
  modelCatalog: z
    .object({
      enabled: z.boolean().nullable().optional(),
      url: z.string().nullable().optional(),
      ttlHours: z.number().gt(0).nullable().optional(),
    })
    .optional(),
  /** `logs.rotation.*`. Per-field merge; null clears one key. */
  logsRotation: z
    .object({
      enabled: z.boolean().nullable().optional(),
      maxBytes: z.number().int().min(1).nullable().optional(),
      maxFiles: z.number().int().min(1).nullable().optional(),
    })
    .optional(),
  /** `web.search_backend` */
  webSearchBackend: z.enum(['exa', 'tavily', 'brave']).nullable().optional(),
  /** `web.extract_backend` */
  webExtractBackend: z.enum(['htmltext']).nullable().optional(),
  /** `auxiliary.compression.*` */
  auxCompression: AuxModelUpdateSchema.optional(),
  /** `auxiliary.vision.*` */
  auxVision: AuxModelUpdateSchema.optional(),
  /** `auxiliary.web.*` */
  auxWeb: AuxModelUpdateSchema.optional(),
  /** `a2a.enabled` */
  a2aEnabled: z.boolean().nullable().optional(),
  /** `plugins.auto_install` */
  pluginsAutoInstall: z.boolean().nullable().optional(),
  /** `webBaseUrl` */
  webBaseUrl: z.string().nullable().optional(),
});
const ConfigUpdateOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const config = {
  get: oc.output(ConfigGetOutput),
  update: oc.input(ConfigUpdateInput).output(ConfigUpdateOutput),
};

// ---------------------------------------------------------------------------
// Debug — sidecar assistant that inspects session events, spans, and logs
// ---------------------------------------------------------------------------

const DebugChatInput = z.object({
  mainSessionId: z.string(),
  message: z.string().min(1),
  clientId: z.string().optional(),
});
const DebugChatOutput = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  response: z.string(),
});

const debug = {
  chat: oc.input(DebugChatInput).output(DebugChatOutput),
};

// ---------------------------------------------------------------------------
// Cron (v0.5 — the proactive pillar)
//
// Web tab manages jobs.json on disk and reads run-output files from
// `<dataDir>/cron/output/<jobId>/<timestamp>.md`. The actual ticker
// lives in `serve.ts`.
// ---------------------------------------------------------------------------

const CronListOutput = z.object({ jobs: z.array(CronJobSchema) });

const CronGetInput = z.object({ id: z.string().min(1) });
const CronGetOutput = z.object({ job: CronJobSchema });

const CronCreateInput = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  personalityId: z.string().min(1),
  missedRunPolicy: MissedRunPolicySchema.optional(),
  // When true, the job is given a `web` origin so its output delivers into a
  // web chat session and surfaces in the Activity feed (in-app heartbeat).
  notifyInApp: z.boolean().optional(),
});
const CronCreateOutput = z.object({ job: CronJobSchema });

const CronIdOnlyInput = z.object({ id: z.string().min(1) });
const CronOkOutput = z.object({ ok: z.literal(true) });

const CronRunNowInput = z.object({ id: z.string().min(1) });
const CronRunNowOutput = z.object({
  ok: z.literal(true),
  /** Full output body from this synchronous run. */
  output: z.string(),
  ranAt: z.string(),
});

const CronUpdateInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  schedule: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  personalityId: z.string().min(1).optional(),
});
const CronUpdateOutput = z.object({ job: CronJobSchema });

const CronHistoryInput = z.object({
  id: z.string().min(1),
  /** Page size; max 100 to keep payloads bounded. Default 20. */
  limit: z.number().int().min(1).max(100).optional(),
});
const CronHistoryOutput = z.object({ runs: z.array(CronRunSchema) });

/** @experimental */
const cron = {
  list: oc.output(CronListOutput),
  get: oc.input(CronGetInput).output(CronGetOutput),
  create: oc.input(CronCreateInput).output(CronCreateOutput),
  update: oc.input(CronUpdateInput).output(CronUpdateOutput),
  delete: oc.input(CronIdOnlyInput).output(CronOkOutput),
  pause: oc.input(CronIdOnlyInput).output(CronOkOutput),
  resume: oc.input(CronIdOnlyInput).output(CronOkOutput),
  runNow: oc.input(CronRunNowInput).output(CronRunNowOutput),
  history: oc.input(CronHistoryInput).output(CronHistoryOutput),
};

// ---------------------------------------------------------------------------
// Skills (v0.5 — the learning pillar)
//
// Library panel CRUD over `~/.ethos/skills/*.md`. Per-personality skill
// directories arrive in v1 as part of the Personalities tab — for now the
// surface is the global library only.
// ---------------------------------------------------------------------------

const SkillListOutput = z.object({
  skills: z.array(SkillSchema),
  /** Approval queue size — surfaced as a sidebar badge so the user can
   *  see pending candidates without opening the Evolver panel. */
  pendingCount: z.number().int().nonnegative(),
});

const SkillGetInput = z.object({ id: z.string().min(1) });
const SkillGetOutput = z.object({ skill: SkillSchema });

const SkillCreateInput = z.object({
  /** Plain filename (no path, no `.md`). Letters, digits, dash, underscore. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  /** Markdown body. May start with a YAML frontmatter block. */
  body: z.string(),
});
const SkillCreateOutput = z.object({ skill: SkillSchema });

const SkillUpdateInput = z.object({
  id: z.string().min(1),
  body: z.string(),
});
const SkillUpdateOutput = z.object({ skill: SkillSchema });

const SkillDeleteInput = z.object({ id: z.string().min(1) });
const SkillOkOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const skills = {
  list: oc.input(z.object({ includeUnavailable: z.boolean().optional() })).output(SkillListOutput),
  get: oc.input(SkillGetInput).output(SkillGetOutput),
  create: oc.input(SkillCreateInput).output(SkillCreateOutput),
  update: oc.input(SkillUpdateInput).output(SkillUpdateOutput),
  delete: oc.input(SkillDeleteInput).output(SkillOkOutput),
};

// ---------------------------------------------------------------------------
// Evolver (v0.5 — companion to Skills)
//
// Three operations: configure thresholds, manage the pending approval
// queue produced by `SkillEvolver.evolve()`, and read the run history log.
// The actual evolve loop runs out-of-band (CLI / cron); this namespace
// only exposes its inputs and outputs to the web tab.
// ---------------------------------------------------------------------------

const EvolverConfigGetOutput = z.object({ config: EvolveConfigSchema });
const EvolverConfigUpdateInput = EvolveConfigSchema;
const EvolverConfigUpdateOutput = z.object({ config: EvolveConfigSchema });

const EvolverPendingListOutput = z.object({ pending: z.array(PendingSkillSchema) });
const EvolverPendingActionInput = z.object({ id: z.string().min(1) });
const EvolverHistoryInput = z.object({ limit: z.number().int().min(1).max(100).optional() });
const EvolverHistoryOutput = z.object({ runs: z.array(EvolverRunSchema) });

/** @experimental */
const evolver = {
  configGet: oc.output(EvolverConfigGetOutput),
  configUpdate: oc.input(EvolverConfigUpdateInput).output(EvolverConfigUpdateOutput),
  pendingList: oc.output(EvolverPendingListOutput),
  pendingApprove: oc.input(EvolverPendingActionInput).output(SkillOkOutput),
  pendingReject: oc.input(EvolverPendingActionInput).output(SkillOkOutput),
  history: oc.input(EvolverHistoryInput).output(EvolverHistoryOutput),
};

// ---------------------------------------------------------------------------
// Communications (v1)
//
// Per-platform connection state + setup form. Read returns only
// configured-ness flags; secrets never cross the wire. Update accepts
// per-field plaintext; empty / omitted fields preserve the existing
// value (so users can rotate one secret without re-entering all).
// ---------------------------------------------------------------------------

const PlatformsListOutput = z.object({ platforms: z.array(PlatformStatusSchema) });

const PlatformsSetInput = z.object({
  id: PlatformIdSchema,
  /** Per-field plaintext. Field names match the schema each platform
   *  declares — e.g. telegram = { token }, slack = { botToken,
   *  appToken, signingSecret }. Empty / missing keys preserve the
   *  current value. */
  fields: z.record(z.string(), z.string()),
});
const PlatformsSetOutput = z.object({ platform: PlatformStatusSchema });

const PlatformsClearInput = z.object({ id: PlatformIdSchema });
const PlatformsClearOutput = z.object({ platform: PlatformStatusSchema });

// W2.1 — live token probe. Runs the per-platform validator server-side and
// returns a W1.2 liveness verdict so onboarding can distinguish a rejected
// token (Continue disabled) from an unreachable platform (saved unverified).
const PlatformsValidateInput = z.object({
  id: PlatformIdSchema,
  fields: z.record(z.string(), z.string()),
});
const PlatformsValidateOutput = z.object({
  /** `ok` — token accepted; `rejected` — definitively bad (401/403);
   *  `unreachable` — outage (timeout/DNS/5xx/429); `unsupported` — no probe
   *  exists for this platform (e.g. email). */
  status: z.enum(['ok', 'rejected', 'unreachable', 'unsupported']),
  /** `@botname` / workspace name on success, else null. */
  label: z.string().nullable(),
  error: z.string().nullable(),
});

/** @experimental */
const platforms = {
  list: oc.output(PlatformsListOutput),
  set: oc.input(PlatformsSetInput).output(PlatformsSetOutput),
  clear: oc.input(PlatformsClearInput).output(PlatformsClearOutput),
  validate: oc.input(PlatformsValidateInput).output(PlatformsValidateOutput),
  botsListTelegram: oc.output(z.object({ bots: z.array(TelegramBotEntrySchema) })),
  botsAddTelegram: oc
    .input(
      z.object({
        token: z.string().min(1),
        bind: BotBindingSchema,
        username: z.string().optional(),
      }),
    )
    .output(z.object({ bot: TelegramBotEntrySchema })),
  botsRemoveTelegram: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  botsListSlack: oc.output(z.object({ bots: z.array(SlackAppEntrySchema) })),
  botsAddSlack: oc
    .input(
      z.object({
        botToken: z.string().min(1),
        appToken: z.string().min(1),
        signingSecret: z.string().min(1),
        bind: BotBindingSchema,
      }),
    )
    .output(z.object({ bot: SlackAppEntrySchema })),
  botsRemoveSlack: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  // WhatsApp: no tokens/secrets. An entry is routing knobs + a personality/team
  // `bind`; pairing happens out-of-band via QR (the setup-whatsapp SSE flow).
  botsListWhatsApp: oc.output(z.object({ bots: z.array(WhatsAppEntrySchema) })),
  botsAddWhatsApp: oc
    .input(
      z.object({
        id: z.string().optional(),
        defaultMode: z.enum(['all', 'mention_only']).optional(),
        allowedNumbers: z.array(z.string()).optional(),
        phoneNumber: z.string().optional(),
        bind: BotBindingSchema,
      }),
    )
    .output(z.object({ bot: WhatsAppEntrySchema })),
  botsRemoveWhatsApp: oc
    .input(z.object({ botKey: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  getChannelFilter: oc
    .input(z.object({ platform: z.string() }))
    .output(z.object({ filter: ChannelPlatformFilterSchema })),

  setChannelFilter: oc
    .input(z.object({ platform: z.string(), filter: ChannelPlatformFilterSchema }))
    .output(z.object({ filter: ChannelPlatformFilterSchema })),
};

// ---------------------------------------------------------------------------
// Plugins + MCP (v1)
//
// Returns the union of installed plugins (discovered in user / project
// / npm dirs) and configured MCP servers. install/uninstall delegate to
// npm under the hood (same as the CLI's `ethos plugin install / remove`).
// ---------------------------------------------------------------------------

const PluginsListOutput = z.object({
  plugins: z.array(PluginInfoSchema),
  mcpServers: z.array(McpServerInfoSchema),
});

const PluginsInstallInput = z.object({ packageSpec: z.string().min(1) });
const PluginsInstallOutput = z.object({ ok: z.literal(true) });
const PluginsUninstallInput = z.object({ pluginId: z.string().min(1) });
const PluginsUninstallOutput = z.object({ ok: z.literal(true) });

const PluginsSetCredentialInput = z.object({
  pluginId: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
});
const PluginsSetCredentialOutput = z.object({ ok: z.literal(true) });

const PluginsGetCredentialMetaInput = z.object({
  pluginId: z.string().min(1),
  key: z.string().min(1),
});
const PluginsGetCredentialMetaOutput = z.object({
  updatedAt: z.string().nullable(),
});

const PluginsListCredentialKeysInput = z.object({
  pluginId: z.string().min(1),
});
const PluginsListCredentialKeysOutput = z.object({
  keys: z.array(CredentialKeyInfoSchema),
});

const PluginsGetPageSpecInput = z.object({ pluginId: z.string().min(1) });
const PluginsGetPageSpecOutput = z.object({
  spec: z
    .object({
      title: z.string(),
      icon: z.string().optional(),
      sections: z.array(z.record(z.string(), z.unknown())),
      showInSidebar: z.boolean().optional(),
    })
    .nullable(),
});

const PluginsInvokeToolForPageInput = z.object({
  pluginId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
const PluginsInvokeToolForPageOutput = z.object({
  ok: z.boolean(),
  value: z.string(),
  structured: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

const PluginsGetCredentialInput = z.object({
  pluginId: z.string().min(1),
  ref: z.string().min(1),
});
const PluginsGetCredentialOutput = z.object({
  value: z.string().nullable(),
});

const PluginsCredentialPreviewInput = z.object({
  pluginId: z.string().min(1),
  ref: z.string().min(1),
});
const PluginsCredentialPreviewOutput = z.object({
  preview: z.string().nullable(),
});

const PluginsExecuteToolInput = z.object({
  pluginId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
const PluginsExecuteToolOutput = z.object({
  ok: z.boolean(),
  value: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

const PluginsRequestOAuthInput = z.object({
  pluginId: z.string(),
  oauthRef: z.string(),
});
const PluginsRequestOAuthOutput = z.object({
  url: z.string(),
});

const PluginsCompleteOAuthInput = z.object({
  pluginId: z.string(),
  oauthRef: z.string(),
  requestToken: z.string(),
});
const PluginsCompleteOAuthOutput = z.object({
  ok: z.boolean(),
  userId: z.string().optional(),
});

/** @experimental */
const plugins = {
  list: oc.output(PluginsListOutput),
  install: oc.input(PluginsInstallInput).output(PluginsInstallOutput),
  uninstall: oc.input(PluginsUninstallInput).output(PluginsUninstallOutput),
  setCredential: oc.input(PluginsSetCredentialInput).output(PluginsSetCredentialOutput),
  getCredentialMeta: oc.input(PluginsGetCredentialMetaInput).output(PluginsGetCredentialMetaOutput),
  listCredentialKeys: oc
    .input(PluginsListCredentialKeysInput)
    .output(PluginsListCredentialKeysOutput),
  getPageSpec: oc.input(PluginsGetPageSpecInput).output(PluginsGetPageSpecOutput),
  invokeToolForPage: oc.input(PluginsInvokeToolForPageInput).output(PluginsInvokeToolForPageOutput),
  getCredential: oc.input(PluginsGetCredentialInput).output(PluginsGetCredentialOutput),
  credentialPreview: oc.input(PluginsCredentialPreviewInput).output(PluginsCredentialPreviewOutput),
  executeTool: oc.input(PluginsExecuteToolInput).output(PluginsExecuteToolOutput),
  requestOAuth: oc.input(PluginsRequestOAuthInput).output(PluginsRequestOAuthOutput),
  completeOAuth: oc.input(PluginsCompleteOAuthInput).output(PluginsCompleteOAuthOutput),
};

// ---------------------------------------------------------------------------
// MCP install flow (v1 — OAuth UI)
//
// Server-side orchestration for the MCP OAuth dance: discover, register
// a dynamic client, redirect the user to the upstream authorization
// endpoint, then exchange the code for tokens and persist the server.
// ---------------------------------------------------------------------------

/** @experimental */
const mcp = {
  start: oc.input(McpStartInputSchema).output(McpStartOutputSchema),
  complete: oc.input(McpCompleteInputSchema).output(McpCompleteOutputSchema),
  status: oc.output(McpStatusOutputSchema),
  cancel: oc.input(McpCancelInputSchema).output(z.object({ ok: z.literal(true) })),
  attachPersonalities: oc.input(McpAttachInputSchema).output(McpAttachOutputSchema),
  list: oc.output(McpListOutputSchema),
  delete: oc.input(McpDeleteInputSchema).output(z.object({ ok: z.literal(true) })),
  reconnect: oc.input(McpReconnectInputSchema).output(McpStartOutputSchema),
  /** List the bare tool names a given MCP server exposes, for the
   *  per-server tool checklist in the personality editor. */
  serverTools: oc.input(McpServerToolsInputSchema).output(McpServerToolsOutputSchema),
  /** List MCP servers attached to a personality with their OAuth auth status. */
  personalityServers: oc
    .input(McpPersonalityServersInputSchema)
    .output(McpPersonalityServersOutputSchema),
  addServer: oc.input(McpAddServerInputSchema).output(McpAddServerOutputSchema),
  refreshToken: oc.input(McpRefreshTokenInputSchema).output(McpRefreshTokenOutputSchema),
  rename: oc.input(McpRenameInputSchema).output(McpRenameOutputSchema),
  updateToken: oc.input(McpUpdateTokenInputSchema).output(McpUpdateTokenOutputSchema),
  scopeStatus: oc.input(McpScopeStatusInputSchema).output(McpScopeStatusOutputSchema),
  validateConfig: oc.input(McpValidateConfigInputSchema).output(McpValidateConfigOutputSchema),
};

// ---------------------------------------------------------------------------
// Memory (v1)
//
// Two markdown files MarkdownFileMemoryProvider reads at agent-loop
// prefetch: MEMORY.md (rolling project context) and USER.md (who you
// are — persistent across sessions). The web tab is the editor for
// both. Vector-mode chunk CRUD lands later.
// ---------------------------------------------------------------------------

const MemoryListInput = z.object({
  personalityId: z.string().min(1),
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
  /** When present and store is 'user', reads user-scoped memory. */
  userId: z.string().optional(),
});
const MemoryListOutput = z.object({
  items: z.array(MemoryFileSchema),
  nextCursor: z.string().nullable(),
});

const MemoryGetInput = z.object({
  store: MemoryStoreSchema,
  personalityId: z.string().min(1),
  /** When present and store is 'user', reads user-scoped memory. */
  userId: z.string().optional(),
});
const MemoryGetOutput = z.object({ file: MemoryFileSchema });

const MemoryWriteInput = z.object({
  store: MemoryStoreSchema,
  content: z.string(),
  personalityId: z.string().min(1),
  /** When present and store is 'user', writes user-scoped memory. */
  userId: z.string().optional(),
});
const MemoryWriteOutput = z.object({ file: MemoryFileSchema });

const MemoryListUsersOutput = z.object({
  users: z.array(IdentityMapEntrySchema),
});

// Timeline sub-view (pillar D, §5). Read-only over the personality-scoped
// provenance history; paginated newest-first with an opaque offset cursor so
// a 1k-entry history loads a page at a time.
const MemoryHistoryInput = z.object({
  personalityId: z.string().min(1),
  /** Filter to one memory file (e.g. `MEMORY.md`, `memory-archive.md`). */
  key: z.string().optional(),
  source: MemoryHistorySourceSchema.optional(),
  /** Lower time bound (epoch-ms, inclusive) — the start of the date range. */
  sinceMs: z.number().optional(),
  /** Upper time bound (epoch-ms, inclusive) — the end of the date range. */
  untilMs: z.number().optional(),
  /** Page size; max 200 to keep payloads bounded. Default 50. */
  limit: z.number().int().min(1).max(200).optional(),
  /** Opaque offset cursor from the previous response's `nextCursor`. */
  cursor: z.string().nullable().optional(),
});
const MemoryHistoryOutput = z.object({
  entries: z.array(MemoryHistoryEntrySchema),
  nextCursor: z.string().nullable(),
  /** Count of torn/malformed JSONL lines the tolerant reader skipped. */
  corruptLines: z.number(),
});

const MemoryHistoryBlobInput = z.object({
  personalityId: z.string().min(1),
  /** Content-address from a history entry's `blob` field. */
  blob: z.string().min(1),
});
const MemoryHistoryBlobOutput = z.object({
  /** Full pre-mutation content, or null when the blob is missing. */
  content: z.string().nullable(),
});

const MemoryRestoreInput = z.object({
  personalityId: z.string().min(1),
  /** Stable slug of the archived section to restore. */
  slug: z.string().min(1),
});
const MemoryRestoreOutput = z.object({
  ok: z.literal(true),
  /** The live file the section was restored into (e.g. `MEMORY.md`). */
  restoredTo: z.string(),
});

// Pending sub-view (approve-before-store, L3 §3b). Mirrors the skill-evolver
// pending contract: list the parked candidates for a personality's scope,
// approve (replay through durable memory under the original source + approvedBy)
// or reject (tombstone the fact-hash so capture never re-proposes it).
const MemoryPendingListInput = z.object({
  personalityId: z.string().min(1),
});
const MemoryPendingListOutput = z.object({ pending: z.array(PendingMemorySchema) });

const MemoryPendingActionInput = z.object({
  personalityId: z.string().min(1),
  /** Opaque queue id from a `pendingList` entry. */
  id: z.string().min(1),
});
const MemoryPendingActionOutput = z.object({ ok: z.literal(true) });

/** @stable v1 */
const memory = {
  list: oc.input(MemoryListInput).output(MemoryListOutput),
  get: oc.input(MemoryGetInput).output(MemoryGetOutput),
  write: oc.input(MemoryWriteInput).output(MemoryWriteOutput),
  listUsers: oc.input(z.object({})).output(MemoryListUsersOutput),
  history: oc.input(MemoryHistoryInput).output(MemoryHistoryOutput),
  historyBlob: oc.input(MemoryHistoryBlobInput).output(MemoryHistoryBlobOutput),
  restore: oc.input(MemoryRestoreInput).output(MemoryRestoreOutput),
  pendingList: oc.input(MemoryPendingListInput).output(MemoryPendingListOutput),
  pendingApprove: oc.input(MemoryPendingActionInput).output(MemoryPendingActionOutput),
  pendingReject: oc.input(MemoryPendingActionInput).output(MemoryPendingActionOutput),
};

// ---------------------------------------------------------------------------
// Mesh (v0.5 — the swarm pillar)
//
// Read-only view of the agent-mesh registry (file-backed at
// ~/.ethos/mesh-registry.json). `routeTest` runs the mesh's own least-
// busy router against a capability so the user can verify discovery
// without dispatching real work.
// ---------------------------------------------------------------------------

const MeshListOutput = z.object({ agents: z.array(MeshAgentSchema) });

const MeshRouteTestInput = z.object({
  /** Capability the synthetic task should route to (e.g. `code`, `web`). */
  capability: z.string().min(1),
});
const MeshRouteTestOutput = MeshRouteResultSchema;

/** @experimental */
const mesh = {
  list: oc.output(MeshListOutput),
  routeTest: oc.input(MeshRouteTestInput).output(MeshRouteTestOutput),
};

// ---------------------------------------------------------------------------
// Lab — Batch (v1)
//
// Submits the runner with a tasks JSONL string + concurrency, returns
// a run id. The frontend polls `batch.list` / `batch.get` for live
// progress. `batch.output` returns the on-disk Atropos JSONL as a
// string for download. Cancel deferred — re-running with the same id
// resumes via the runner's checkpoint mechanism.
// ---------------------------------------------------------------------------

const BatchListOutput = z.object({ runs: z.array(BatchRunInfoSchema) });

const BatchStartInput = z.object({
  /** Newline-delimited JSON; each line `{ id, prompt, personalityId? }`. */
  tasksJsonl: z.string().min(1),
  /** Default 4. Max 16 to keep a single-user local app polite. */
  concurrency: z.number().int().min(1).max(16).optional(),
  /** Personality id used for tasks that don't pin one. */
  defaultPersonalityId: z.string().optional(),
});
const BatchStartOutput = z.object({ run: BatchRunInfoSchema });

const BatchGetInput = z.object({ id: z.string() });
const BatchGetOutput = z.object({ run: BatchRunInfoSchema });

const BatchOutputInput = z.object({ id: z.string() });
const BatchOutputOutput = z.object({ content: z.string() });

/** @experimental */
const batch = {
  list: oc.output(BatchListOutput),
  start: oc.input(BatchStartInput).output(BatchStartOutput),
  get: oc.input(BatchGetInput).output(BatchGetOutput),
  output: oc.input(BatchOutputInput).output(BatchOutputOutput),
};

// ---------------------------------------------------------------------------
// Lab — Eval (v1)
//
// Like batch, but with an expected JSONL + a scorer (defaults to
// `contains`). The runner's per-task scores land in the output file;
// `eval.get` surfaces the aggregate stats so the UI can render
// pass/fail counts + average score without parsing the JSONL.
// ---------------------------------------------------------------------------

const EvalListOutput = z.object({ runs: z.array(EvalRunInfoSchema) });

const EvalStartInput = z.object({
  tasksJsonl: z.string().min(1),
  /** Newline-delimited JSON: `{ id, expected, match? }`. */
  expectedJsonl: z.string().min(1),
  scorer: EvalScorerSchema.optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
});
const EvalStartOutput = z.object({ run: EvalRunInfoSchema });

const EvalGetInput = z.object({ id: z.string() });
const EvalGetOutput = z.object({ run: EvalRunInfoSchema });

const EvalOutputInput = z.object({ id: z.string() });
const EvalOutputOutput = z.object({ content: z.string() });

/** @experimental */
const evalNs = {
  list: oc.output(EvalListOutput),
  start: oc.input(EvalStartInput).output(EvalStartOutput),
  get: oc.input(EvalGetInput).output(EvalGetOutput),
  output: oc.input(EvalOutputInput).output(EvalOutputOutput),
};

// ---------------------------------------------------------------------------
// Kanban — Plan B Control Center surface
//
// Read-only for now (`list`, `getBoard`); mutations are deferred to a later
// pass so the Codex-driven correctness guarantees in `@ethosagent/kanban-store`
// stay the single source of truth. The board itself lives at
// `~/.ethos/teams/<name>/board.db`; the service opens it read-only.
// ---------------------------------------------------------------------------

const KanbanListOutput = z.object({ teams: z.array(KanbanTeamSummarySchema) });

const KanbanGetBoardInput = z.object({
  team: z.string().min(1),
});
const KanbanGetBoardOutput = z.object({ board: KanbanBoardSnapshotSchema });

const KanbanUpdateStatusInput = z.object({
  team: z.string().min(1),
  taskId: z.string().min(1),
  status: KanbanTaskStatusSchema,
  reason: z.string().optional(),
});
const KanbanUpdateStatusOutput = z.object({ task: KanbanTaskSchema });

const KanbanCreateTaskInput = z.object({
  team: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  priority: z.number().int().min(0).max(9).default(0),
  assignee: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
});
const KanbanCreateTaskOutput = z.object({ task: KanbanTaskSchema });

const KanbanListAgentsInput = z.object({
  team: z.string().min(1),
});
const KanbanListAgentsOutput = z.object({ agents: z.array(KanbanAgentSchema) });

const KanbanAssignInput = z.object({
  team: z.string().min(1),
  taskId: z.string().min(1),
  assignee: z.string().min(1),
});
const KanbanAssignOutput = z.object({ task: KanbanTaskSchema });

const KanbanGetTaskInput = z.object({ team: z.string().min(1), taskId: z.string().min(1) });
const KanbanGetTaskOutput = z.object({
  task: KanbanTaskSchema,
  comments: z.array(KanbanCommentSchema),
  runs: z.array(KanbanRunSchema),
});
const KanbanAddCommentInput = z.object({
  team: z.string().min(1),
  taskId: z.string().min(1),
  body: z.string().min(1),
});
const KanbanAddCommentOutput = z.object({ comment: KanbanCommentSchema });

/** @experimental */
const kanban = {
  list: oc.output(KanbanListOutput),
  getBoard: oc.input(KanbanGetBoardInput).output(KanbanGetBoardOutput),
  updateStatus: oc.input(KanbanUpdateStatusInput).output(KanbanUpdateStatusOutput),
  createTask: oc.input(KanbanCreateTaskInput).output(KanbanCreateTaskOutput),
  listAgents: oc.input(KanbanListAgentsInput).output(KanbanListAgentsOutput),
  assign: oc.input(KanbanAssignInput).output(KanbanAssignOutput),
  getTask: oc.input(KanbanGetTaskInput).output(KanbanGetTaskOutput),
  addComment: oc.input(KanbanAddCommentInput).output(KanbanAddCommentOutput),
};

// ---------------------------------------------------------------------------
// API Keys — admin CRUD (cookie-auth-gated only)
//
// Minting, listing, and revoking API keys for external Mission Controls.
// The plaintext secret is returned only from `create` — subsequent reads
// never expose the raw key. This namespace rejects bearer-token auth to
// prevent privilege escalation (a stolen key must not mint more keys).
// ---------------------------------------------------------------------------

const OriginSchema = z
  .string()
  .transform((s) => {
    try {
      const u = new URL(s);
      return u.origin;
    } catch {
      return s;
    }
  })
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.origin === s;
    } catch {
      return false;
    }
  }, 'Must be a valid origin (scheme + host + optional port, no path/query/fragment)');

const ApiKeyCreateInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  allowedOrigins: z.array(OriginSchema).min(1),
});
const ApiKeyCreateOutput = z.object({
  /** Plaintext secret — shown once, then never again. */
  secret: z.string(),
  key: ApiKeyMetadataSchema,
});

const ApiKeyListInput = z.object({
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
});
const ApiKeyListOutput = z.object({
  items: z.array(ApiKeyMetadataSchema),
  nextCursor: z.string().nullable(),
});

const ApiKeyRevokeInput = z.object({ id: z.string() });
const ApiKeyRevokeOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const apiKeys = {
  create: oc.input(ApiKeyCreateInput).output(ApiKeyCreateOutput),
  list: oc.input(ApiKeyListInput).output(ApiKeyListOutput),
  revoke: oc.input(ApiKeyRevokeInput).output(ApiKeyRevokeOutput),
};

// ---------------------------------------------------------------------------
// Meta — server capabilities (stable from v1)
//
// Open-shape `Record<string, boolean>` describing what this server
// supports. Today: `{ byok: true }`. Absence means unsupported. Keys
// are added additively — the shape never changes, only its contents grow.
// ---------------------------------------------------------------------------

const MetaCapabilitiesOutput = z.object({
  capabilities: z.record(z.string(), z.boolean()),
});

/** @stable v1 */
const meta = {
  capabilities: oc.output(MetaCapabilitiesOutput),
};

// ---------------------------------------------------------------------------
// Models — curated catalog for the model picker (suggestions only; users may
// type any model id). Sourced from packages/wiring's MODEL_CATALOG, grouped
// by provider id so the web UI can suggest per-selected-provider.
// ---------------------------------------------------------------------------

export const ModelCatalogOutput = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  providers: z.record(
    z.string(),
    z.object({
      models: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          contextWindow: z.number().int().positive(),
          default: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

/** @experimental */
const models = {
  catalog: oc.output(ModelCatalogOutput),
};

// ---------------------------------------------------------------------------
// Dashboards — widget templates from plugins + dashboard/panel CRUD
// ---------------------------------------------------------------------------

const WidgetTemplateSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  queryType: z.enum(['sql', 'prompt']),
  dataSource: z.string().optional(),
  sql: z.string().optional(),
  prompt: z.string().optional(),
  outputType: z.enum(['table', 'html', 'image', 'text']).optional(),
  defaultCron: z.string().optional(),
});

const DashboardsListWidgetTemplatesOutput = z.object({
  templates: z.array(WidgetTemplateSchema),
});

const ParamDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['select', 'options', 'date-range']),
  options: z.array(z.string()).optional(),
  default: z.string(),
});

const EmitRuleSchema = z.object({
  on: z.enum(['rowClick']),
  param: z.string(),
  column: z.string(),
  default: z.string(),
});

// Dashboard schemas
const DashboardSchema = z.object({
  id: z.string(),
  userId: z.string(),
  personalityId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  cronSchedule: z.string().nullable(),
  paramsSchema: z.array(ParamDefSchema),
  paramsCurrent: z.record(z.string(), z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const DashboardPanelSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  queryType: z.enum(['static', 'prompt', 'sql', 'header']),
  blockType: z.enum(['html', 'image', 'pdf', 'text', 'table']),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  title: z.string().nullable(),
  prompt: z.string().nullable(),
  sqlQuery: z.string().nullable(),
  pluginId: z.string().nullable(),
  dataSourceId: z.string().nullable(),
  renderHint: z.string().nullable(),
  cronSchedule: z.string().nullable(),
  htmlTemplate: z.string().nullable(),
  emitConfig: z.array(EmitRuleSchema).nullable(),
  dependsOn: z.array(z.string()).nullable(),
  paramDefaults: z.record(z.string(), z.string()),
  lastRunAt: z.number().nullable(),
  lastError: z.string().nullable(),
  sourceConversationId: z.string().nullable(),
  sourceMessageSeq: z.number().nullable(),
  col: z.number(),
  row: z.number(),
  w: z.number(),
  h: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Input schemas
const DashboardsCreateInput = z.object({
  title: z.string().min(1),
  personalityId: z.string().min(1),
  description: z.string().optional(),
});

const DashboardsGetInput = z.object({ id: z.string().min(1) });
const DashboardsUpdateInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  cronSchedule: z.string().nullable().optional(),
  paramsSchema: z.array(ParamDefSchema).optional(),
});
const DashboardsDeleteInput = z.object({ id: z.string().min(1) });

const DashboardsAddPanelInput = z.object({
  dashboardId: z.string().nullable(),
  newDashboardTitle: z.string().optional(),
  personalityId: z.string().optional(),
  paramsSchema: z.array(ParamDefSchema).optional(),
  panel: z.object({
    queryType: z.enum(['static', 'prompt', 'sql', 'header']),
    blockType: z.enum(['html', 'image', 'pdf', 'text', 'table']),
    content: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    sqlQuery: z.string().optional(),
    pluginId: z.string().optional(),
    dataSourceId: z.string().optional(),
    htmlTemplate: z.string().optional(),
    renderHint: z.string().optional(),
    cronSchedule: z.string().optional(),
    sourceConversationId: z.string().optional(),
    sourceMessageSeq: z.number().optional(),
  }),
});

const DashboardsUpdatePanelInput = z.object({
  panelId: z.string().min(1),
  title: z.string().optional(),
  cronSchedule: z.string().nullable().optional(),
  queryType: z.enum(['static', 'prompt', 'sql', 'header']).optional(),
  prompt: z.string().nullable().optional(),
  sqlQuery: z.string().nullable().optional(),
  pluginId: z.string().nullable().optional(),
  dataSourceId: z.string().nullable().optional(),
  htmlTemplate: z.string().nullable().optional(),
  emitConfig: z.array(EmitRuleSchema).nullable().optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
  paramDefaults: z.record(z.string(), z.string()).optional(),
});

const DashboardsUpdatePanelLayoutInput = z.object({
  panelId: z.string().min(1),
  col: z.number(),
  row: z.number(),
  w: z.number(),
  h: z.number(),
});

const DashboardsDeletePanelInput = z.object({ panelId: z.string().min(1) });

const DashboardsRefreshPanelInput = z.object({ panelId: z.string().min(1) });
const DashboardsRefreshAllInput = z.object({ dashboardId: z.string().min(1) });

const DashboardsUpdateParamsInput = z.object({
  id: z.string().min(1),
  paramsCurrent: z.record(z.string(), z.string()),
});

const DashboardsExportInput = z.object({
  id: z.string().min(1),
});

const DashboardsImportInput = z.object({
  exportJson: z.string(),
  titleOverride: z.string().optional(),
});

/** @experimental */
const dashboards = {
  create: oc.input(DashboardsCreateInput).output(z.object({ dashboard: DashboardSchema })),
  list: oc.output(z.object({ dashboards: z.array(DashboardSchema) })),
  get: oc.input(DashboardsGetInput).output(
    z.object({
      dashboard: DashboardSchema,
      panels: z.array(DashboardPanelSchema),
    }),
  ),
  update: oc.input(DashboardsUpdateInput).output(z.object({ ok: z.literal(true) })),
  delete: oc.input(DashboardsDeleteInput).output(z.object({ ok: z.literal(true) })),
  addPanel: oc.input(DashboardsAddPanelInput).output(z.object({ panel: DashboardPanelSchema })),
  updatePanel: oc.input(DashboardsUpdatePanelInput).output(z.object({ ok: z.literal(true) })),
  updatePanelLayout: oc
    .input(DashboardsUpdatePanelLayoutInput)
    .output(z.object({ ok: z.literal(true) })),
  deletePanel: oc.input(DashboardsDeletePanelInput).output(z.object({ ok: z.literal(true) })),
  refreshPanel: oc.input(DashboardsRefreshPanelInput).output(z.object({ ok: z.literal(true) })),
  refreshAll: oc.input(DashboardsRefreshAllInput).output(z.object({ ok: z.literal(true) })),
  summarizePrompt: oc
    .input(z.object({ sessionId: z.string().min(1) }))
    .output(z.object({ summary: z.string() })),
  listWidgetTemplates: oc.output(DashboardsListWidgetTemplatesOutput),
  runQuery: oc
    .input(
      z.object({
        pluginId: z.string().min(1),
        sourceId: z.string().min(1),
        sql: z.string().min(1),
      }),
    )
    .output(
      z.object({
        columns: z.array(z.string()),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
    ),
  updateParams: oc.input(DashboardsUpdateParamsInput).output(z.object({ ok: z.literal(true) })),
  exportDashboard: oc
    .input(DashboardsExportInput)
    .output(z.object({ json: z.string(), panelCount: z.number(), title: z.string() })),
  importDashboard: oc.input(DashboardsImportInput).output(
    z.object({
      dashboardId: z.string(),
      title: z.string(),
      warnings: z.array(z.string()),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Admin — unified status view for channels, providers, and MCP servers
// ---------------------------------------------------------------------------

const admin = {
  getStatus: oc.output(
    z.object({
      channels: z.array(
        z.object({
          id: z.string(),
          platform: z.string(),
          status: z.enum(['connected', 'disconnected', 'error']),
          webhookUrl: z.string().optional(),
        }),
      ),
      providers: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          hasKey: z.boolean(),
          healthy: z.boolean().optional(),
          latencyMs: z.number().optional(),
        }),
      ),
      mcpServers: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['connected', 'disconnected', 'error']),
          toolCount: z.number().optional(),
        }),
      ),
    }),
  ),
  rotateKey: oc
    .input(
      z.object({
        provider: z.string(),
        key: z.string(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  checkProvider: oc
    .input(
      z.object({
        provider: z.string(),
      }),
    )
    .output(z.object({ ok: z.boolean(), latencyMs: z.number() })),
  testSend: oc
    .input(
      z.object({
        channel: z.string(),
      }),
    )
    .output(z.object({ ok: z.boolean(), error: z.string().optional() })),
  addMcpServer: oc
    .input(
      z.object({
        name: z.string(),
        url: z.string(),
        authType: z.enum(['none', 'bearer', 'oauth']),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  removeMcpServer: oc
    .input(
      z.object({
        name: z.string(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Context — resolve @file / @url inline references (Gap 4)
// ---------------------------------------------------------------------------

const context = {
  resolve: oc.input(z.object({ refs: z.array(z.string()) })).output(
    z.object({
      resolved: z.array(
        z.object({
          ref: z.string(),
          content: z.string(),
          lang: z.string(),
        }),
      ),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Files — list workspace files for @-mention autocomplete (Gap 4)
// ---------------------------------------------------------------------------

const files = {
  list: oc.input(z.object({ prefix: z.string().optional() })).output(
    z.object({
      paths: z.array(z.string()),
    }),
  ),
};

// ---------------------------------------------------------------------------
// Slash commands (v3 — plugin-registered dynamic commands)
// ---------------------------------------------------------------------------

const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  usage: z.string(),
  pluginId: z.string().optional(),
});

const slashCommands = {
  list: oc.output(z.object({ commands: z.array(SlashCommandSchema) })),
};

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

const GoalGetInput = z.object({ id: z.string().min(1) });
const GoalGetOutput = z.object({
  goal: GoalSchema,
  events: z.array(GoalEventSchema),
  attempts: z.array(GoalAttemptSchema),
});

const GoalListInput = z.object({
  status: GoalStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const GoalListOutput = z.object({ goals: z.array(GoalSchema) });

const GoalSteerInput = z.object({ id: z.string().min(1), message: z.string().min(1) });
const GoalSteerOutput = z.object({ ok: z.boolean() });

const GoalCancelInput = z.object({ id: z.string().min(1) });
const GoalCancelOutput = z.object({ ok: z.boolean() });

const GoalResumeInput = z.object({ id: z.string().min(1) });
const GoalResumeOutput = z.object({ ok: z.boolean() });

const GoalCreateInput = z.object({
  personalityId: z.string().min(1),
  goalText: z.string().min(1),
  title: z.string().optional(),
  acceptanceCriteria: z
    .object({
      checks: z.array(z.object({ description: z.string() })).optional(),
      rubric: z.array(z.object({ description: z.string(), weight: z.number() })).optional(),
      threshold: z.number().optional(),
    })
    .optional(),
  maxAttempts: z.number().int().min(1).optional(),
  maxCostUsd: z.number().optional(),
  maxToolCallsPerTurn: z.number().int().min(1).optional(),
  maxIdenticalToolCalls: z.number().int().min(1).optional(),
  allowDangerousToolCalls: z.boolean().optional(),
  maxRecoveryAttempts: z.number().int().min(0).optional(),
  deadline: z.string().optional(),
});
const GoalCreateOutput = z.object({ goal: GoalSchema });

const GoalToolResultInput = z.object({
  goalId: z.string().min(1),
  toolCallId: z.string().min(1),
});
const GoalToolResultOutput = z.object({
  found: z.boolean(),
  toolName: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
});

/** @experimental */
const goals = {
  get: oc.input(GoalGetInput).output(GoalGetOutput),
  list: oc.input(GoalListInput).output(GoalListOutput),
  steer: oc.input(GoalSteerInput).output(GoalSteerOutput),
  cancel: oc.input(GoalCancelInput).output(GoalCancelOutput),
  resume: oc.input(GoalResumeInput).output(GoalResumeOutput),
  create: oc.input(GoalCreateInput).output(GoalCreateOutput),
  toolResult: oc.input(GoalToolResultInput).output(GoalToolResultOutput),
};

// ---------------------------------------------------------------------------
// Tasks — background-job (detached spawn-and-continue) surface
//
// Read-only plus one cancel: `list` enumerates jobs (optionally scoped to a
// root session), `get` reads one job with its ordered event trail (null when
// absent), `cancel` requests cancellation. The JobStore is the source of
// truth; the server maps rows to the wire schemas in `schemas.ts`.
// ---------------------------------------------------------------------------

const TasksListInput = z.object({ rootSessionKey: z.string().optional() });
const TasksListOutput = z.array(BackgroundJobSummarySchema);

const TasksGetInput = z.object({ id: z.string().min(1) });
const TasksGetOutput = BackgroundJobDetailSchema.nullable();

const TasksCancelInput = z.object({ id: z.string().min(1) });
const TasksCancelOutput = z.object({ ok: z.boolean() });

/** @experimental */
const tasks = {
  list: oc.input(TasksListInput).output(TasksListOutput),
  get: oc.input(TasksGetInput).output(TasksGetOutput),
  cancel: oc.input(TasksCancelInput).output(TasksCancelOutput),
};

// ---------------------------------------------------------------------------
// Digest — read-only view of the most recent weekly governed-learning digest
//
// The weekly digest writes Markdown to `~/.ethos/digests/<ISO-week>.md`.
// `digest.latest` returns the newest file (or null when none exist).
// `digest.generate` builds + writes the current ISO week's digest on demand
// (the same generator the weekly cron / `ethos digest run` drives), returning
// it — or null when there are no user personalities to report on.
// ---------------------------------------------------------------------------

/** @experimental */
const digest = {
  latest: oc.output(DigestLatestSchema.nullable()),
  generate: oc.output(DigestLatestSchema.nullable()),
};

// ---------------------------------------------------------------------------
// Voice — server-side STT transcription for the web/desktop chat
// ---------------------------------------------------------------------------

const VoiceTranscribeInput = z.object({
  audio: z.string().min(1),
  mimeType: z.string().min(1),
});
const VoiceTranscribeOutput = z.object({
  transcript: z.string(),
});
const VoiceSynthesizeInput = z.object({
  text: z.string().min(1),
  /** Global default voice the client read from config. The LOWEST precedence
   *  rung — the active personality's `voice.tts_voice` beats it, and a
   *  language-specific entry beats that (`resolveVoicePreferences`). */
  voice: z.string().optional(),
  /** Personality speaking this reply. Without it the server cannot honour a
   *  personality's declared voice and falls back to the global default. */
  personalityId: z.string().optional(),
  /** BCP-47 tag of the reply, selecting from the personality's language map. */
  language: z.string().optional(),
});
const VoiceSynthesizeOutput = z.object({
  audio: z.string(),
  format: z.enum(['opus', 'mp3', 'wav', 'pcm']),
  mimeType: z.string(),
  /** Provider id that ACTUALLY synthesized this audio. Optional so an older
   *  client that never asked for it keeps validating. */
  provider: z.string().optional(),
});

/** @experimental */
const voice = {
  transcribe: oc.input(VoiceTranscribeInput).output(VoiceTranscribeOutput),
  synthesize: oc.input(VoiceSynthesizeInput).output(VoiceSynthesizeOutput),
};

// ---------------------------------------------------------------------------
// A2A peering (admin surface) — thin RPC wrappers over the wiring
// `A2aPeeringService` + the runtime enable/disable control. Rides the same
// cookie/bearer `/rpc` auth as the other management namespaces; NOT the public
// peer-facing `/a2a` surface. Serve-wide `settings` toggle plus per-personality
// identity / peer / skill-exposure reads (plan §6, §13).
// ---------------------------------------------------------------------------

const A2aSettingsGetOutput = z.object({ enabled: z.boolean() });
const A2aSettingsSetInput = z.object({ enabled: z.boolean() });
const A2aSettingsSetOutput = z.object({ enabled: z.boolean() });

const A2aIdentityInput = z.object({ personalityId: z.string().min(1) });

const A2aPeersListInput = z.object({ personalityId: z.string().min(1) });

const A2aPeersPreviewInput = z.object({ url: z.string().min(1) });
// Only what the verify-step UI needs — the fetched fingerprint + peer
// name/description — NOT the whole signed card.
const A2aPeersPreviewOutput = z.object({
  fingerprint: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

const A2aPeersAddInput = z.object({
  personalityId: z.string().min(1),
  url: z.string().min(1),
  /** The out-of-band fingerprint the peer gave you; must match the fetched
   *  card's fingerprint or the add is rejected (verify-first, plan §8). */
  expectedFingerprint: z.string().min(1),
  label: z.string().optional(),
});

const A2aPeersSetEnabledInput = z.object({
  personalityId: z.string().min(1),
  fingerprint: z.string().min(1),
  enabled: z.boolean(),
});

const A2aPeersRemoveInput = z.object({
  personalityId: z.string().min(1),
  fingerprint: z.string().min(1),
});

const A2aOkOutput = z.object({ ok: z.literal(true) });

const A2aSkillsListExposableInput = z.object({ personalityId: z.string().min(1) });
const A2aSkillsListExposableOutput = z.array(z.object({ name: z.string(), exposed: z.boolean() }));

/** @experimental */
const a2a = {
  settings: {
    get: oc.output(A2aSettingsGetOutput),
    set: oc.input(A2aSettingsSetInput).output(A2aSettingsSetOutput),
  },
  identity: oc.input(A2aIdentityInput).output(A2aIdentityViewSchema),
  peers: {
    list: oc.input(A2aPeersListInput).output(z.array(A2aPeerRowSchema)),
    preview: oc.input(A2aPeersPreviewInput).output(A2aPeersPreviewOutput),
    add: oc.input(A2aPeersAddInput).output(A2aPeerRowSchema),
    setEnabled: oc.input(A2aPeersSetEnabledInput).output(A2aOkOutput),
    remove: oc.input(A2aPeersRemoveInput).output(A2aOkOutput),
  },
  skills: {
    listExposable: oc.input(A2aSkillsListExposableInput).output(A2aSkillsListExposableOutput),
  },
};

// ---------------------------------------------------------------------------
// Named secrets — global vault manager for web_search provider keys (Phase 2)
//
// A named secret lives at `providers/<provider>/<name>` in the vault. The raw
// value is written here and NEVER round-tripped back — `list` returns masked
// previews only. A personality stores just the secret NAME (a reference).
// ---------------------------------------------------------------------------

const NamedSecretProviderSchema = z.enum(['exa', 'tavily', 'brave']);
const NamedSecretNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/);

const NamedSecretViewSchema = z.object({
  provider: NamedSecretProviderSchema,
  name: z.string(),
  /** Masked preview (e.g. `sk-…abc1`) — never the raw value. */
  preview: z.string(),
  kind: z.literal('web-search'),
});

/** @experimental */
const namedSecrets = {
  list: oc.output(z.object({ secrets: z.array(NamedSecretViewSchema) })),
  create: oc
    .input(
      z.object({
        provider: NamedSecretProviderSchema,
        name: NamedSecretNameSchema,
        // 8 KiB cap — real API keys are well under 1 KiB; the bound stops a
        // client from filling the vault dir with a giant value.
        value: z.string().min(1).max(8192),
      }),
    )
    .output(z.object({ ok: z.literal(true), preview: z.string() })),
  delete: oc
    .input(z.object({ provider: NamedSecretProviderSchema, name: NamedSecretNameSchema }))
    .output(z.object({ ok: z.literal(true) })),
  testKey: oc
    .input(z.object({ provider: NamedSecretProviderSchema, name: NamedSecretNameSchema }))
    .output(z.object({ ok: z.boolean(), error: z.string().optional() })),
};

// ---------------------------------------------------------------------------
// Tool settings — generic per-personality tool config, driven by each tool's
// `settingsSchema` (Phase 2). `web_search` is the sole consumer in v1.
// ---------------------------------------------------------------------------

const ToolSettingsEnumFieldSchema = z.object({
  kind: z.literal('enum'),
  key: z.string(),
  label: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })),
  default: z.string().optional(),
  required: z.boolean().optional(),
});
const ToolSettingsSecretBindingFieldSchema = z.object({
  kind: z.literal('secret-binding'),
  key: z.string(),
  label: z.string(),
  secretKind: z.string(),
  required: z.boolean().optional(),
});
const ToolSettingsSchemaSchema = z.object({
  fields: z.array(
    z.discriminatedUnion('kind', [
      ToolSettingsEnumFieldSchema,
      ToolSettingsSecretBindingFieldSchema,
    ]),
  ),
});

/** toolName → fieldKey → string value. Only a secret NAME is ever carried for
 *  a secret-binding field — never a value. */
const ToolSettingsValuesSchema = z.record(z.string(), z.record(z.string(), z.string()));
const ToolStorageSchema = z.enum(['personality', 'global']);

/** @experimental */
const toolSettings = {
  schemas: oc.output(
    z.object({
      tools: z.array(z.object({ name: z.string(), settingsSchema: ToolSettingsSchemaSchema })),
    }),
  ),
  getDefault: oc.output(z.object({ values: ToolSettingsValuesSchema })),
  setDefault: oc
    .input(z.object({ values: ToolSettingsValuesSchema }))
    .output(z.object({ ok: z.literal(true) })),
  getForPersonality: oc
    .input(z.object({ personalityId: z.string().min(1) }))
    .output(z.object({ values: ToolSettingsValuesSchema, storage: ToolStorageSchema })),
  setForPersonality: oc
    .input(z.object({ personalityId: z.string().min(1), values: ToolSettingsValuesSchema }))
    .output(z.object({ ok: z.literal(true), storage: ToolStorageSchema })),
};

// ---------------------------------------------------------------------------
// Documents — the operator's view of the files the agent writes
//
// Rooted at the personality's declared `fs_reach.workdir`, NOT its personality
// directory: SOUL.md / config.yaml / mcp.yaml stay off this surface. Every
// `path` is RELATIVE to that root; the service joins and lets `ScopedStorage`
// judge, so a `..` or absolute path is refused rather than interpreted.
//
// Bytes never travel over RPC. Download is a streaming, cookie-authenticated
// `GET /documents/download` — see `apps/web-api/src/routes/documents.ts`.
// ---------------------------------------------------------------------------

const DocumentEntrySchema = z.object({
  name: z.string(),
  /** Path relative to the workdir root — feed it straight back to list/delete. */
  path: z.string(),
  isDir: z.boolean(),
  /** Absent for directories and for entries that could not be stat'd. */
  size: z.number().optional(),
  mtimeMs: z.number().optional(),
  /** Symlinks are LISTED so the operator can see them, but refused on
   *  download and delete — they can point outside the workdir. */
  isSymlink: z.boolean(),
});

/** Omitted `personalityId` means the configured default personality. */
const DocumentsPersonalityInput = z.object({ personalityId: z.string().min(1).optional() });

const DocumentsRootOutput = z.object({ root: z.string(), personalityId: z.string() });

const DocumentsListInput = DocumentsPersonalityInput.extend({
  /** Subdirectory relative to the root. Omitted = the root itself. */
  path: z.string().optional(),
});
const DocumentsListOutput = z.object({ entries: z.array(DocumentEntrySchema) });

const DocumentsDeleteInput = DocumentsPersonalityInput.extend({ path: z.string().min(1) });
const DocumentsDeleteOutput = z.object({ ok: z.literal(true) });

/** @experimental */
const documents = {
  root: oc.input(DocumentsPersonalityInput).output(DocumentsRootOutput),
  list: oc.input(DocumentsListInput).output(DocumentsListOutput),
  delete: oc.input(DocumentsDeleteInput).output(DocumentsDeleteOutput),
};

// ---------------------------------------------------------------------------
// Root contract — every namespace mounted under one symbol
// ---------------------------------------------------------------------------

export const contract = {
  sessions,
  personalities,
  chat,
  tools,
  clarify,
  onboarding,
  config,
  debug,
  cron,
  skills,
  slashCommands,
  evolver,
  mesh,
  memory,
  plugins,
  mcp,
  platforms,
  batch,
  eval: evalNs,
  kanban,
  apiKeys,
  meta,
  models,
  dashboards,
  admin,
  context,
  files,
  goals,
  tasks,
  digest,
  voice,
  a2a,
  namedSecrets,
  toolSettings,
  documents,
};

export type Contract = typeof contract;
