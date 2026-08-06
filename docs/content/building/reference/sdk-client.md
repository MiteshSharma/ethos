---
title: "SDK client reference"
description: "Constructor options, RPC namespaces, and authentication modes for EthosClient."
kind: reference
audience: developer
slug: sdk-client
updated: 2026-05-13
---

`EthosClient` is the typed RPC client for the Ethos control-plane API. It wraps an [oRPC](https://orpc.unnoq.com/) link so every call is validated against the shared contract at compile time and at runtime.

## Source {#source}

Defined in [`packages/sdk/src/client.ts`](https://github.com/ethosagent/ethos/blob/main/packages/sdk/src/client.ts). Re-exported from `@ethosagent/sdk`.

## Installation {#install}

```bash
pnpm add @ethosagent/sdk
```

## Constructor {#constructor}

```ts
import { EthosClient } from '@ethosagent/sdk';

const client = new EthosClient({
  baseUrl: 'http://localhost:2400',
  apiKey: 'esk_...',
});
```

### EthosClientOptions {#options}

| Field | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | yes | Origin of the Ethos web-api server. Trailing slashes are stripped automatically. |
| `apiKey` | `string` | no | Bearer token created via the `apiKeys` admin namespace. When set, every request includes an `Authorization: Bearer <apiKey>` header. |
| `fetch` | `typeof globalThis.fetch` | no | Custom fetch implementation. Useful for testing or environments without a global `fetch`. Defaults to `globalThis.fetch`. |

When `apiKey` is omitted the client falls into **cookie-auth mode** -- requests are sent with `credentials: 'include'` so the browser's session cookie authenticates instead. See [Cookie-auth mode](#cookie-auth) below.

## RPC property {#rpc}

```ts
client.rpc.sessions.list({ limit: 10 });
```

`client.rpc` is a `ContractRouterClient<Contract>` -- a fully typed proxy where each namespace and method maps one-to-one to the contract defined in `@ethosagent/web-contracts`. Calls are sent as HTTP POST requests to `<baseUrl>/rpc`.

## Stable namespaces {#stable}

These namespaces are committed to semver stability. Breaking changes require a major version bump.

### sessions {#sessions}

| Method | Input | Output | Description |
|---|---|---|---|
| `list` | `{ q?, limit?, cursor?, personalityId? }` | `{ sessions, nextCursor }` | Paginated session list with optional FTS5 search. |
| `get` | `{ id }` | `{ session, messages }` | Single session with full message history. |
| `fork` | `{ id, personalityId? }` | `{ session }` | Fork an existing session into a new one. |
| `delete` | `{ id }` | `{ ok: true }` | Delete a session. |
| `update` | `{ id, title }` | `{ session }` | Rename a session. Pass `null` to clear. |

### chat {#chat}

| Method | Input | Output | Description |
|---|---|---|---|
| `send` | `{ sessionId?, clientId, text, personalityId? }` | `{ sessionId, turnId }` | Start a turn. The response streams over [SSE](./sdk-event-stream.md), not this RPC. |
| `abort` | `{ sessionId }` | `{ ok: true }` | Cancel the running turn for a session. |

### personalities {#personalities}

| Method | Input | Output | Description |
|---|---|---|---|
| `list` | -- | `{ personalities, defaultId }` | All loaded personalities. |
| `get` | `{ id }` | `{ personality, soulMd }` | Single personality with its SOUL.md body. |
| `characterSheet` | `{ id }` | `{ markdown }` | Rendered character sheet. |
| `create` | `{ id, name, ... }` | `{ personality }` | Create a new personality. |
| `update` | `{ id, name?, ... }` | `{ personality }` | Patch an existing personality. |
| `delete` | `{ id }` | `{ ok: true }` | Delete a user-created personality. |
| `duplicate` | `{ id, newId }` | `{ personality }` | Clone a personality under a new id. |
| `skillsList` | `{ personalityId }` | `{ skills }` | List per-personality skills. |
| `skillsGet` | `{ personalityId, skillId }` | `{ skill }` | Get a single personality skill. |
| `skillsCreate` | `{ personalityId, skillId, body }` | `{ skill }` | Create a personality skill. |
| `skillsUpdate` | `{ personalityId, skillId, body }` | `{ skill }` | Update a personality skill body. |
| `skillsDelete` | `{ personalityId, skillId }` | `{ ok: true }` | Delete a personality skill. |
| `skillsImportGlobal` | `{ personalityId, skillIds }` | `{ imported }` | Copy global skills into a personality. |

### memory {#memory}

| Method | Input | Output | Description |
|---|---|---|---|
| `list` | -- | `{ files }` | Both MEMORY.md and USER.md entries. |
| `get` | `{ store }` | `{ file }` | One store: `'memory'` or `'user'`. |
| `write` | `{ store, content }` | `{ file }` | Overwrite a memory store. |

### meta {#meta}

| Method | Input | Output | Description |
|---|---|---|---|
| `capabilities` | -- | `{ capabilities }` | Server capability flags (`Record<string, boolean>`). |

## Experimental namespaces {#experimental}

These namespaces may change without a major version bump. See the [stability tier table](./stability-tier-table.md) for the full list.

- **tools** -- `approve`, `deny` (tool approval workflow)
- **clarify** -- `respond` (answer a mid-turn clarification)
- **onboarding** -- `state`, `validateProvider`, `complete`
- **config** -- `get`, `update`
- **cron** -- `list`, `get`, `create`, `delete`, `pause`, `resume`, `runNow`, `history`
- **skills** -- `list`, `get`, `create`, `update`, `delete`
- **evolver** -- `configGet`, `configUpdate`, `pendingList`, `pendingApprove`, `pendingReject`, `history`
- **mesh** -- `list`, `routeTest`
- **plugins** -- `list`
- **platforms** -- `list`, `set`, `clear`, plus multi-bot CRUD for Telegram and Slack
- **batch** -- `list`, `start`, `get`, `output`
- **eval** -- `list`, `start`, `get`, `output`
- **kanban** -- `list`, `getBoard`, `updateStatus`
- **apiKeys** -- `create`, `list`, `revoke` (cookie-auth only)

## Cookie-auth mode {#cookie-auth}

When no `apiKey` is provided, `EthosClient` sends every request with `credentials: 'include'`. This lets browser-based Mission Controls authenticate via the same session cookie the Ethos web UI uses -- no API key required.

Cookie-auth is the only mode that can access the `apiKeys` admin namespace. Bearer-token auth is rejected there to prevent privilege escalation.

```ts
// Browser-side -- cookie handles auth
const client = new EthosClient({
  baseUrl: 'http://localhost:2400',
});
```

## Types re-exported from the SDK {#types}

The package re-exports key types so consumers do not need to depend on `@ethosagent/web-contracts` directly:

- `EthosClient`, `EthosClientOptions` -- client class and constructor options
- `EventStream`, `EventStreamOptions`, `EventStreamSubscription` -- SSE streaming
- `Contract`, `SseEvent`, `ApiKeyScope`, `ApiKeyMetadata` -- shared contract types
