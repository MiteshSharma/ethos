export type {
  AgentEvent,
  AgentLoopConfig,
  DryRunToolPlan,
  KnownAgentEventType,
  RunOptions,
} from './agent-loop';
export { AgentLoop, isKnownAgentEvent, KNOWN_AGENT_EVENT_TYPES } from './agent-loop';
// tools-as-code-api Lane B — the per-turn bridge (and its budget-counter
// companions) are exported so integration tests and non-loop surfaces can
// drive the EXACT enforcement path the loop wires, not a re-statement of it.
export { checkTurnBudgets } from './agent-loop/budgets';
// Lane 1(b/c) — the gate's output-reserve constant, shared with wiring's
// startup floor diagnostic and window-scaled result budget so there is ONE
// reserve arithmetic, not a drifting copy.
export { DEFAULT_OUTPUT_RESERVE_TOKENS } from './agent-loop/compaction';
// Lane 2b — the production session-replay serialization path, exported so
// restart-prefix tests (and any surface that rehydrates a session) render
// stored history through EXACTLY the code the live loop uses. A test-local
// serializer here would prove nothing (Hermes #4555 failure class).
export { dedupHistory, toLLMMessages } from './agent-loop/history';
export { reconstructFromWatermark, selectActiveWatermark } from './agent-loop/manual-compact';
// The app-layer half of fs_reach enforcement. Exported so the docker/ScopedStorage
// parity test drives EXACTLY the scope the loop builds, not a re-statement of it.
export { buildScopedStorage } from './agent-loop/scoped-storage';
// Lane 3(b) — declared small-window toolset parsing, shared with wiring's
// startup narrowing diagnostic so both read the declaration identically.
export { parseSmallWindowToolset } from './agent-loop/small-window-toolset';
export {
  createTurnBudgetCounters,
  recordToolCallForBudgets,
  type TurnBudgetCounters,
} from './agent-loop/stages/per-call-enforcement';
export {
  SCRIPT_CALLS_PER_EXECUTION,
  SCRIPT_RESULT_BUDGET_CHARS,
  ScriptToolBridge,
  type ScriptToolBridgeDeps,
} from './agent-loop/stages/script-tool-bridge';
// Lane 5(i) — the tier resolution (with its provider-match guard), exported so
// wiring's tier-mismatch startup diagnostic is tested against EXACTLY the
// guard the loop runs, not a drifting re-statement of it.
export { resolveModelWithTier } from './agent-loop/turn-context';
export { buildAttachmentAnnotation } from './attachment-annotation';
export { deriveBotKey } from './bot-key';
export { toolsDeclaringNetwork } from './capability-reach';
export type { CapabilityBackends, CapabilityScopeIds } from './capability-resolver';
export { resolveCapabilities } from './capability-resolver';
export type { CapabilityValidationError } from './capability-validator';
export { validateRegistration } from './capability-validator';
export {
  ClarifyBridge,
  ClarifyBusyError,
  ClarifyNoSurfaceError,
  type ClarifyPresenter,
  type ClarifyRequestInput,
  type ClarifyResolvedListener,
  ClarifyTimedOutNoDefaultError,
} from './clarify/clarify-bridge';
export { FileClarifyStore } from './clarify/file-clarify-store';
export { type ConformanceResult, validateContextEngine } from './context-engines/conformance';
export { DropOldestEngine } from './context-engines/drop-oldest';
export { ReferencePreservingEngine } from './context-engines/reference-preserving';
export {
  DefaultContextEngineRegistry,
  type DefaultContextEngineRegistryOptions,
} from './context-engines/registry';
export { SemanticSummaryEngine, type SummarizerFn } from './context-engines/semantic-summary';
export { TieredSummaryEngine } from './context-engines/tiered-summary';
export {
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTokens,
} from './context-engines/token-estimator';
export { ContextStore } from './context-store';
export { InMemorySessionStore } from './defaults/in-memory-session';
export type { InMemoryToolContextOptions } from './defaults/in-memory-tool-context';
export { makeTestToolContext } from './defaults/in-memory-tool-context';
export { NoopMemoryProvider } from './defaults/noop-memory';
export { DefaultPersonalityRegistry } from './defaults/noop-personality';
export { redactArgs, synthesizeDryRunCapResult, synthesizeDryRunResult } from './dry-run';
export {
  type ExecutionConformanceResult,
  runExecutionConformance,
} from './execution/conformance';
export type { SessionLifecycleEvent, SessionManagerOptions } from './execution/session-manager';
export { SessionManager } from './execution/session-manager';
// The ONE fs_reach derivation. Both enforcement layers — ScopedStorage
// (app) and the docker backend's bind mounts (OS) — consume this; a second
// copy would drift into silent data loss (writes permitted but never mounted).
export {
  deriveFsReachPaths,
  EmptySubstitutionError,
  type FsReachVars,
  personalityAssetDir,
  substitute,
} from './fs-reach';
export { DefaultHookRegistry } from './hook-registry';
export type { LearnRequest } from './learn';
export { buildLearnPrompt, parseLearnArgs } from './learn';
export type { LocalToolTransportLiveCtx } from './local-tool-transport';
export { LocalToolTransport } from './local-tool-transport';
export {
  EagerPrefetchPolicy,
  LastWriteWinsPolicy,
  LazyOnDemandPolicy,
  MemoryConflictError,
} from './memory-policies';
export { DefaultNotificationRouter } from './notification-router';
export type { AgentLoopObservability } from './observability/agent-loop-observability';
export { assertWithinBase, BoundaryEscapeError } from './path-boundary';
export type { PluginFactory } from './plugin-registry';
export { PluginRegistry } from './plugin-registry';
export type { ChainedProviderOptions } from './providers/chained-provider';
export { ChainedProvider } from './providers/chained-provider';
export { DefaultDocumentExtractorRegistry } from './providers/document-extractor-registry';
export { DefaultExecutionBackendRegistry } from './providers/execution-registry';
export { DefaultLLMProviderRegistry } from './providers/llm-registry';
export { DefaultMemoryProviderRegistry } from './providers/memory-registry';
export { DefaultRealtimeVoiceProviderRegistry } from './providers/realtime-registry';
export { DefaultStorageRegistry } from './providers/storage-registry';
export { DefaultSttProviderRegistry } from './providers/stt-registry';
export { DefaultTtsProviderRegistry } from './providers/tts-registry';
export type {
  RealtimeEntrySelection,
  RealtimeProviderForPersonality,
  ResolvedVoicePreferences,
  ResolveRealtimeForPersonalityOptions,
  ResolveRealtimeOptions,
  ResolveSttForPersonalityOptions,
  ResolveSttOptions,
  ResolveTtsForPersonalityOptions,
  ResolveTtsOptions,
  ResolveVoicePreferencesOptions,
  ResolveVoiceProviderOptions,
  SelectRealtimeEntryOptions,
  SelectSttEntryOptions,
  SelectTtsEntryOptions,
  SelectVoiceEntryOptions,
  SttEntrySelection,
  SttProviderForPersonality,
  TtsEntrySelection,
  TtsProviderForPersonality,
  VoiceEntrySelection,
  VoiceEntrySelectionReason,
  VoiceResolution,
  VoiceResolutionErrorCode,
} from './providers/voice-resolution';
export {
  realtimeEntryProviderConfig,
  resolveRealtimeProvider,
  resolveRealtimeProviderForPersonality,
  resolveSttProvider,
  resolveSttProviderForPersonality,
  resolveTtsProvider,
  resolveTtsProviderForPersonality,
  resolveVoicePreferences,
  selectRealtimeEntry,
  selectSttEntry,
  selectTtsEntry,
  sttEntryProviderConfig,
  ttsEntryProviderConfig,
  unwrapVoiceResolution,
  VoiceProviderError,
} from './providers/voice-resolution';
export { InMemoryRequestDumpStore } from './request-dump-store';
export {
  type AgentSafetyConformanceResult,
  runAgentSafetyConformance,
} from './safety-conformance';
export { stripAnsiEscapes } from './sanitize-output';
export type { SafeFetchFn, SecretsBackend } from './scoped';
export { ScopedFetchImpl, ScopedFsImpl, ScopedProcessImpl, ScopedSecretsImpl } from './scoped';
export type { ScriptExclusionCategory, ScriptSafeToolMeta } from './script-safe';
export { scriptCallableFor, scriptExclusionError, scriptExclusionFor } from './script-safe';
export { SimpleCompletionImpl } from './simple-completion';
export type { SpokenStyleInjectorOptions } from './spoken-style-injector';
export { createSpokenStyleInjector, SPOKEN_STYLE_BLOCK } from './spoken-style-injector';
export { applyTemporalDecay, parseTemporalBound, toJournalKey } from './temporal';
export { DefaultToolResultReducerRegistry } from './tool-reducer-registry';
export { DefaultToolRegistry } from './tool-registry';
export { SsrfError, type ValidateUrlOptions, validateUrl } from './url-validator';
export { buildVoiceOriginAnnotation, VOICE_ORIGIN_TAG } from './voice-origin';
