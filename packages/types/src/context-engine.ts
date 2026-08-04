// E4 — Per-personality context engine.
//
// Pluggable strategy that decides how to compact a long conversation when it
// approaches the model's context window. Different personalities benefit from
// different policies — a coordinator doing multi-team synthesis cannot afford
// to lose the original task description (drop-oldest is wrong); a coach doing
// short reflection turns is fine with drop-oldest.
//
// Four concrete implementations ship in @ethosagent/core — `drop_oldest`,
// `semantic_summary`, `reference_preserving`, and `tiered_summary` (see
// `context-engines/registry.ts`). Plugin authors can register custom engines
// via `EthosPluginApi.registerContextEngine`.

import type { Message } from './llm';
import type { PersonalityConfig } from './personality';

// ---------------------------------------------------------------------------
// Capability handles — injected by the framework, consumed by engines
// ---------------------------------------------------------------------------

/** Thin LLM handle for engines that need summarization or extraction. */
export interface ContextEngineLLMHandle {
  summarize(messages: Message[], targetTokens: number): Promise<string>;
}

/** Persistent key/value store for context that moves outside the window. */
export interface ContextEngineStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  list(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ContextEngineCompactInput {
  /** Full message history to compact. */
  messages: Message[];
  /** Current system prompt (read-only — engines never mutate it). */
  currentSystem: string;
  /** Engine should aim to bring the message list under this token count. */
  targetTokens: number;
  /** Personality whose `context_engine_options` may carry per-instance config. */
  personality: PersonalityConfig;
  /** Free-form session metadata (sessionId, sessionKey, turn count, etc.). */
  sessionMetadata: ContextEngineSessionMetadata;

  /** LLM handle for summarization / extraction (provided when available). */
  llm?: ContextEngineLLMHandle;
  /** Embedding function for vector / semantic recall engines. */
  embed?: (text: string) => Promise<number[]>;
  /** Persistent store for context paged out beyond the window. */
  store?: ContextEngineStore;
  /** Importance scorer — higher values mean the message is harder to evict. */
  score?: (message: Message) => number;
  /** User-supplied hint from `/compact <text>`. */
  instructions?: string;
  /** Cancellation signal for expensive multi-pass compaction. */
  signal?: AbortSignal;
  /** Framework-owned, model-pinned token counter. */
  countTokens?: (messages: Message[]) => Promise<number>;
}

export interface ContextEngineSessionMetadata {
  sessionId: string;
  sessionKey: string;
  turnNumber: number;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** Audit entry for a message removed during compaction. */
export interface ContextEngineRemovedEntry {
  index: number;
  reason: 'trimmed' | 'summarized' | 'paged_out';
}

/** A summary synthesized from a contiguous range of original messages. */
export interface ContextEngineSummaryEntry {
  text: string;
  /** [startIndex, endIndex) in the original messages array. */
  sourceRange: [number, number];
}

/** Record of a key written to the external store during compaction. */
export interface ContextEngineExternalWrite {
  key: string;
  tokenCount: number;
}

export interface ContextEngineCompactOutput {
  /** Compacted message list — must remain a valid Anthropic / OpenAI history. */
  messages: Message[];
  /** Free-form notes for telemetry / `ethos doctor` (e.g. "summarized 12 → 1"). */
  notes: string;
  /**
   * The synthetic summary text, when the engine produced one. Persisted to the
   * `compressions` table so a session's compaction history stays auditable.
   * Engines that drop messages rather than summarize leave this unset.
   */
  summaryText?: string;
  /**
   * context_compression F2 — indices into `messages` that mark stable
   * `cache_control` boundaries (e.g. end of preserved-front, the summary
   * message). The AgentLoop forwards these to the provider so the prompt
   * cache survives compaction. Engines that produce no stable boundary
   * leave this unset.
   */
  cacheBreakpoints?: number[];
  /** Audit trail of messages removed during compaction. */
  removed?: ContextEngineRemovedEntry[];
  /** Summaries synthesized from contiguous message ranges. */
  summaries?: ContextEngineSummaryEntry[];
  /** Keys written to the external store during this compaction pass. */
  externalWrites?: ContextEngineExternalWrite[];
  /** Monotonic "kept boundary" index — the framework advances it, never moves backward. */
  cacheAnchor?: number;
}

// ---------------------------------------------------------------------------
// Engine interface
// ---------------------------------------------------------------------------

export interface ContextEngine {
  readonly name: string;
  compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput>;
  /**
   * Optional engine-owned trigger, intended to let an engine act EARLIER than
   * the framework's pressure gate (never later — that gate is the floor).
   *
   * NOT WIRED: the framework does not call this today. `maybeCompact` decides
   * purely on the pressure gate, so an engine that declares `shouldCompact`
   * gets no extra trigger. Declared, conformance-tested, and reserved — do not
   * design behaviour around it until a framework call site exists.
   */
  shouldCompact?(input: ContextEngineCompactInput): boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ContextEngineRegistry {
  /** Register an engine factory. Plugin-author entry point. */
  register(engine: ContextEngine): void;
  /** Resolve an engine by name. Returns undefined when the name is unknown. */
  get(name: string): ContextEngine | undefined;
  /** Snapshot of all registered engine names — for `ethos doctor`. */
  names(): string[];
}
