import type {
  AgentEvent,
  AgentSafety,
  ContextEngineLLMHandle,
  ContextEngineRegistry,
  ContextInjector,
  DryRunToolPlan,
  HookRegistry,
  LLMProvider,
  Logger,
  MemoryProvider,
  PersonalityRegistry,
  RequestDumpStore,
  SessionStore,
  SteerSink,
  Storage,
  ToolRegistry,
  VoiceTurnOrigin,
} from '@ethosagent/types';
import { createApprovalPostureGuard } from './agent-loop/approval-posture';
import { checkTurnBudgets, updateDenialStreak } from './agent-loop/budgets';
import { compactSession, type ManualCompactionResult } from './agent-loop/manual-compact';
import { applyOverflowRetry } from './agent-loop/overflow';
import { applySamplingDefaults, type ModelSamplingDefaults } from './agent-loop/sampling';
import { assembleContext } from './agent-loop/stages/context-assembly';
import {
  createTurnBudgetCounters,
  recordToolCallForBudgets,
} from './agent-loop/stages/per-call-enforcement';
import { ScriptToolBridge } from './agent-loop/stages/script-tool-bridge';
import type { StreamStepDeps } from './agent-loop/stages/stream-step';
import { streamStep } from './agent-loop/stages/stream-step';
import { processTools } from './agent-loop/stages/tool-processing';
import { createTurnUsage, finalizeTurn, flushTurnUsage } from './agent-loop/stages/turn-finalizer';
import { setupTurn } from './agent-loop/stages/turn-setup';
import type { LoopDeps } from './agent-loop/turn-context';
import { buildTurnEndCtx, maybeConsolidateAtTurnEnd } from './agent-loop/turn-end';
import { createWatcherTap } from './agent-loop/watcher-tap';
import type { ClarifyBridge } from './clarify/clarify-bridge';
import { DefaultContextEngineRegistry } from './context-engines/registry';
import { ContextStore } from './context-store';
import { InMemorySessionStore } from './defaults/in-memory-session';
import { NoopMemoryProvider } from './defaults/noop-memory';
import { DefaultPersonalityRegistry } from './defaults/noop-personality';
import { DefaultHookRegistry } from './hook-registry';
import type { AgentLoopObservability } from './observability/agent-loop-observability';
import { DefaultToolRegistry } from './tool-registry';

// AgentEvent lives in @ethosagent/types (Phase 1). Core re-exports for
// backwards compatibility — all existing consumers import from here.
export {
  type AgentEvent,
  type DryRunToolPlan,
  isKnownAgentEvent,
  KNOWN_AGENT_EVENT_TYPES,
  type KnownAgentEventType,
  type ToolProgressAudience,
} from '@ethosagent/types';
export { checkMcpEnabled, checkMcpRejectArgs } from './agent-loop/mcp-policy';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  llm: LLMProvider;
  tools?: ToolRegistry;
  personalities?: PersonalityRegistry;
  memory?: MemoryProvider;
  /**
   * Phase 3 — team id. When set, AgentLoop stamps `teamId` on every
   * `ToolContext` so team memory tools can route to the correct team scope.
   * Absent when running solo.
   */
  teamId?: string;
  session?: SessionStore;
  hooks?: HookRegistry;
  injectors?: ContextInjector[];
  /**
   * Maps each plugin-registered injector to its plugin id so AgentLoop can
   * gate injectors by personality. Built-in injectors are absent (always fire).
   * Populated by PluginApiImpl.registerInjector(); passed through from wiring.
   */
  injectorPluginIds?: Map<ContextInjector, string>;
  /**
   * Base Storage instance handed to tools via `ToolContext.storage` after
   * being decorated with a ScopedStorage that enforces the active
   * personality's `fs_reach` allowlist. When unset, ToolContext.storage is
   * left undefined and tools fall back to unrestricted node:fs (legacy
   * behavior — existing CLI/TUI tests don't need a storage instance).
   */
  storage?: Storage;
  /** Optional attachment cache for text-file inlining at context assembly. */
  attachmentCache?: import('@ethosagent/types').AttachmentCache;
  /**
   * Absolute path to ~/.ethos/ used for `${ETHOS_HOME}` substitution in
   * `fs_reach` paths. Defaults to `${HOME}/.ethos`. Required only when
   * `storage` is set.
   */
  dataDir?: string;
  /**
   * Optional observability adapter. When provided, AgentLoop records traces,
   * spans, and events for LLM calls, tool calls, and errors via typed
   * domain helpers. When absent, behaviour is identical to before — no
   * observability writes occur.
   */
  observability?: AgentLoopObservability;
  // Maps personality ID → model ID. Resolution: modelRouting[id] → personality.model → llm.model
  modelRouting?: Record<string, string>;
  modelSampling?: ModelSamplingDefaults; // §7 — applied when the per-call value is unset
  // biome-ignore format: §5 gate + Phase 3 turn-end/overflow/engine + Lane 1a knobs; one line keeps agent-loop.ts under the size guardrail.
  compaction?: { pressure?: number; target?: number; charsPerToken?: number; gateDelta?: number; autoCompact?: boolean; retryOnOverflow?: boolean; defaultEngine?: string; maxContextTokens?: number; minTailUserMessages?: number; maxSingleToolResultTokens?: number };
  // biome-ignore format: Phase 3 silent memory-flush knobs (docs on LoopDeps.memoryConsolidation); one line keeps agent-loop.ts under the size guardrail.
  memoryConsolidation?: { enabled?: boolean; flushThreshold?: number; timeboxMs?: number; maxTokens?: number; maxDeltaChars?: number; minMessagesSinceFlush?: number };
  // biome-ignore format: §2/Phase 4 prompt-economy knobs (docs on LoopDeps.promptBudget); one line keeps agent-loop.ts under the size guardrail.
  promptBudget?: { compactPrelude?: boolean; memorySnapshotCap?: number; suppressMemoryGuidance?: boolean; memoryIndexMode?: boolean; skillsIndexMode?: boolean };
  /**
   * Per-personality memory provider registry. Maps provider names ('markdown',
   * 'vector', plugin-registered names) to factory functions. When a personality
   * declares `memory.provider`, AgentLoop resolves from this map.
   */
  memoryProviders?: Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >;
  /**
   * E4 — Pluggable context-engine registry. When unset, AgentLoop builds
   * a `DefaultContextEngineRegistry` (drop_oldest + semantic_summary
   * placeholder + reference_preserving). Each personality picks an engine
   * via `personality.context_engine`; unknown names fall back to
   * `drop_oldest` with a one-line warning.
   */
  contextEngines?: ContextEngineRegistry;
  /**
   * Context-engine LLM handle. When set, context engines receive it as
   * `opts.llm` on every `compact()` call — preferred over the summarizer
   * injected at engine construction time.
   */
  llmHandle?: ContextEngineLLMHandle;
  /**
   * Bridge for the `clarify` tool — the agent asks the user a structured
   * question mid-turn and waits. Optional: when unset, the `clarify` tool
   * reports `CLARIFY_NO_SURFACE` and the agent falls back to plain prose.
   */
  clarifyBridge?: ClarifyBridge;
  /**
   * Per-personality MCP tool policy loaded from mcp.yaml. NOT part of
   * PersonalityConfig (frozen schema). Passed through from wiring so
   * AgentLoop can build per-tool MCP allowlists in filterOpts.
   */
  mcpPolicy?: import('@ethosagent/types').McpPolicy;
  /** Optional document extractor registry for extracting text from uploaded files. */
  documentExtractors?: import('@ethosagent/types').DocumentExtractorRegistry;
  /**
   * Optional request dump store. When provided, AgentLoop appends a full
   * record of each LLM request/response for offline analysis and debugging.
   */
  requestDumpStore?: RequestDumpStore;
  /** v2.2 — Callback to emit tool invocation metrics to the diagnostic store.
   *  Wiring provides this; core never imports DiagnosticStore directly. */
  onToolMetric?: (opts: {
    pluginId: string;
    toolName: string;
    ok: boolean;
    durationMs: number;
    sessionId: string;
    turnId: string;
  }) => void;
  /** v2.2 — Pre-turn credential check. Returns the first missing credential,
   *  or null if all required credentials are present. Opt-in: when undefined,
   *  the check is skipped. Wiring provides this when plugins declare required
   *  credentials. */
  credentialCheck?: (
    sessionKey: string,
    pendingUserMessage: string,
  ) => Promise<{
    pluginId: string;
    credentialKey: string;
    kind: 'oauth' | 'api_key' | 'text';
    label: string;
    description?: string;
    authUrl?: string;
  } | null>;
  /** Injected safety bundle — injection defense, redaction, and scoped storage. */
  safety: AgentSafety;
  /** Library output sink (Law 10). Carries the once-per-loop `ungated`
   *  approval-posture notice; omitted → the framework stays silent. */
  logger?: Logger;
  options?: {
    maxIterations?: number;
    historyLimit?: number;
    platform?: string;
    workingDir?: string;
    resultBudgetChars?: number;
    /**
     * Hard cap on total tool calls per user turn (across all LLM iterations).
     * Defaults to 100. Trips a `tool_progress` warning and exits cleanly.
     * See plan/IMPROVEMENT.md P1-3.
     */
    maxToolCallsPerTurn?: number;
    /**
     * Hard cap on the number of times the same tool name can be invoked in a
     * single turn. Catches the "infinite loop on a single tool" failure mode
     * (e.g. tts loop reported as OpenClaw #67744). Defaults to 25.
     */
    maxIdenticalToolCalls?: number;
    /**
     * True loop detection: hard cap on *consecutive* tool calls with the same
     * name AND identical arguments (JSON-stringified), uninterrupted by any
     * different call. Tighter than `maxIdenticalToolCalls` (a frequency cap)
     * because it only trips on the actual loop shape. Defaults to 5.
     */
    maxConsecutiveIdenticalCalls?: number;
    /**
     * Default streaming watchdog in milliseconds. If no chunk arrives from the
     * LLM within this window, the agent aborts the stream and emits an error.
     * Reset on every chunk. Personalities can override via
     * `personality.streamingTimeoutMs`. Defaults to 600000 (10 minutes).
     */
    streamingTimeoutMs?: number;
    /** Lane 3(b)/D20 — small-window mode (wiring-resolved); enables the turn personality's declared `small_window_toolset` narrowing. */
    smallWindow?: boolean;
  };
}

export interface RunOptions {
  sessionKey?: string;
  personalityId?: string;
  abortSignal?: AbortSignal;
  /** Sampling temperature forwarded to the LLM provider. */
  temperature?: number;
  /** Top-P (nucleus sampling) forwarded to the LLM provider. */
  topP?: number;
  /** Maps to CompletionOptions.maxTokens — separate name to avoid collision with AgentLoop's own maxTokens semantics. */
  maxCompletionTokens?: number;
  /** RNG seed forwarded to providers that support it (e.g. OpenAI-compat). */
  seed?: number;
  /**
   * Identifier surfaced to tools as `ToolContext.agentId`. Delegation tools
   * use this to thread spawn depth (`depth:N`) into child loops so
   * `MAX_SPAWN_DEPTH` can be enforced across recursive sub-agent calls.
   */
  agentId?: string;
  /** Root session key for background-job containment; threaded to ToolContext.rootSessionKey. */
  rootSessionKey?: string;
  /** Origin of this run (`platform:chatId` for channel turns). Threaded to `ToolContext.origin`. Generic — not goal-specific. */
  origin?: string;
  a2aDelegation?: { traceId: string; depth: number; reserveOutbound: () => boolean }; // A2A runner sets this servicing an inbound task → `ToolContext.a2aDelegation` (plan §P8).
  /**
   * FW-9 — `steer` busy-input mode. Surfaces (CLI REPL) push user-typed text
   * here while the agent is mid-turn. AgentLoop drains the sink at the
   * iteration seam (after tool_results land, before the next LLM call) and
   * folds each entry in as a `[USER STEER]: <text>` text block on the user
   * message carrying the tool_results.
   *
   * Pre-first-iteration (no tool_results yet) and idle (no run in flight)
   * steering falls back to `queue` at the surface, never reaching AgentLoop.
   */
  steerSink?: SteerSink;
  /** Per-turn inbound attachments from the user message. Persisted as an
   *  `<attachments>` annotation prepended to the user text. Threaded to the
   *  capability resolver via `ToolRegistry.setTurnAttachments()`. */
  attachments?: import('@ethosagent/types').Attachment[];
  /**
   * Override model tier for this run only (from /tier command).
   * Consumed once; does not persist across runs.
   */
  tierOverride?: import('@ethosagent/types').ModelTierName;
  /** Opaque user id (from IdentityMap). When present, USER.md is read from `user:<userId>` scope. */
  userId?: string;
  dryRun?: boolean;
  dryRunMaxToolCalls?: number;
  /**
   * Override the personality's toolset for this run. Used by cron to exclude
   * the `cron` tool from cron-spawned sessions (recursion guard).
   */
  toolsetOverride?: string[];
  /**
   * Narrow (intersect) the personality toolset for this run — a command's
   * declared `allowedTools` can never escalate beyond the personality allowlist.
   */
  toolsetNarrow?: string[];
  /**
   * Surface-level exclusion — tool names that must neither appear in the tool
   * definitions nor execute. Independent of `toolsetNarrow`: narrow intersects
   * the personality toolset, exclude subtracts unconditionally and defeats
   * `alwaysInclude`. Set by the surface, never by the personality.
   */
  toolsetExclude?: string[];
  /** Override the per-turn tool-call cap for this run only (goal runs raise it; default applies when absent). */
  maxToolCallsPerTurn?: number;
  /** Override the per-tool-name repeat cap for this run only (goal runs raise it; default applies when absent). */
  maxIdenticalToolCalls?: number;
  /** When true, bypass safety-watcher halts for this run (opt-in, dangerous; caps still apply). */
  allowDangerousToolCalls?: boolean;
  /** Set when this turn's text is a transcript of speech (voice V1a, D16).
   *  Effects are message-level only — the system prompt is untouched, so
   *  `prompt-prefix-stability` holds for a session mixing typed and spoken
   *  turns. See `./voice-origin` (the annotation, rendered alongside the
   *  `<attachments>` audio marker) and `withSpokenConfirmation` in
   *  `@ethosagent/wiring` (the gate it reaches via `before_tool_call`). */
  voiceOrigin?: VoiceTurnOrigin;
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private readonly llm: LLMProvider;
  private readonly tools: ToolRegistry;
  private readonly personalities: PersonalityRegistry;
  private readonly memory: MemoryProvider;
  private readonly session: SessionStore;
  /** Public so surfaces (web, ACP) can register late-binding hooks they own
   *  without re-running the whole wiring factory. The CLI/TUI register hooks
   *  before construction; web registers an approval hook after createAgentLoop
   *  returns. */
  readonly hooks: HookRegistry;
  private readonly injectors: ContextInjector[];
  private readonly injectorPluginIds: Map<ContextInjector, string>;
  private readonly maxIterations: number;
  private readonly historyLimit: number;
  private readonly platform: string;
  private readonly workingDir: string;
  private readonly resultBudgetChars: number;
  private readonly maxToolCallsPerTurn: number;
  private readonly maxIdenticalToolCalls: number;
  private readonly maxConsecutiveIdenticalCalls: number;
  private readonly streamingTimeoutMs: number;
  private readonly smallWindow: boolean;
  private readonly modelRouting: Record<string, string>;
  private readonly modelSampling?: AgentLoopConfig['modelSampling'];
  private readonly compaction?: AgentLoopConfig['compaction'];
  private readonly memoryConsolidation?: AgentLoopConfig['memoryConsolidation'];
  private readonly promptBudget?: AgentLoopConfig['promptBudget'];
  private readonly memoryProviders: Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >;
  private readonly storage?: Storage;
  private readonly attachmentCache?: import('@ethosagent/types').AttachmentCache;
  private readonly dataDir?: string;
  private readonly observability?: AgentLoopObservability;
  private readonly contextEngines: ContextEngineRegistry;
  /** Bridge for the `clarify` tool; undefined when no interactive surface is wired. */
  readonly clarifyBridge?: ClarifyBridge;
  /** Optional request dump store for full LLM request/response recording. */
  private readonly requestDumpStore?: import('@ethosagent/types').RequestDumpStore;
  /** Phase 3 — team id stamped onto ToolContext when loop runs inside a team. */
  private readonly teamId?: string;
  /** Context-engine LLM handle — preferred over engine-constructor injection. */
  private readonly llmHandle?: ContextEngineLLMHandle;
  /** Per-personality MCP tool policy from mcp.yaml (NOT on PersonalityConfig). */
  private readonly mcpPolicy?: import('@ethosagent/types').McpPolicy;
  private readonly documentExtractors?: import('@ethosagent/types').DocumentExtractorRegistry;
  /** v2.2 — Callback to emit per-tool invocation metrics to the diagnostic store. */
  private readonly onToolMetric?: AgentLoopConfig['onToolMetric'];
  /** v2.2 — Pre-turn credential check callback. */
  private readonly credentialCheck?: AgentLoopConfig['credentialCheck'];
  private readonly safety: AgentSafety;
  /** G4 — see `agent-loop/approval-posture.ts`. Latches after its first run. */
  private readonly checkApprovalPosture: () => void;
  /** Per-session accumulated spend in USD. Keyed by sessionKey. Reset via resetSessionCost(). */
  private readonly sessionCosts = new Map<string, number>();
  /** FW-28 — per-session mtime registry. Keyed by sessionKey → (absPath → record). */
  private readonly sessionReadMtimes = new Map<
    string,
    Map<string, { mtimeMs: number; readAtTurn: number }>
  >();
  /** v2: per-run key/value store threaded into ToolContext for plugin communication. */
  private readonly contextStore = new ContextStore();

  constructor(config: AgentLoopConfig) {
    this.llm = config.llm;
    this.tools = config.tools ?? new DefaultToolRegistry();
    this.personalities = config.personalities ?? new DefaultPersonalityRegistry();
    this.memory = config.memory ?? new NoopMemoryProvider();
    this.session = config.session ?? new InMemorySessionStore();
    this.hooks = config.hooks ?? new DefaultHookRegistry();
    this.injectors = (config.injectors ?? []).sort((a, b) => b.priority - a.priority);
    this.injectorPluginIds = config.injectorPluginIds ?? new Map();
    this.maxIterations = config.options?.maxIterations ?? 500;
    this.historyLimit = config.options?.historyLimit ?? 200;
    this.platform = config.options?.platform ?? 'cli';
    this.workingDir = config.options?.workingDir ?? process.cwd();
    this.resultBudgetChars = config.options?.resultBudgetChars ?? 80_000;
    this.maxToolCallsPerTurn = config.options?.maxToolCallsPerTurn ?? 1000;
    this.maxIdenticalToolCalls = config.options?.maxIdenticalToolCalls ?? 25;
    this.maxConsecutiveIdenticalCalls = config.options?.maxConsecutiveIdenticalCalls ?? 5;
    this.streamingTimeoutMs = config.options?.streamingTimeoutMs ?? 600_000;
    this.smallWindow = config.options?.smallWindow ?? false;
    this.modelRouting = config.modelRouting ?? {};
    this.modelSampling = config.modelSampling;
    if (config.compaction) this.compaction = config.compaction;
    if (config.memoryConsolidation) this.memoryConsolidation = config.memoryConsolidation;
    if (config.promptBudget) this.promptBudget = config.promptBudget;
    this.memoryProviders = config.memoryProviders ?? new Map();
    if (config.storage) this.storage = config.storage;
    if (config.attachmentCache) this.attachmentCache = config.attachmentCache;
    if (config.dataDir) this.dataDir = config.dataDir;
    if (config.observability) this.observability = config.observability;
    if (config.teamId) this.teamId = config.teamId;
    if (config.clarifyBridge) this.clarifyBridge = config.clarifyBridge;
    if (config.requestDumpStore) this.requestDumpStore = config.requestDumpStore;
    if (config.mcpPolicy) this.mcpPolicy = config.mcpPolicy;
    if (config.documentExtractors) this.documentExtractors = config.documentExtractors;
    if (config.onToolMetric) this.onToolMetric = config.onToolMetric;
    if (config.credentialCheck) this.credentialCheck = config.credentialCheck;
    this.safety = config.safety;
    this.checkApprovalPosture = createApprovalPostureGuard(this.safety, this.hooks, config.logger);
    this.contextEngines = config.contextEngines ?? new DefaultContextEngineRegistry();
    if (config.llmHandle) this.llmHandle = config.llmHandle;
  }

  /**
   * Resolve a pending clarify request — called by an interactive surface when
   * the user answers or cancels. No-op when no clarify bridge is wired or the
   * request id is unknown (already resolved / timed out).
   */
  async respondToClarify(response: import('@ethosagent/types').ClarifyResponse): Promise<void> {
    await this.clarifyBridge?.respond(response);
  }

  /** Returns all available tools for inventory display (e.g. TUI splash screen). */
  getAvailableTools(): import('@ethosagent/types').Tool[] {
    return this.tools.getAvailable();
  }

  /** Returns all registered personalities for inventory display. */
  getPersonalityIds(): string[] {
    return this.personalities.list().map((p) => p.id);
  }

  /** Returns the budget cap for the given personality (undefined = no cap). */
  getPersonalityBudgetCap(personalityId?: string): number | undefined {
    const p =
      (personalityId ? this.personalities.get(personalityId) : null) ??
      this.personalities.getDefault();
    return p.budgetCapUsd;
  }

  /** Returns accumulated session spend in USD (0 if no spend recorded yet). */
  getSessionCost(sessionKey: string): number {
    return this.sessionCosts.get(sessionKey) ?? 0;
  }

  /** Resets the session spend counter — call after /new or /personality switch. */
  resetSessionCost(sessionKey: string): void {
    this.sessionCosts.delete(sessionKey);
  }

  /** Manual `/compact` — force a compaction outside a turn (delegates to
   *  `compactSession`; the wired summarizer, if any, comes from `llmHandle`). */
  async compact(
    sessionKey: string,
    opts: { instructions?: string; personalityId?: string } = {},
  ): Promise<ManualCompactionResult> {
    const summarizer = this.llmHandle?.summarize;
    return compactSession(
      {
        session: this.session,
        personalities: this.personalities,
        historyLimit: this.historyLimit,
        minTailUserMessages: this.compaction?.minTailUserMessages,
        ...(summarizer ? { summarizer } : {}),
        ...(this.observability ? { observability: this.observability } : {}),
      },
      sessionKey,
      opts,
    );
  }

  /** Dependency bag passed to extracted stage functions. */
  private get deps(): LoopDeps {
    return {
      llm: this.llm,
      tools: this.tools,
      personalities: this.personalities,
      memory: this.memory,
      session: this.session,
      hooks: this.hooks,
      safety: this.safety,
      injectors: this.injectors,
      injectorPluginIds: this.injectorPluginIds,
      maxIterations: this.maxIterations,
      historyLimit: this.historyLimit,
      platform: this.platform,
      workingDir: this.workingDir,
      resultBudgetChars: this.resultBudgetChars,
      maxToolCallsPerTurn: this.maxToolCallsPerTurn,
      maxIdenticalToolCalls: this.maxIdenticalToolCalls,
      maxConsecutiveIdenticalCalls: this.maxConsecutiveIdenticalCalls,
      streamingTimeoutMs: this.streamingTimeoutMs,
      smallWindow: this.smallWindow,
      modelRouting: this.modelRouting,
      compaction: this.compaction,
      memoryConsolidation: this.memoryConsolidation,
      promptBudget: this.promptBudget,
      memoryProviders: this.memoryProviders,
      storage: this.storage,
      attachmentCache: this.attachmentCache,
      dataDir: this.dataDir,
      observability: this.observability,
      contextEngines: this.contextEngines,
      llmHandle: this.llmHandle,
      clarifyBridge: this.clarifyBridge,
      requestDumpStore: this.requestDumpStore,
      teamId: this.teamId,
      mcpPolicy: this.mcpPolicy,
      onToolMetric: this.onToolMetric,
      credentialCheck: this.credentialCheck,
      sessionCosts: this.sessionCosts,
      sessionReadMtimes: this.sessionReadMtimes,
      contextStore: this.contextStore,
      documentExtractors: this.documentExtractors,
    };
  }

  /** Drive one user turn. Callers MUST drain to completion (not stop at `done`):
   *  turn-end maintenance — silent memory flush + auto-compaction — runs AFTER
   *  `done` while the lane is held, so breaking on `done` skips it. */
  async *run(text: string, opts: RunOptions = {}): AsyncGenerator<AgentEvent> {
    // Stage 1: Turn setup (session, personality, tier, tools, hooks, credential gate)
    const setupResult = yield* setupTurn(this.deps, text, opts);
    if (setupResult.kind === 'refused') return;
    const { setup } = setupResult;

    // Stage 2: Context assembly (user msg, history, memory, system prompt, compaction)
    const assembled = yield* assembleContext(this.deps, setup, text, opts);

    const {
      systemPrompt,
      llmMessages: initialLlmMessages,
      cacheBreakpoints: initialCacheBreakpoints,
      activeSkillFiles,
      baseMessageCount,
      userScopeId,
      compactedThisTurn,
    } = assembled;
    const llmMessages = initialLlmMessages;
    // Phase 3 — mutable so the overflow→compact-and-retry path can re-anchor the
    // prompt cache after it shrinks the in-memory history.
    let cacheBreakpoints = initialCacheBreakpoints;
    // Phase 3 — one emergency compaction per turn on a context-overflow rejection.
    let overflowRetried = false;

    // Destructure setup for loop usage
    const {
      sessionId,
      sessionKey,
      personality,
      workingDir,
      fsReach,
      obsConfig,
      traceId,
      turnNumber,
      lastCompactionTurn,
      activeTier,
      effectiveModel,
      modelOverride: setupModelOverride,
      allowedTools,
      allowedPlugins,
      filterOpts,
      memScopeId,
    } = setup;
    const modelOverride = setupModelOverride;

    // Loop state init (stays in run() — orchestrator's job)
    const abortSignal = opts.abortSignal ?? new AbortController().signal;
    let fullText = '';
    let turnCount = 0;
    const effectiveMaxToolCalls = opts.maxToolCallsPerTurn ?? this.maxToolCallsPerTurn;
    const effectiveMaxIdentical = opts.maxIdenticalToolCalls ?? this.maxIdenticalToolCalls;

    // Tool-call budget tracking — prevents runaway loops (see IMPROVEMENT.md P1-3).
    // Counted across all iterations within a single user turn; one mutable
    // object so per-call enforcement shares the SAME counters (see
    // agent-loop/stages/per-call-enforcement.ts + agent-loop/budgets.ts).
    const budgetCounters = createTurnBudgetCounters();
    let successfulToolCalls = 0;
    let denialStreak = 0;

    // Dry-run tracking — accumulates across all iterations of a turn.
    const dryRunState = {
      callCount: 0,
      cap: opts.dryRun ? (opts.dryRunMaxToolCalls ?? 5) : Infinity,
      capped: 0,
      plan: [] as DryRunToolPlan[],
    };

    // Ch.3d — post-untrusted-read downgrade. After any `outputIsUntrusted`
    // tool returns, dangerous tools are blocked for the next N iterations.
    // Counter resets at the start of each `run()` (a fresh user message),
    // matching the chapter's "counter resets when the user sends a fresh
    // message" contract.
    const dgConfig = personality.safety?.injectionDefense?.postReadDowngrade;
    const dgEnabled = dgConfig?.enabled !== false;
    const dgTurns = dgConfig?.turns ?? 2;
    const dgTools = this.safety.injection.resolveDowngradedTools(dgConfig?.tools);
    const dgRemainingRef = { value: 0 };

    const tierEscalationRef: { value?: string } = {};

    // Watcher tap. Dangerous mode neutralizes halts for this run (consumer-side).
    const watcherTap = createWatcherTap(this.safety);
    if (opts.allowDangerousToolCalls) watcherTap.getHalt = () => null;
    const getHalt = watcherTap.getHalt;

    // ONE budget check for both callers — the loop's iteration boundary below
    // and the ScriptToolBridge's per-call check — so a script call fails with
    // exactly the message the loop halts with. Reads live values (spend,
    // denial streak) at call time.
    const checkBudgets = () =>
      checkTurnBudgets(
        budgetCounters.totalToolCalls,
        effectiveMaxToolCalls,
        budgetCounters.toolNameCounts,
        effectiveMaxIdentical,
        budgetCounters.identicalStreak,
        this.maxConsecutiveIdenticalCalls,
        { spentUsd: this.sessionCosts.get(sessionKey) ?? 0, capUsd: personality.budgetCapUsd },
        denialStreak,
      );

    // tools-as-code-api Lane B — per-turn bridge for in-script tool calls.
    // Closes over the turn's allowlist, hook registry, watcher tap, and the
    // SAME budget counters; threaded to tools via ToolContext.scriptTools.
    const scriptToolBridge = new ScriptToolBridge({
      tools: this.tools,
      hooks: this.hooks,
      observability: this.observability,
      sessionId,
      traceId,
      allowedTools,
      allowedPlugins,
      filterOpts,
      watcherTap,
      counters: budgetCounters,
      checkBudgets,
      turnAttachments: opts.attachments,
      ...(this.onToolMetric ? { onToolMetric: this.onToolMetric } : {}),
    });

    // A1 — this turn's token/cost rollup: filled as each assistant message is
    // persisted, flushed by the finalizer (and by the early exits that skip it).
    const turnUsage = createTurnUsage();

    const streamDeps: StreamStepDeps = {
      llm: this.llm,
      tools: this.tools,
      hooks: this.hooks,
      session: this.session,
      observability: this.observability,
      requestDumpStore: this.requestDumpStore,
      sessionCosts: this.sessionCosts,
      turnUsage,
      streamingTimeoutMs: this.streamingTimeoutMs,
      modelRouting: this.modelRouting,
    };

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (abortSignal.aborted) {
        await flushTurnUsage(this.session, sessionId, turnUsage, this.observability);
        yield { type: 'error', error: 'Aborted', code: 'aborted' };
        if (traceId) {
          this.observability?.endTrace(traceId, 'aborted');
          this.observability?.flush();
        }
        return;
      }

      // Ch.6a — the watcher fired a non-allow decision since the last
      // boundary check. Pause = stop this turn cleanly with a chip the
      // user sees. Terminate = error event + return. force_approval is
      // mapped to pause for v1 until the approval-hook is wired (failing
      // safe is better than silently continuing under the watcher's
      // intent to escalate).
      const halt = getHalt();
      if (halt) {
        if (halt.action === 'terminate') {
          await flushTurnUsage(this.session, sessionId, turnUsage, this.observability);
          yield {
            type: 'error',
            error: `Watcher: ${halt.reason}`,
            code: `watcher_${halt.rule}`,
          };
          if (traceId) {
            this.observability?.endTrace(traceId, 'aborted');
            this.observability?.flush();
          }
          return;
        }
        yield {
          type: 'tool_progress',
          toolName: '_watcher',
          message: `⚠ ${halt.rule}: ${halt.reason}`,
          audience: 'user',
        };
        yield { type: 'halt', kind: 'watcher', rule: halt.rule, message: halt.reason };
        break;
      }

      // Budget guard — tool-call / per-tool repeat / session cost / denial streak.
      // Prior tool_results are in llmMessages, so breaking keeps the history valid.
      const budgetResult = checkBudgets();
      if (budgetResult.exceeded) {
        const { rule, toolName, count, message } = budgetResult;
        yield { type: 'tool_progress', toolName, message, audience: 'user' };
        yield { type: 'halt', kind: 'budget', rule, toolName, count, message };
        break;
      }

      // Stage: Stream one LLM call
      const stepResult = yield* streamStep(
        streamDeps,
        {
          sessionId,
          sessionKey,
          personalityId: personality.id,
          personality,
          traceId,
          obsConfig,
          activeTier,
          effectiveModel,
          modelOverride,
          allowedPlugins,
          allowedTools,
          filterOpts,
          systemPrompt,
          llmMessages,
          cacheBreakpoints,
          abortSignal,
          turnCount,
          watcherTap,
          // §7 — per-call sampling wins; profile defaults fill the gaps.
          opts: applySamplingDefaults(opts, this.modelSampling),
        },
        tierEscalationRef,
      );

      // Phase 3 — a context-overflow rejection is recoverable (the assistant
      // message was NOT persisted): compact the in-memory history and retry once.
      if (stepResult.outcome === 'overflow') {
        const canRetry = !overflowRetried && this.compaction?.retryOnOverflow !== false;
        overflowRetried = true;
        const meta = { sessionId, sessionKey, turnNumber, lastCompactionTurn };
        if (
          canRetry &&
          (await applyOverflowRetry(this.deps, llmMessages, systemPrompt ?? '', personality, meta))
        ) {
          cacheBreakpoints = undefined; // history reshaped — drop stale breakpoints
          iteration--; // retry this iteration with the shrunk history
          continue;
        }
        await flushTurnUsage(this.session, sessionId, turnUsage, this.observability);
        yield { type: 'error', error: stepResult.error, code: 'context_overflow' };
        if (traceId) {
          this.observability?.endTrace(traceId, 'error');
          this.observability?.flush();
        }
        return;
      }

      if (stepResult.outcome === 'fatal') {
        await flushTurnUsage(this.session, sessionId, turnUsage, this.observability);
        return;
      }

      fullText += stepResult.fullTextDelta;
      turnCount++;

      // Update budget counters — these gate the NEXT iteration's LLM call.
      if (stepResult.outcome === 'tool-calls') {
        for (const tc of stepResult.completedToolCalls) {
          recordToolCallForBudgets(budgetCounters, tc.toolName, tc.args);
        }
      }

      if (stepResult.outcome === 'text-end') break;

      const { completedToolCalls } = stepResult;
      const usageSink = stepResult.usageSink;

      // G4 — the first tool dispatch is where the posture has to hold: every
      // surface's hooks are registered by now and nothing has executed yet.
      this.checkApprovalPosture();

      // Stage: Tool processing (pre-flight hooks, execution, result collection)
      const toolResult = yield* processTools(
        {
          tools: this.tools,
          hooks: this.hooks,
          session: this.session,
          safety: this.safety,
          observability: this.observability,
          mcpPolicy: this.mcpPolicy,
          onToolMetric: this.onToolMetric,
          sessionCosts: this.sessionCosts,
          storage: this.storage,
          dataDir: this.dataDir,
          platform: this.platform,
          resultBudgetChars: this.resultBudgetChars,
          teamId: this.teamId,
          contextStore: this.contextStore,
          sessionReadMtimes: this.sessionReadMtimes,
          llm: this.llm,
        },
        {
          completedToolCalls,
          sessionId,
          sessionKey,
          personality,
          workingDir,
          fsReach,
          traceId,
          obsConfig,
          effectiveModel,
          allowedTools,
          allowedPlugins,
          filterOpts,
          llmMessages,
          abortSignal,
          turnCount,
          baseMessageCount,
          memScopeId,
          userScopeId,
          watcherTap,
          usageSink,
          scriptToolBridge,
          dgEnabled,
          dgRemaining: dgRemainingRef,
          dgTools,
          dgTurns,
          dryRun: opts.dryRun ?? false,
          dryRunState,
          tierEscalationRef,
          steerSink: opts.steerSink,
          ...(opts.voiceOrigin ? { voiceOrigin: opts.voiceOrigin } : {}),
          opts: {
            agentId: opts.agentId,
            rootSessionKey: opts.rootSessionKey,
            origin: opts.origin,
            attachments: opts.attachments,
            dryRun: opts.dryRun,
            userId: opts.userId,
            ...(opts.a2aDelegation ? { a2aDelegation: opts.a2aDelegation } : {}),
          },
        },
      );

      if (toolResult.kind === 'return-direct') {
        fullText = toolResult.text;
        await flushTurnUsage(this.session, sessionId, turnUsage, this.observability);
        return;
      }

      successfulToolCalls += toolResult.successCount;
      denialStreak = updateDenialStreak(denialStreak, toolResult);
    }

    // Steps 10–12: finalize turn (usage, hooks, trace, done event)
    yield* finalizeTurn(this.session, this.hooks, this.observability, {
      sessionId,
      traceId,
      personalityId: personality.id,
      allowedPlugins,
      fullText,
      turnCount,
      successfulToolCalls,
      totalToolCalls: budgetCounters.totalToolCalls,
      toolNames: [...budgetCounters.toolNameCounts.keys()],
      initialPrompt: text,
      activeSkillFiles,
      dryRunPlan: dryRunState.plan,
      dryRunCapped: dryRunState.capped,
      isDryRun: opts.dryRun ?? false,
      turnUsage,
    });

    // Phase 3 — turn-end context maintenance (silent memory flush at 70%,
    // auto-compaction at 80%). Runs AFTER `done`, lane still held, so it cannot
    // race the next inbound turn. Auto-compaction is default on (set
    // compaction.autoCompact: false to disable); the memory flush is opt-in.
    const turnEndExtras = {
      userScopeId,
      compactedThisTurn,
      abortSignal,
      systemPrompt: systemPrompt ?? '',
      ...(opts.maxCompletionTokens !== undefined
        ? { maxCompletionTokens: opts.maxCompletionTokens }
        : {}),
    };
    yield* maybeConsolidateAtTurnEnd(this.deps, buildTurnEndCtx(setup, turnEndExtras));
  }

  /**
   * Direct LLM call — bypasses session, personality, tools, and memory.
   * Intended for lightweight internal uses such as the debug assistant.
   */
  completeDirect(
    messages: import('@ethosagent/types').Message[],
    opts: {
      system?: string;
      maxTokens?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): AsyncIterable<import('@ethosagent/types').CompletionChunk> {
    return this.llm.complete(messages, [], {
      system: opts.system,
      maxTokens: opts.maxTokens,
      abortSignal: opts.abortSignal,
    });
  }
}
