# Langfuse export mapping

`extensions/export-langfuse` ships every completed turn trace in
`observability.db` to Langfuse's batch ingestion endpoint
(`POST /api/public/ingestion`). This document is the field-by-field map from
Ethos's internal record, through the OTel GenAI semantic-convention name
(decision 10 of `plan/phases/analytics-observability.md`) where one exists,
to the Langfuse ingestion field it lands on.

## API target and a deprecation caveat

This exporter targets Langfuse's **legacy batch ingestion API**
(`trace-create` / `span-create` / `generation-create` / `event-create`
envelopes over `POST /api/public/ingestion`), verified against
[langfuse.com/docs/api-and-data-platform/features/public-api](https://langfuse.com/docs/api-and-data-platform/features/public-api)
and the schema in `langfuse/langfuse`'s
`fern/apis/server/definition/ingestion.yml` (checked 2026-08-19).

**This API is deprecated.** Langfuse's own docs state it is scheduled for
removal **on Langfuse Cloud on 2026-11-16**. Self-hosted Langfuse has no
forced cutoff — "breaking removals only happen in major server releases" —
so a self-hosted target keeps working past that date. The recommended
replacement is an OTLP/HTTP endpoint (`POST /otel/v1/traces`), which this
exporter does **not** implement: OTLP has no first-class equivalent for a
free-form `event-create` observation, its trace/span ids are fixed-width
binary (16/8 bytes) rather than free-form strings, and adopting it would
mean redesigning the mapping this document describes — a decision for a
follow-up lane, not an in-scope substitution here. Operators pointing
`telemetry.export.langfuse.baseUrl` at Langfuse Cloud should plan to migrate
before 2026-11-16; self-hosted operators are not on that clock. Until then
(or if the configured endpoint stops accepting these event types — see
"Fail-open behavior" below) export failures are logged and retried forever,
never silently dropped.

## Field mapping

### Turn trace → Langfuse trace (`trace-create`)

| Ethos (`Trace`) | Langfuse field |
|---|---|
| `traceId` | `id` (upsert key — see "Idempotency" below) |
| `startTs` | `timestamp` (ISO 8601) |
| `kind` (always `'turn'` for an exported trace) | `name` |
| `sessionId` | `sessionId` |
| `subjectId` (the personality id) | `metadata.personality` |
| `attrs.platform` | `metadata.platform` |

Nothing else on `Trace.attrs` is exported — `turn-setup.ts`'s
`startTurnTrace` populates only `{ platform }`. There is no `botKey` on the
trace today; `metadata` carries only what is actually there.

### `llm_call` span → Langfuse generation (`generation-create`)

| Ethos (`Span`, kind `llm_call`) | OTel GenAI semconv | Langfuse field |
|---|---|---|
| `spanId` | — | `id` (upsert key) |
| `traceId` | — | `traceId` |
| `parentSpanId` | — | `parentObservationId` |
| `name` (the model name) | `gen_ai.request.model` | `name`, `model` |
| `startTs` / `endTs` | — | `startTime` / `endTime` |
| `attrs.inputTokens` | `gen_ai.usage.input_tokens` | `usageDetails.input` |
| `attrs.outputTokens` | `gen_ai.usage.output_tokens` | `usageDetails.output` |
| `attrs.cacheReadTokens` | — (Anthropic-style, no stable semconv name yet) | `usageDetails.cache_read_input_tokens` |
| `attrs.cacheCreationTokens` | — | `usageDetails.cache_creation_input_tokens` |
| `attrs.estimatedCostUsd` | `gen_ai.usage.cost` (draft) | `costDetails.total` |
| `attrs.clientRequestId` | — | `metadata.clientRequestId` |
| `attrs.providerRequestId` | — | `metadata.providerRequestId` |
| `attrs.provider` | `gen_ai.system` | `metadata.provider` |
| `attrs.costBasis` | — | `metadata.costBasis` (free-form — Langfuse has no native field for "known priced" vs. "unknown model, \$0") |
| `status` (`'error'` → `ERROR`, `'blocked'` → `WARNING`) | — | `level` |

A zero-valued token bucket (e.g. `cacheCreationTokens: 0`, the common case
for non-Anthropic providers or a cache-miss call) is **omitted** from
`usageDetails` rather than written as an explicit `0` — Langfuse treats
every key present as a separate, non-overlapping bucket, and an explicit
zero for a bucket the call never used adds noise with no signal.

`usageDetails`/`costDetails` are used over the older `usage`/`cost` fields
because only the newer pair supports arbitrary named buckets — required for
`cache_read_input_tokens` — while `usage` is limited to a fixed
input/output/total/unit shape with no cache-token support.

### Other span kinds → Langfuse span (`span-create`)

`tool_call`, `hook`, `mcp_call`, and `voice_stage` spans all map to
`span-create` (only `llm_call` becomes a generation):

| Ethos (`Span`) | Langfuse field |
|---|---|
| `spanId` | `id` (upsert key) |
| `traceId` | `traceId` |
| `parentSpanId` | `parentObservationId` |
| `name` (the tool name, for `tool_call`) | `name` |
| `startTs` / `endTs` | `startTime` / `endTime` |
| `attrs.durationMs` (the per-call timer — see A4 in the main plan; the span's own `start_ts`..`end_ts` is batch wall-clock for parallel tool calls, not this call's duration) | `metadata.durationMs` |
| `kind` | `metadata.kind` |
| `status` (`'error'` → `ERROR`, `'blocked'` → `WARNING`) | `level` |

### `skill.*` / audit events → Langfuse event (`event-create`)

| Ethos (`ObsEvent`) | Langfuse field |
|---|---|
| `eventId` | `id` (upsert key) |
| `traceId` | `traceId` |
| `category` (e.g. `skill.invoked`, `skill.exposed`) | `name` |
| `ts` | `startTime` |
| `severity` (`critical`/`error` → `ERROR`, `warn` → `WARNING`, `info` → `DEFAULT`) | `level` |
| `cause` | `statusMessage` |
| `details` | `metadata` |

## Idempotency

Every `id` above is the same value on every export attempt of that
trace/span/event — Langfuse upserts a `trace-create` (and every observation
type) by `id`, so a retried batch after a network failure or a non-2xx
response overwrites the same row rather than duplicating it. This is the
idempotency backstop decision 7 (D7) of the main plan calls for; the
claim/release mechanics in `extensions/observability-sqlite`
(`claimUnexportedTraces` / `markTraceExported` / `releaseTraceClaim`) exist
to keep concurrent pollers from wasting work racing each other, not to
prevent duplicate Langfuse rows — that guarantee comes from Langfuse's own
upsert semantics.

## Fail-open behavior

A trace whose spans are gone by the time the poller reaches it — retention
pruning outran the export poller, a legitimate race under a short `spans`
retention window — is treated as nothing-left-to-ship: it is stamped
`exported_at` (so it is never re-claimed) and an
`export.langfuse_skipped_pruned` event is logged, rather than treated as an
error or retried forever.

Any other export failure (network error, non-2xx response — including a
`400` from a Langfuse v4 instance running in `events_only` mode, which
rejects this endpoint's event types entirely) releases the trace's claim
and logs an `export.langfuse_failed` event. There is no terminal "abandoned"
state and no backoff schedule: an unexported trace is retried on every poll
tick, forever, until it either exports successfully or its spans are
pruned out from under it.
