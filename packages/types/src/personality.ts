export interface PersonalityObservabilityConfig {
  storeToolArgs?: 'none' | 'redacted' | 'full';
  storeToolBodies?: 'none' | 'redacted' | 'full';
  storeLlmPayloads?: 'none' | 'metadata' | 'full';
  redactPatterns?: string[];
}

export interface PersonalitySafetyConfig {
  observability?: PersonalityObservabilityConfig;
  /**
   * Opt-in allowlist for skill-declared permissions. When absent, skills that
   * declare sensitive permissions are warned about but still loaded (backward
   * compat). When present, each category is enforced against declared values:
   *   true          — any value for that category is allowed
   *   string[]      — only the listed paths/hosts/vars are allowed; any
   *                   undeclared value causes the skill to be rejected
   *   false/absent  — no value for that category is allowed
   */
  allowed_skill_permissions?: {
    fs_read?: string[] | boolean;
    fs_write?: string[] | boolean;
    network?: string[] | boolean;
    mcp_env_passthrough?: string[] | boolean;
  };
  /**
   * Ch.4b — Approval mode selector.
   *
   *   `manual` (default): every `dangerous` classification surfaces the
   *     approval modal; `safe` auto-fires; `blocked` (the hardline floor)
   *     errors out. Use for interactive pairing.
   *   `smart`:  an auxiliary fast-model call reviews each `dangerous`
   *     classification and either auto-approves, auto-denies, or escalates
   *     to manual. Trades latency + $ for reduced approval fatigue.
   *   `off`:    `dangerous` classifications auto-fire without prompt; the
   *     hardline floor (Ch.4a) STILL applies. Invalid combination with any
   *     channel ingress — config rejected at load time when `off` is paired
   *     with telegram/discord/slack/email/whatsapp/etc bindings.
   */
  approvalMode?: 'manual' | 'smart' | 'off';
  /**
   * User-defined deny rules — the floor beneath `approvalMode`.
   *
   * Each entry is a case-sensitive substring matched against
   * `` `${toolName} ${canonical-json-args}` ``, so a rule like
   * `git push --force` matches a `terminal` call whose `command` argument
   * contains that text. A match denies the call outright.
   *
   * **The law:** deny rules are evaluated BEFORE the approval-mode dispatch.
   * Modes can only make things stricter, never looser — a deny rule binds even
   * under `approvalMode: 'off'` with the auto-approve capability flag set.
   */
  denyRules?: string[];
  /**
   * Ch.7 — Per-personality network reach. Layered with the always-deny
   * cloud-metadata + private-network floor (non-overridable) and the
   * scheme allowlist (http/https only). Empty/absent = open public
   * internet (subject to floor); non-empty `allow` = allowlist mode.
   */
  network?: {
    allow?: string[];
    deny?: string[];
    /** Opt-in for RFC1918 / loopback / link-local. Cloud-metadata still
     *  blocked even when this is true (Ch.7b is non-overridable). */
    allow_private_urls?: boolean;
  };
  /**
   * Ch.3 — Prompt-injection runtime defenses. All sub-blocks default to safe
   * values when absent, so a personality with no `injectionDefense` block
   * still gets provenance wrapping on `outputIsUntrusted` tools and a 2-turn
   * post-read downgrade for the default dangerous-tool list.
   *
   * There is deliberately no master switch. ARCHITECTURE.md §V S6 makes the
   * inbound safety pipeline non-opt-out-able by personality, channel, or
   * tool; these knobs may only narrow behaviour within it, never remove it.
   */
  injectionDefense?: {
    /** Tier-2 LLM classifier policy. Tier-1 regex always runs. */
    classifier?: {
      /**
       * Force the LLM classifier to fire on every `outputIsUntrusted` result
       * regardless of length / pattern hits. Default false — Tier-2 only fires
       * when Tier-1 hits OR content > 500 chars.
       */
      alwaysCallLLM?: boolean;
    };
    /** Ch.3d — block dangerous tools for N turns after an untrusted read. */
    postReadDowngrade?: {
      /** Default true. */
      enabled?: boolean;
      /** Iterations the downgrade stays active. Default 2. */
      turns?: number;
      /**
       * Tools to downgrade. `'auto'` uses a built-in dangerous-tool list
       * (terminal, run_code, write_file, patch_file, web_extract, browse_url).
       * Explicit list overrides. Default `'auto'`.
       */
      tools?: string[] | 'auto';
    };
    /** Redact tool results that contain detected secrets. Default true (block); set false to emit only. */
    blockSecretResults?: boolean;
    /** Wrap tool results in ===TOOL_RESULT_START/<END>=== sentinels. Default true. */
    toolResultDelimiters?: boolean;
  };
  /** PII redaction applied to user messages before they enter LLM context. Opt-in. */
  piiRedaction?: {
    enabled: boolean;
    extraPatterns?: string[];
  };
}

export type ModelTierName = 'trivial' | 'default' | 'deep' | 'dreaming';

export interface PersonalityMemoryConfig {
  provider: string;
  options?: Record<string, unknown>;
}

export interface PersonalityMcpExportConfig {
  enabled: boolean;
  expose_tools?: 'all' | 'none' | string[];
  expose_memory?: 'scoped' | 'none' | 'full';
  expose_sessions?: boolean;
  auth?: 'localhost' | 'bearer';
}

export interface OutboundPolicyConfig {
  approve_before_send: boolean;
  channels?: string[];
  approver_personality?: string;
}

/**
 * How a personality SOUNDS. The sanctioned exception to the "no voice/speech
 * fields on PersonalityConfig" rule (voice V1a, eng-review D2): a deployment
 * chooses the voice PROVIDER, the personality chooses its own voice, the same
 * way it chooses its own model. Everything that is a deployment or per-channel
 * concern stays out — voice modes, VAD tuning, per-adapter affordances, and
 * wake routes all remain gateway/config-owned.
 *
 * Absent = inherit the global `auxiliary.asr.*` / `auxiliary.tts.*` defaults.
 */
export interface PersonalityVoiceConfig {
  /**
   * Name of an entry in the deployment's TTS roster
   * (`voice.tts.providers.<name>.*` in `~/.ethos/config.yaml`). A LABEL the
   * operator chose, never a provider id — the egress gate keys on the entry's
   * underlying `provider`, so naming an entry `local-kokoro` buys nothing.
   *
   * Absent, or naming an entry this machine does not have, falls back to the
   * default `auxiliary.tts` entry: a personality shared between machines must
   * still speak on one that lacks its preferred provider.
   *
   * `voice.provider` is still ACCEPTED on read as the older spelling of this
   * key; the loader maps it here and re-serializes the new one, so a config
   * never carries both.
   */
  tts_provider?: string;
  /**
   * Name of an entry in the deployment's STT roster
   * (`voice.stt.providers.<name>.*`). The exact mirror of `tts_provider`, down
   * to the fallback: unknown here → the default `auxiliary.asr` entry.
   *
   * A personality's VOICE is identity; its EAR is a technical override — a
   * Spanish-tuned or local-only personality transcribing through a different
   * engine than the deployment default.
   */
  stt_provider?: string;
  /**
   * Name of an entry in the deployment's REALTIME roster
   * (`voice.realtime.providers.<name>.*`). The speech-to-speech sibling of
   * `tts_provider` / `stt_provider`, under the same rules: a LABEL the operator
   * chose, never a provider id, and a name this machine lacks falls back to
   * `voice.realtime.default` rather than failing the load.
   *
   * Only consulted when a turn runs on the realtime tier; on the pipeline tier
   * `tts_provider` / `stt_provider` are what speak and listen.
   */
  realtime_provider?: string;
  /** TTS voice id, provider-specific (e.g. `af_bella` for Kokoro, `alloy` for OpenAI). */
  tts_voice?: string;
  /**
   * BCP-47 tag → TTS voice id. Wins over `tts_voice` when the turn's language
   * is known: a personality that declares a Spanish voice means it in Spanish.
   */
  languages?: Record<string, string>;
  /**
   * Preferred voice tier. `pipeline` = STT → LLM → TTS (V1a); `realtime` =
   * hosted speech-to-speech (V1b). A preference, not a guarantee — a
   * deployment with no realtime provider serves `pipeline` either way.
   */
  tier?: 'pipeline' | 'realtime';
  /**
   * Fast-lane model for spoken turns. Conversational latency and agentic depth
   * want different models; this is how a personality says which one talks.
   */
  model?: string;
}

export interface DreamingConfig {
  enable: boolean;
  idleMinutes: number;
  maxPerDay: number;
  prompt?: string;
}

export interface ModelTierConfig {
  trivial?: string;
  default?: string;
  deep?: string;
  dreaming?: string;
}

/**
 * Resolve model display string from a PersonalityConfig.model value.
 * Centralizes the typeof check so consumers don't scatter it.
 */
export function resolveModelDisplay(
  model: string | ModelTierConfig | undefined,
  fallback = '(engine default)',
): string {
  if (!model) return fallback;
  if (typeof model === 'string') return model;
  return model.default ?? fallback;
}

export interface LearningLogEntry {
  revisionId: string; // monotonic, e.g. "expr-rev-7"
  at: string; // ISO timestamp
  summary: string; // short human description of the change
  evidenceRef: string; // pointer to the evidence that justified the change
  prevExpressionRef: string; // id of the prior-Expression snapshot, enables one-click revert
}

export interface LivingSoul {
  core: string; // raw Core section — NEVER written by the evolution loop
  expression: string; // raw Expression section — the only auto-editable region
  learningLog: LearningLogEntry[];
}

// Phase 30.8 — this schema is FROZEN.
//
// Adding a top-level field to `PersonalityConfig` requires:
//   1. A CHANGELOG entry justifying why it isn't a skill, a tool, or a memory section.
//   2. The `personality-schema-change` label on the PR.
//   3. Two-maintainer approval (enforced via branch protection).
//   4. Bumping the count in `.personality-field-count` at the repo root.
//
// The mechanical CI gate lives in
// `packages/types/src/__tests__/personality-field-count.test.ts`. It parses
// this interface at test time and fails if the count drifts from
// `.personality-field-count`. Culture sets the rule; CI enforces it.
//
// Common rejections — these belong in skills or per-channel adapter config,
// NOT here:
//   - voice MODES, VAD tuning, per-channel voice affordances (the `voice`
//     field below is identity — which voice this personality speaks in — and
//     is the one sanctioned exception, granted by the voice V1a amendment;
//     it is not a licence for further speech/audio settings)
//   - emotion / mood / sentiment tags
//   - label or response templates
//   - per-channel UI affordances
export interface PersonalityConfig {
  /** @internal Personality directory name; populated by the loader, not user-set. */
  id: string;
  name: string;
  description?: string;
  /** @internal Absolute path to SOUL.md; populated by the loader. */
  soulFile?: string;
  /** @internal Absolute paths to skills directories; populated by the loader. */
  skillsDirs?: string[];
  toolset?: string[];
  capabilities?: string[];
  model?: string | ModelTierConfig;
  provider?: string;
  platform?: string;
  /**
   * Per-personality streaming watchdog: if no chunk arrives from the LLM within
   * this many milliseconds, the agent aborts the stream and emits an error.
   * Reset on every chunk, so slow-but-progressing streams are unaffected.
   * Defaults to AgentLoop's `streamingTimeoutMs` (120000ms / 2 minutes).
   * Thinking-mode personalities (e.g. Opus extended thinking) may need longer;
   * fast-turnaround personalities (Haiku) can pick something tighter.
   * See plan/IMPROVEMENT.md P1-2 / OpenClaw #68596.
   */
  streamingTimeoutMs?: number;
  /**
   * Per-personality filesystem reach. When set, the read_file / write_file
   * tools route through a ScopedStorage that rejects paths outside these
   * absolute-prefix lists. Closes the personality_isolation Tier 1 #1 gap
   * — a researcher's read_file cannot peek at engineer's MEMORY.md.
   *
   * Substitutions resolved by AgentLoop at construction time:
   *   ${ETHOS_HOME} → ~/.ethos
   *   ${self}       → this personality's id
   *   ${CWD}        → AgentLoop.workingDir
   *
   * When unset, AgentLoop falls back to a default scope:
   *   read:  [~/.ethos/personalities/<self>/, ~/.ethos/skills/, ${CWD}]
   *   write: [~/.ethos/personalities/<self>/, ${CWD}]
   *
   * `workdir` is this personality's working directory — where its relative
   * file paths land. It takes the same substitutions, must resolve absolute,
   * and BECOMES the `${CWD}` that the read/write entries substitute against.
   * A declared workdir is always reachable: it is added to both derived
   * lists, because a declared `write` REPLACES the defaults and would
   * otherwise leave the workdir unwritable. When `workdir` is unset the
   * working directory is the process cwd and read/write derive exactly as
   * before.
   *
   * Counts as ONE field for the schema-freeze gate (the nested shape is
   * a leaf type).
   */
  fs_reach?: { read?: string[]; write?: string[]; workdir?: string };
  /**
   * MCP servers this personality can reach. Server configs stay global in
   * ~/.ethos/mcp.json; this is a per-role allowlist keyed by server name.
   * Missing/empty = no MCP access for this personality (explicit opt-in).
   */
  mcp_servers?: string[];
  /**
   * Plugins attached to this personality. Default-deny: a plugin not listed
   * here is dormant for this personality — its tools, hooks, and injectors
   * do not fire. Missing/empty = no plugins active. Explicit opt-in only.
   */
  plugins?: string[];
  /**
   * Filter rules for skills from the universal scanner's global pool.
   * Per-personality skills/ folder is always loaded unfiltered.
   * When absent, defaults to `capability` mode (skills whose required_tools
   * are a subset of this personality's effective tool reach are included).
   */
  skills?: import('./skill').SkillIngestConfig;
  /**
   * Per-session spending cap in USD. When the running cost for the current
   * session key crosses this value, the next turn is refused with a typed
   * `BUDGET_EXCEEDED` error. Session-scoped only in v1 (resets on `/new`).
   * Absent = no cap (default behavior).
   */
  budgetCapUsd?: number;
  /**
   * Per-personality safety config. Currently carries `observability` sub-block
   * that controls what gets persisted in observability.db for this personality.
   */
  safety?: PersonalitySafetyConfig;
  /**
   * E4 — Name of the context-compaction engine to use when the conversation
   * approaches the model's context window. Resolved against the
   * `ContextEngineRegistry`; if the name is unknown, AgentLoop falls back to
   * the built-in `drop_oldest`. Counts as ONE field.
   */
  context_engine?: string;
  /**
   * E4 — Free-form per-engine options. Passed to the engine via
   * `personality.context_engine_options` so engines can read their own
   * configuration without inventing a new wiring channel. Counts as ONE field.
   */
  context_engine_options?: Record<string, unknown>;
  /**
   * E3 — Auto-triggered skill evolution. When `enabled: true`, the
   * skill-evolver auto-trigger queues an analysis after every turn that
   * crosses the `min_tool_calls` threshold and is outside the cooldown
   * window. Default: disabled (opt-in per personality). Counts as ONE
   * field for the schema-freeze gate (the nested shape is a leaf type).
   */
  skill_evolution?: {
    enabled?: boolean;
    min_tool_calls?: number;
    cooldown_minutes?: number;
    model?: string;
    /**
     * Improve existing skills during eval-driven evolution (the rewrite
     * branch). Distinct from `enabled`, which gates new-skill creation.
     * Unset = follows `enabled`. Inert on the nightly create-only path.
     */
    evolve_existing?: boolean;
    /**
     * Promotion gate for a drafted skill. `'review'` queues it for human
     * approval; `'auto'` promotes it automatically after validation. Unset =
     * fall back to the `evolution_approval_mode`-based gate.
     */
    promotion?: 'review' | 'auto';
    /**
     * Where a promoted skill is written. `'shared'` (default) = the global
     * skills dir; `'personality'` = the per-personality skills dir.
     */
    scope?: 'personality' | 'shared';
  };
  /**
   * E5 — Workspace-aware context layering. Controls how the file-context
   * injector discovers `AGENTS.md` / `CLAUDE.md` files as the agent
   * navigates the workspace.
   *
   *   `static` (default): load context once at session start from `workingDir`.
   *   `progressive`: also discover sub-AGENTS.md as the agent reads/writes
   *      files; injected on the next turn.
   *   `off`: skip context-file injection entirely.
   *
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type — same precedent as `fs_reach`).
   */
  context_layering?: {
    mode?: 'static' | 'progressive' | 'off';
    max_depth?: number;
    discovery_files?: string[];
    cap_total_chars?: number;
  };
  /**
   * Per-personality memory backend. When set, the personality uses a specific
   * memory provider instead of the global default. The `provider` value must
   * match a registered provider name (built-in: 'markdown', 'vector'; plugins
   * can register additional ones). `options` is passed to the provider factory.
   * Counts as ONE field for the schema-freeze gate.
   */
  memory?: PersonalityMemoryConfig;
  /**
   * Per-personality MCP server export. Declares what slice of the personality
   * is visible to external MCP clients. When `enabled: true`, the personality
   * can be served via `ethos mcp-server --personality <id>`.
   * Counts as ONE field for the schema-freeze gate.
   */
  mcp_export?: PersonalityMcpExportConfig;
  /**
   * Per-personality outbound approval policy. Declared but NOT yet enforced:
   * the block is parsed, persisted and round-tripped, and has no runtime
   * effect. Setting `approve_before_send: true` does NOT gate channel egress
   * today — no pending queue exists and outbound messages send as usual.
   * Treat it as inert until a release wires it into the gateway.
   * Counts as ONE field for the schema-freeze gate.
   */
  outbound_policy?: OutboundPolicyConfig;
  /**
   * Idle-time dreaming. When enabled, the gateway triggers a background
   * maintenance turn after `idleMinutes` of silence, up to `maxPerDay`
   * per rolling 24-hour window. Counts as ONE field for the schema-freeze gate.
   */
  dreaming?: DreamingConfig;
  /**
   * Phase 3a — Governance dial for Expression self-evolution, distinct from
   * `safety.approvalMode` (which gates tool calls, not evolution). Do NOT
   * overload safety.approvalMode.
   *   `user` (default when absent): every Expression change is drafted and
   *     applied only on explicit user approval.
   *   `auto`: reserved for phase-3b (requires the Personality Judge); inert
   *     for now — treat the same as `user` until 3b wires it.
   * Counts as ONE field for the schema-freeze gate.
   */
  evolution_approval_mode?: 'auto' | 'user';
  /**
   * Phase 3 (P5) — Gates the nightly governed-learning pass and its Personality
   * Judge. Every field defaults to today's behavior when absent, so an existing
   * personality with no `nightly` block runs the full pass (judge + expression)
   * exactly as before.
   *   `enabled`               — master nightly toggle. Default true: the pass
   *                             runs for this personality.
   *   `judge.enabled`         — run the Personality Judge step. Default true.
   *                             When false, the judge step records `skipped`
   *                             and no verdict is produced (expression short-
   *                             circuits, as it does on insufficient data).
   *   `judge.minInteractions` — activation threshold for the judge. Default 20
   *                             (= DEFAULT_ACTIVATION.minInteractions).
   *   `expression`            — run the expression-evolution step. Default true.
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type — same precedent as `fs_reach`).
   */
  nightly?: {
    enabled?: boolean;
    judge?: { enabled?: boolean; minInteractions?: number };
    expression?: boolean;
  };
  /**
   * Voice V1a — how this personality SOUNDS: TTS voice id, language→voice map,
   * tier preference, fast-lane model. See {@link PersonalityVoiceConfig} for
   * why this is identity rather than a deployment setting, and what stays out.
   * Absent = inherit the global `auxiliary.tts.*` config.
   * Counts as ONE field for the schema-freeze gate (the nested shape is a
   * leaf type — same precedent as `fs_reach`).
   */
  voice?: PersonalityVoiceConfig;
}

/**
 * Patch shape consumed by `PersonalityRegistry.update`. Narrow on purpose —
 * the SDK install flow only ever needs to mutate the `mcp_servers` list,
 * and consumers in the type layer should not be aware of the broader edit
 * shape that the file-backed registry supports (name, SOUL.md, toolset).
 * Concrete implementations may accept a wider patch via their own type.
 */
export interface PersonalityRegistryPatch {
  mcp_servers?: string[];
  plugins?: string[];
}

export interface PersonalityRegistry {
  define(config: PersonalityConfig): void;
  get(id: string): PersonalityConfig | undefined;
  list(): PersonalityConfig[];
  getDefault(): PersonalityConfig;
  setDefault(id: string): void;
  loadFromDirectory(dir: string): Promise<void>;
  /**
   * Remove a personality from the in-memory registry. Used by surfaces
   * that delete the on-disk directory (e.g. the web Personalities tab) —
   * `loadFromDirectory` only adds; a separate primitive is needed to
   * forget. Callers must also clear any associated FS state; this method
   * only mutates the registry's own map. No-op if the id is unknown.
   */
  remove(id: string): void;
  /**
   * Apply a patch to a personality. Optional in the interface because not
   * every backend (e.g. read-only built-in registries used in tests) supports
   * mutation; the SDK install flow checks for presence before calling. The
   * file-backed registry implements this with the broader patch shape it
   * accepts internally, then narrows to the interface here. Return shape
   * intentionally minimal — surfaces that need the full updated record call
   * the concrete method directly.
   */
  update?(id: string, patch: PersonalityRegistryPatch): Promise<unknown>;
}
