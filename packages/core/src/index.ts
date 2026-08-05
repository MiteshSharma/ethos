export type {
  AgentEvent,
  AgentLoopConfig,
  DryRunToolPlan,
  KnownAgentEventType,
  RunOptions,
} from './agent-loop';
export { AgentLoop, isKnownAgentEvent, KNOWN_AGENT_EVENT_TYPES } from './agent-loop';
// Lane 2b — the production session-replay serialization path, exported so
// restart-prefix tests (and any surface that rehydrates a session) render
// stored history through EXACTLY the code the live loop uses. A test-local
// serializer here would prove nothing (Hermes #4555 failure class).
export { dedupHistory, toLLMMessages } from './agent-loop/history';
export { reconstructFromWatermark, selectActiveWatermark } from './agent-loop/manual-compact';
export { buildAttachmentAnnotation } from './attachment-annotation';
export { deriveBotKey } from './bot-key';
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
export { DefaultStorageRegistry } from './providers/storage-registry';
export { DefaultSttProviderRegistry } from './providers/stt-registry';
export { DefaultTtsProviderRegistry } from './providers/tts-registry';
export { InMemoryRequestDumpStore } from './request-dump-store';
export { stripAnsiEscapes } from './sanitize-output';
export type { SafeFetchFn, SecretsBackend } from './scoped';
export { ScopedFetchImpl, ScopedFsImpl, ScopedProcessImpl, ScopedSecretsImpl } from './scoped';
export { SimpleCompletionImpl } from './simple-completion';
export { applyTemporalDecay, parseTemporalBound, toJournalKey } from './temporal';
export { DefaultToolResultReducerRegistry } from './tool-reducer-registry';
export { DefaultToolRegistry } from './tool-registry';
export { SsrfError, type ValidateUrlOptions, validateUrl } from './url-validator';
