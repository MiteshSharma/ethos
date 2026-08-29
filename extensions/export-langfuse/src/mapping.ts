import { randomUUID } from 'node:crypto';
import type { ObsEvent, Span, Trace } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Internal record -> Langfuse ingestion event mapping. See MAPPING.md for the
// field-by-field table; this is the code that implements it.
//
// Targets the legacy `POST /api/public/ingestion` batch endpoint (trace-
// create / span-create / generation-create / event-create), verified against
// https://langfuse.com/docs/api-and-data-platform/features/public-api and
// the schema at langfuse/langfuse's `fern/apis/server/definition/ingestion.yml`
// (2026-08). This endpoint is deprecated in favor of an OTLP endpoint and is
// scheduled for removal on Langfuse Cloud on 2026-11-16; self-hosted Langfuse
// has no forced cutoff ("breaking removals only happen in major server
// releases"). It maps 1:1 onto Ethos's own trace/span/event model — the OTLP
// endpoint does not — so it stays the right target for a local-first,
// self-hostable-first deployment. See MAPPING.md for the caveat.
// ---------------------------------------------------------------------------

export interface LangfuseIngestionEvent {
  /** The envelope event's own id — distinct from the trace/observation id in
   *  `body.id`. Langfuse discards duplicate envelope ids only for exact
   *  retries of the same envelope; the trace/observation `id` is what drives
   *  upsert idempotency (D7). */
  id: string;
  timestamp: string;
  type: 'trace-create' | 'span-create' | 'generation-create' | 'event-create';
  body: Record<string, unknown>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Drop `undefined` values so the payload doesn't carry explicit-undefined
 *  noise (`JSON.stringify` already skips them, but the fixture-comparison
 *  tests compare parsed objects where that distinction can leak). */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function envelope(
  type: LangfuseIngestionEvent['type'],
  body: Record<string, unknown>,
): LangfuseIngestionEvent {
  return { id: randomUUID(), timestamp: new Date().toISOString(), type, body: compact(body) };
}

function levelForSpanStatus(status: Span['status']): string | undefined {
  if (status === 'error') return 'ERROR';
  if (status === 'blocked') return 'WARNING';
  return undefined;
}

function levelForEventSeverity(severity: ObsEvent['severity']): string {
  if (severity === 'critical' || severity === 'error') return 'ERROR';
  if (severity === 'warn') return 'WARNING';
  return 'DEFAULT';
}

function traceCreateEvent(trace: Trace): LangfuseIngestionEvent {
  const attrs = trace.attrs ?? {};
  const platform = typeof attrs.platform === 'string' ? attrs.platform : undefined;
  return envelope('trace-create', {
    id: trace.traceId,
    timestamp: iso(trace.startTs),
    name: trace.kind,
    sessionId: trace.sessionId,
    metadata: compact({ personality: trace.subjectId, platform }),
  });
}

function generationCreateEvent(trace: Trace, span: Span): LangfuseIngestionEvent {
  const attrs = span.attrs ?? {};
  const usageDetails = compact({
    input:
      typeof attrs.inputTokens === 'number' && attrs.inputTokens > 0
        ? attrs.inputTokens
        : undefined,
    output:
      typeof attrs.outputTokens === 'number' && attrs.outputTokens > 0
        ? attrs.outputTokens
        : undefined,
    cache_read_input_tokens:
      typeof attrs.cacheReadTokens === 'number' && attrs.cacheReadTokens > 0
        ? attrs.cacheReadTokens
        : undefined,
    cache_creation_input_tokens:
      typeof attrs.cacheCreationTokens === 'number' && attrs.cacheCreationTokens > 0
        ? attrs.cacheCreationTokens
        : undefined,
  });
  const costDetails =
    typeof attrs.estimatedCostUsd === 'number' ? { total: attrs.estimatedCostUsd } : undefined;
  return envelope('generation-create', {
    id: span.spanId,
    traceId: trace.traceId,
    parentObservationId: span.parentSpanId,
    name: span.name,
    startTime: iso(span.startTs),
    endTime: span.endTs !== undefined ? iso(span.endTs) : undefined,
    level: levelForSpanStatus(span.status),
    model: span.name,
    ...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
    costDetails,
    metadata: compact({
      provider: attrs.provider,
      costBasis: attrs.costBasis,
      clientRequestId: attrs.clientRequestId,
      providerRequestId: attrs.providerRequestId,
    }),
  });
}

function spanCreateEvent(trace: Trace, span: Span): LangfuseIngestionEvent {
  const attrs = span.attrs ?? {};
  return envelope('span-create', {
    id: span.spanId,
    traceId: trace.traceId,
    parentObservationId: span.parentSpanId,
    name: span.name,
    startTime: iso(span.startTs),
    endTime: span.endTs !== undefined ? iso(span.endTs) : undefined,
    level: levelForSpanStatus(span.status),
    metadata: compact({ durationMs: attrs.durationMs, kind: span.kind }),
  });
}

function eventCreateEvent(trace: Trace, event: ObsEvent): LangfuseIngestionEvent {
  return envelope('event-create', {
    id: event.eventId,
    traceId: event.traceId ?? trace.traceId,
    name: event.category,
    startTime: iso(event.ts),
    level: levelForEventSeverity(event.severity),
    statusMessage: event.cause,
    metadata: event.details,
  });
}

/**
 * Build the full Langfuse ingestion batch for one turn trace: one
 * `trace-create`, one `generation-create` per `llm_call` span, one
 * `span-create` per every other span kind, and one `event-create` per audit
 * event. Order doesn't matter to Langfuse (it upserts by id), but the trace
 * comes first for readability.
 */
export function buildLangfuseBatch(
  trace: Trace,
  spans: Span[],
  events: ObsEvent[],
): LangfuseIngestionEvent[] {
  const batch: LangfuseIngestionEvent[] = [traceCreateEvent(trace)];
  for (const span of spans) {
    batch.push(
      span.kind === 'llm_call' ? generationCreateEvent(trace, span) : spanCreateEvent(trace, span),
    );
  }
  for (const event of events) {
    batch.push(eventCreateEvent(trace, event));
  }
  return batch;
}
