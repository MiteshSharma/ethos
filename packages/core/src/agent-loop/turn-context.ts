import type {
  AgentSafety,
  ContextEngineLLMHandle,
  ContextEngineRegistry,
  ContextInjector,
  HookRegistry,
  LLMProvider,
  McpPolicy,
  MemoryProvider,
  ModelTierName,
  PersonalityConfig,
  PersonalityObservabilityConfig,
  PersonalityRegistry,
  RequestDumpStore,
  SessionStore,
  Storage,
  ToolFilterOpts,
  ToolRegistry,
  WatcherDecision,
  WatcherEvent,
} from '@ethosagent/types';
import type { ClarifyBridge } from '../clarify/clarify-bridge';
import type { ContextStore } from '../context-store';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';

// ---------------------------------------------------------------------------
// LoopDeps — dependency bag injected from AgentLoop's private fields
// ---------------------------------------------------------------------------

export interface LoopDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  personalities: PersonalityRegistry;
  memory: MemoryProvider;
  session: SessionStore;
  hooks: HookRegistry;
  safety: AgentSafety;
  injectors: ContextInjector[];
  injectorPluginIds: Map<ContextInjector, string>;
  maxIterations: number;
  historyLimit: number;
  platform: string;
  workingDir: string;
  resultBudgetChars: number;
  maxToolCallsPerTurn: number;
  maxIdenticalToolCalls: number;
  maxConsecutiveIdenticalCalls: number;
  streamingTimeoutMs: number;
  /** Lane 3(b) — small-window mode (resolved once by wiring); gates declared
   *  `context_engine_options.small_window_toolset` narrowing in turn setup. */
  smallWindow: boolean;
  modelRouting: Record<string, string>;
  /** §5 — resolved compaction gate config (pressure/target fractions +
   *  per-model charsPerToken). Undefined → gate uses its 0.8/0.7 + char/4
   *  defaults. Phase 3 adds `autoCompact` (turn-end trigger; default on since
   *  the context-economy Phase 2 eval-gated flip — set false to disable),
   *  `retryOnOverflow` (compact-and-retry on a context-overflow rejection,
   *  default on), and `defaultEngine` (per-model-class default when the
   *  personality declares no `context_engine`). */
  compaction?: {
    pressure?: number;
    target?: number;
    charsPerToken?: number;
    gateDelta?: number;
    autoCompact?: boolean;
    retryOnOverflow?: boolean;
    defaultEngine?: string;
    /** Item 7 — absolute context-token ceiling; compaction fires above it even
     *  when the fractional gate has not been reached. Absent → fractional only. */
    maxContextTokens?: number;
    /** Item 7 — minimum USER messages kept verbatim in the tail. Absent → 3. */
    minTailUserMessages?: number;
    /** Lane 1(a) — largest-single-tool-result reserve, in tokens; subtracted
     *  from the compactible region by `evaluateGate`. Absent → 0 (unchanged). */
    maxSingleToolResultTokens?: number;
  };
  /** Phase 3 — silent memory-flush turn config. `enabled` gates the whole
   *  feature (default off); the rest tune the soft threshold, hard timebox +
   *  token cap, per-flush memory-delta cap, and the trivial-delta skip. */
  memoryConsolidation?: {
    enabled?: boolean;
    flushThreshold?: number;
    timeboxMs?: number;
    maxTokens?: number;
    maxDeltaChars?: number;
    minMessagesSinceFlush?: number;
  };
  /** §2 / Phase 4 — prompt-economy knobs applied in context assembly (compact
   *  prelude, memory-snapshot cap, memory-guidance suppression). Phase 4
   *  small-window mode additionally sets `memoryIndexMode` (personality memory
   *  becomes an index the agent loads via `memory_read`) and `skillsIndexMode`
   *  (skills forced to index mode). Undefined → assembly byte-identical to
   *  today. */
  promptBudget?: {
    compactPrelude?: boolean;
    memorySnapshotCap?: number;
    suppressMemoryGuidance?: boolean;
    memoryIndexMode?: boolean;
    skillsIndexMode?: boolean;
  };
  memoryProviders: Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >;
  storage?: Storage;
  attachmentCache?: import('@ethosagent/types').AttachmentCache;
  dataDir?: string;
  observability?: AgentLoopObservability;
  contextEngines: ContextEngineRegistry;
  /** Context-engine LLM handle — preferred over engine-constructor injection. */
  llmHandle?: ContextEngineLLMHandle;
  clarifyBridge?: ClarifyBridge;
  requestDumpStore?: RequestDumpStore;
  teamId?: string;
  mcpPolicy?: McpPolicy;
  onToolMetric?: (opts: {
    pluginId: string;
    toolName: string;
    ok: boolean;
    durationMs: number;
    sessionId: string;
    turnId: string;
  }) => void;
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
  sessionCosts: Map<string, number>;
  sessionReadMtimes: Map<string, Map<string, { mtimeMs: number; readAtTurn: number }>>;
  contextStore: ContextStore;
  documentExtractors?: import('@ethosagent/types').DocumentExtractorRegistry;
}

// ---------------------------------------------------------------------------
// TurnSetup — products of the turn-setup stage
// ---------------------------------------------------------------------------

export interface TurnSetup {
  sessionId: string;
  sessionKey: string;
  personality: PersonalityConfig;
  /**
   * The turn's working directory — the personality's declared `fs_reach.workdir`
   * (substituted, absolute), or `LoopDeps.workingDir` when undeclared. Derived
   * PER TURN because the personality resolves per turn while `LoopDeps` is
   * fixed at loop construction: two personalities on one loop must each get
   * their own workdir. Every consumer inside the turn — tool contexts, the
   * memory context, the prompt context — reads THIS value, so the tools and the
   * injectors can never disagree about where the agent is standing.
   */
  workingDir: string;
  /**
   * The read/write allowlist from the SAME `deriveFsReachPaths` call that
   * produced {@link TurnSetup.workingDir}. Threaded rather than re-derived: the
   * derivation is not idempotent (a declared workdir of `${CWD}/out` would
   * compound if the resolved workdir were fed back in as `cwd`), and one
   * derivation is the only way the app-layer prefixes and the workdir can be
   * guaranteed to describe the same filesystem.
   */
  fsReach: { read: string[]; write: string[] };
  obsConfig: PersonalityObservabilityConfig | undefined;
  traceId: string | undefined;
  turnNumber: number;
  lastCompactionTurn: number;
  activeTier: ModelTierName;
  effectiveModel: string;
  modelOverride: string | undefined;
  allowedTools: string[] | undefined;
  allowedPlugins: string[];
  filterOpts: ToolFilterOpts;
  memScopeId: string;
}

export type TurnSetupResult = { kind: 'refused' } | { kind: 'ready'; setup: TurnSetup };

// ---------------------------------------------------------------------------
// AssembledContext — products of the context-assembly stage
// ---------------------------------------------------------------------------

export interface AssembledContext {
  systemPrompt: string | undefined;
  llmMessages: import('@ethosagent/types').Message[];
  cacheBreakpoints: number[] | undefined;
  activeSkillFiles: string[] | undefined;
  baseMessageCount: number;
  userScopeId: string | undefined;
  /** Phase 3 — a pressure-gated compaction fired during THIS turn's assembly.
   *  The turn-end trigger reads it to avoid double-compacting / flushing right
   *  after (it shares the compaction cooldown). */
  compactedThisTurn: boolean;
}

// ---------------------------------------------------------------------------
// WatcherTap — watcher observe/getHalt interface
// ---------------------------------------------------------------------------

export type HaltDecision = Extract<
  WatcherDecision,
  { action: 'pause' | 'force_approval' | 'terminate' }
>;

export interface WatcherTap {
  observe: (event: WatcherEvent) => void;
  getHalt: () => HaltDecision | null;
}

// ---------------------------------------------------------------------------
// resolveModelWithTier — extracted from AgentLoop private method
// ---------------------------------------------------------------------------

export function resolveModelWithTier(
  personality: PersonalityConfig,
  tier: ModelTierName,
  modelRouting: Record<string, string>,
  llmName: string,
  llmModel: string,
): { model: string; source: 'personality' | 'global' } {
  const personalityOverride = modelRouting[personality.id];
  if (personalityOverride) return { model: personalityOverride, source: 'personality' };

  // Only use tier config when the personality declares a provider that matches
  // the active LLM. This prevents Anthropic-specific model IDs from being
  // injected into OpenRouter/Ollama/Gemini providers. Without a matching
  // provider declaration, fall through to the global model.
  const modelConfig = personality.model;
  if (modelConfig && typeof modelConfig === 'object' && personality.provider === llmName) {
    const tierModel = modelConfig[tier] ?? modelConfig.default;
    if (tierModel) return { model: tierModel, source: 'personality' };
  }

  return { model: llmModel, source: 'global' };
}
