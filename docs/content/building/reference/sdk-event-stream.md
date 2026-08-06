---
title: "EventStream reference"
description: "SSE streaming client for real-time turn events and push notifications."
kind: reference
audience: developer
slug: sdk-event-stream
updated: 2026-05-13
---

`EventStream` opens a Server-Sent Events connection to a session and dispatches parsed, validated events to your callback. It handles reconnection, sequence tracking, and resumption automatically.

## Source {#source}

Defined in [`packages/sdk/src/stream.ts`](https://github.com/ethosagent/ethos/blob/main/packages/sdk/src/stream.ts). Re-exported from `@ethosagent/sdk`.

## Quick start {#quickstart}

```ts
import { EventStream } from '@ethosagent/sdk';

const sub = EventStream({
  baseUrl: 'http://localhost:2400',
  apiKey: 'esk_...',
  sessionId: 'ses_abc123',
  onEvent(event, seq) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
    if (event.type === 'done') console.log('\n--- turn complete ---');
  },
  onError(err) {
    console.error('Stream error:', err);
  },
});

// Later:
sub.close();
```

## EventStreamOptions {#options}

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | yes | Origin of the Ethos web-api server. |
| `apiKey` | `string` | no | Bearer token. Omit for cookie-auth mode (sends `credentials: 'include'`). |
| `sessionId` | `string` | yes | Session to subscribe to. |
| `sinceSeq` | `number` | no | Resume from this sequence number. Events with `id <= sinceSeq` are skipped server-side. |
| `signal` | `AbortSignal` | no | External abort signal. When aborted, the stream closes cleanly. |
| `onEvent` | `(event: SseEvent, seq: number) => void` | yes | Called for every validated event. |
| `onError` | `(err: unknown) => void` | no | Called on connection failures and parse errors. |

## EventStreamSubscription {#subscription}

The return value of `EventStream()`.

| Property / Method | Type | Description |
|---|---|---|
| `close()` | `() => void` | Abort the connection. Sets `closed` to `true`. |
| `lastSeq` | `number` (readonly) | Sequence number of the last successfully processed event. |
| `closed` | `boolean` (readonly) | `true` after `close()` is called or the connection is permanently lost. |

## Reconnection {#reconnection}

When the connection drops (network error, server restart), `EventStream` waits 3 seconds and retries automatically. It passes the `lastEventId` query parameter so the server can resume from where the client left off. The loop continues until `close()` is called or the provided `signal` is aborted.

## SSE endpoint {#endpoint}

The stream connects to:

```
GET <baseUrl>/sse/sessions/<sessionId>?lastEventId=<sinceSeq>
```

Each SSE frame has an `id:` line (monotonic integer sequence) and a `data:` line (JSON matching `SseEventSchema`).

## SSE event types {#event-types}

Events are a discriminated union on the `type` field. They fall into two families.

### Per-turn events {#per-turn}

These fire during an active agent turn and mirror `AgentEvent` from `@ethosagent/core`.

| Type | Key fields | Description |
|---|---|---|
| `text_delta` | `text` | Incremental text token from the LLM. |
| `thinking_delta` | `thinking` | Extended-thinking token (when enabled). |
| `tool_start` | `toolCallId`, `toolName`, `args` | Tool execution began. |
| `tool_progress` | `toolName`, `message`, `percent?`, `audience` | Progress update from a running tool. |
| `tool_end` | `toolCallId`, `toolName`, `ok`, `durationMs`, `result?` | Tool execution finished. |
| `usage` | `inputTokens`, `outputTokens`, `estimatedCostUsd` | Token usage for the current API call. |
| `context_meta` | `data` | Arbitrary metadata attached to the turn context. |
| `done` | `text`, `turnCount` | Turn completed. `text` is the full assistant response. |
| `error` | `error`, `code` | Turn failed with an error. |
| `message_persisted` | `messageId`, `role` | A message was persisted to the session store. |

### Push events {#push}

These arrive regardless of whether a turn is active. They notify the client of system-wide state changes.

| Type | Key fields | Description |
|---|---|---|
| `tool.approval_required` | `request` (ApprovalRequest) | A tool call needs user approval before proceeding. |
| `approval.resolved` | `approvalId`, `decision`, `decidedBy` | An approval was resolved (possibly by another tab). |
| `clarify.request` | `requestId`, `question`, `options?`, `default?`, `defaultDeadlineAt` | The agent asked a clarification question mid-turn. |
| `clarify.resolved` | `requestId`, `source` | A clarification was answered or timed out. |
| `cron.fired` | `jobId`, `ranAt`, `outputPath?` | A cron job completed a run. |
| `mesh.changed` | `agents` | The agent mesh topology changed. |
| `evolve.skill_pending` | `skillId`, `personalityId?`, `proposedAt` | The skill evolver proposed a new or rewritten skill. |
| `protocol.upgrade_required` | `serverVersion`, `clientVersionExpected` | The server requires a newer client version. |

## Narrowing events {#narrowing}

The `SseEvent` type is a Zod discriminated union. Use `event.type` in a switch or if-check to narrow:

```ts
onEvent(event) {
  switch (event.type) {
    case 'text_delta':
      // event is { type: 'text_delta'; text: string }
      break;
    case 'tool_start':
      // event is { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
      break;
  }
}
```
