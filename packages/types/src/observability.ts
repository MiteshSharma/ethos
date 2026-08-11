/**
 * Opaque trace kind. Convention: `<domain>.<verb>` (e.g. `turn`, `cron.tick`).
 * The library does not enforce specific values; consumers define their own
 * vocabulary in their adapter layer.
 */
export type TraceKind = string;

/**
 * `voice_stage` covers the per-turn voice pipeline stages (stt, first
 * sentence, first audio, whole turn). It is a distinct kind because a voice
 * stage is neither a tool nor an LLM call, and "which stage ate the latency"
 * is the only question voice telemetry is asked.
 */
export type SpanKind = 'tool_call' | 'llm_call' | 'hook' | 'mcp_call' | 'voice_stage';

/**
 * Opaque event category. Convention: `<domain>.<verb>` (e.g. `audit.transition`,
 * `app.login`). The library does not enforce specific values; consumers define
 * their own vocabulary in their adapter layer.
 */
export type EventCategory = string;

export type EventSeverity = 'info' | 'warn' | 'error' | 'critical';

/**
 * How aggressively to redact tool args / bodies / snapshots before storing.
 *
 * - `none`     — strip the field entirely (record metadata only).
 * - `redacted` — apply built-in floor patterns plus any `extraPatterns`.
 * - `full`     — store as-is. Built-in floor patterns still apply; only the
 *                consumer-supplied `extraPatterns` are skipped.
 *
 * The default policy is `{ level: 'redacted' }` when not set on the writer
 * call site or via the writer's default.
 */
export interface RedactionPolicy {
  level: 'none' | 'redacted' | 'full';
  extraPatterns?: string[];
}

export interface Trace {
  traceId: string;
  sessionId?: string;
  kind: TraceKind;
  startTs: number;
  endTs?: number;
  status?: 'ok' | 'error' | 'aborted';
  /**
   * Opaque identifier of what this trace is about. Consumers map their own
   * domain concept onto it (e.g. ethos uses personality id; another consumer
   * might use tenant id, service name, or account id).
   */
  subjectId?: string;
  snapshotId?: string;
  attrs?: Record<string, unknown>;
}

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  startTs: number;
  endTs?: number;
  status?: 'ok' | 'error' | 'blocked';
  attrs?: Record<string, unknown>;
}

export interface ObsEvent {
  eventId: string;
  traceId?: string;
  spanId?: string;
  ts: number;
  category: EventCategory;
  severity: EventSeverity;
  code?: string;
  cause?: string;
  details?: Record<string, unknown>;
}

export interface Snapshot {
  snapshotId: string;
  takenAt: number;
  /** See `Trace.subjectId`. */
  subjectId: string;
  body: string;
}

export interface ObservabilityStore {
  insertTrace(trace: Trace): void;
  closeTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void;
  insertSpan(span: Span, extraRedactPatterns?: string[]): void;
  closeSpan(
    spanId: string,
    status: 'ok' | 'error' | 'blocked',
    attrs?: Record<string, unknown>,
    extraRedactPatterns?: string[],
  ): void;
  insertEvent(event: ObsEvent, extraRedactPatterns?: string[]): void;
  insertSnapshot(snapshot: Snapshot): void;
  getTrace(traceId: string): Trace | null;
  getSpans(traceId: string): Span[];
  getEvents(filter: {
    traceId?: string;
    category?: string;
    since?: number;
    limit?: number;
  }): ObsEvent[];
  getRecentTraces(limit: number): Trace[];
  close(): void;
}

/**
 * Model tier observability event categories.
 * Emitted when the LLM tier changes mid-turn via tool escalation or user override.
 */
export const TIER_ESCALATION_CATEGORY = 'tier.escalation' as EventCategory;
export const TIER_OVERRIDE_CATEGORY = 'tier.override' as EventCategory;

export interface TierEscalationDetails {
  from: string;
  to: string;
  reason: string;
  personalityId: string;
}

export interface TierOverrideDetails {
  actor: 'user' | 'framework';
  tier: string;
  personalityId: string;
}

/**
 * Minimal write-side interface that AgentLoop and other core components
 * use to record observability data. Defined here so @ethosagent/core does
 * not need to depend on the concrete @ethosagent/observability-sqlite package.
 */
export interface ObservabilityWriter {
  startTrace(opts: {
    sessionId?: string;
    kind: TraceKind;
    subjectId?: string;
    snapshotId?: string;
    attrs?: Record<string, unknown>;
    redaction?: RedactionPolicy;
  }): string;
  endTrace(traceId: string, status: 'ok' | 'error' | 'aborted'): void;
  startSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    kind: SpanKind;
    name: string;
    attrs?: Record<string, unknown>;
    redaction?: RedactionPolicy;
  }): string;
  endSpan(
    spanId: string,
    status: 'ok' | 'error' | 'blocked',
    attrs?: Record<string, unknown>,
  ): void;
  recordEvent(event: Omit<ObsEvent, 'eventId' | 'ts'>): void;
  flush(): void;
}

// ---------------------------------------------------------------------------
// Request dump store — full LLM request/response recording
// ---------------------------------------------------------------------------

export interface RequestDumpRecord {
  requestId: string;
  timestamp: string;
  sessionId: string;
  personalityId?: string;
  turnNumber: number;
  model: string;
  durationMs?: number;
  requestTokens?: { system: number; tools: number; messages: number };
  responseTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  estimatedCostUsd?: number;
  finishReason?: string;
  system?: string;
  tools?: import('./llm').ToolDefinitionLite[];
  messages?: import('./llm').Message[];
  responseText?: string;
}

export interface RequestDumpStore {
  append(record: RequestDumpRecord): Promise<void>;
  recent(opts: {
    limit: number;
    sessionId?: string;
    since?: Date;
    includeContent?: boolean;
  }): Promise<RequestDumpRecord[]>;
  close(): Promise<void>;
}
