---
title: "API key scopes"
description: "All API key scopes and what each one gates."
kind: reference
audience: developer
slug: api-key-scopes
updated: 2026-05-13
---

API keys are created via the `apiKeys.create` RPC (cookie-auth only). Each key carries a set of scopes that determine which contract namespaces the bearer can access.

## Source {#source}

`ApiKeyScopeSchema` is defined in [`packages/web-contracts/src/schemas.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/schemas.ts).

## Scope table {#table}

| Scope | Gates |
|---|---|
| `sessions:read` | Read access to `sessions.list` and `sessions.get`. |
| `sessions:write` | Write access to `sessions.fork`, `sessions.delete`, and `sessions.update`. |
| `chat:send` | Access to `chat.send` and `chat.abort`. |
| `personalities:read` | Read access to `personalities.list`, `personalities.get`, `personalities.characterSheet`, and personality skills read methods. |
| `memory:read` | Read access to `memory.list` and `memory.get`. |
| `memory:write` | Write access to `memory.write`. Implies `memory:read` at the server level. |
| `tools:approve` | Access to `tools.approve` and `tools.deny` for the tool approval workflow. |
| `events:subscribe` | Access to the SSE endpoint (`/sse/sessions/:sessionId`). Required for `EventStream`. |

## ApiKeyMetadata {#metadata}

When you create or list keys, each key returns an `ApiKeyMetadata` object:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique key identifier. |
| `prefix` | `string` | First characters of the key (e.g. `esk_abc...`) for identification without exposing the secret. |
| `name` | `string` | Human-readable label set at creation. |
| `scopes` | `ApiKeyScope[]` | Scopes granted to this key. |
| `allowedOrigins` | `string[]` | Origins permitted to use this key (CORS enforcement). |
| `createdAt` | `string` | ISO-8601 creation timestamp. |
| `lastUsed` | `string \| null` | ISO-8601 timestamp of last use, or `null` if never used. |
| `revokedAt` | `string \| null` | ISO-8601 timestamp of revocation, or `null` if active. |

## Creating a key {#creating}

The `apiKeys` namespace is restricted to cookie-auth. A bearer token cannot mint new keys.

```ts
import { EthosClient } from '@ethosagent/sdk';

// Cookie-auth -- browser context
const client = new EthosClient({ baseUrl: 'http://localhost:2400' });

const { secret, key } = await client.rpc.apiKeys.create({
  name: 'my-dashboard',
  scopes: ['sessions:read', 'chat:send', 'events:subscribe'],
  allowedOrigins: ['https://dashboard.example.com'],
});

// `secret` is the plaintext key -- shown once, never again.
// `key` is the ApiKeyMetadata for the new key.
```

## Minimum viable scope set {#minimum}

A Mission Control that sends messages and renders responses needs at minimum:

- `chat:send` -- to start turns
- `events:subscribe` -- to receive streamed responses
- `sessions:read` -- to list and fetch session history
