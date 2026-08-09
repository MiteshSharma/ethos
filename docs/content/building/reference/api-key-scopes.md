---
title: "API key scopes"
description: "All API key scopes and what each one gates."
kind: reference
audience: developer
slug: api-key-scopes
updated: 2026-08-09
---

A scope is one permission on one API key. Each key carries a set of them, and the set decides which surfaces the bearer reaches: the contract namespaces on `/rpc/*`, the SSE endpoint, and the OpenAI-compatible `/v1/*` endpoints. Two mint paths issue keys from this same vocabulary — the `apiKeys.create` RPC (cookie-auth only, used by the web Settings tab) and `ethos api-key create` on the CLI.

## Source {#source}

`ApiKeyScopeSchema` is defined in [`packages/web-contracts/src/schemas.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/schemas.ts).

## Scope table {#table}

| Scope | Gates |
|---|---|
| `sessions:read` | Read access to `sessions.list` and `sessions.get`. |
| `sessions:write` | Write access to `sessions.fork`, `sessions.delete`, and `sessions.update`. |
| `chat` | The whole OpenAI-compatible surface: `/v1/models` and `/v1/chat/completions`. Asserted once at the `/v1` mount, so it covers every route under it. |
| `chat:send` | Access to `chat.send` and `chat.abort` on `/rpc/*`. |
| `personalities:read` | Read access to `personalities.list`, `personalities.get`, `personalities.characterSheet`, and personality skills read methods. |
| `memory:read` | Read access to `memory.list` and `memory.get`. |
| `memory:write` | Write access to `memory.write`. Implies `memory:read` at the server level. |
| `tools:approve` | Access to `tools.approve` and `tools.deny` for the tool approval workflow. |
| `events:subscribe` | Access to the SSE endpoint (`/sse/sessions/:sessionId`). Required for `EventStream`. |

## `chat` vs `chat:send` {#chat-scopes}

Two scopes read as "chat" and neither implies the other.

- `chat` gates `/v1/*`, the OpenAI-compatible surface. Grant it to Cursor, Aider, Open WebUI, and the OpenAI Python/Node SDKs.
- `chat:send` gates the `chat.send` and `chat.abort` RPC procedures on `/rpc/*`. Grant it to a Mission Control built on `@ethosagent/sdk`.
- A key that drives both needs both listed.
- `ethos api-key create` defaults `--scopes` to `chat`, because `/v1/*` is the surface the CLI mints keys for. The web UI has no default — pick the scopes in the create form.

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

The CLI mints from the same vocabulary, and rejects a scope that is not in the table above:

```bash
ethos api-key create --name "openai-clients" --scopes chat
```

## Minimum viable scope set {#minimum}

A Mission Control that sends messages and renders responses needs at minimum:

- `chat:send` -- to start turns
- `events:subscribe` -- to receive streamed responses
- `sessions:read` -- to list and fetch session history

An OpenAI-compatible client needs exactly one scope: `chat`.

## See also {#see-also}

- [Serve Ethos as an OpenAI-compatible backend](../how-to/openai-server-chat.md) -- the `/v1/*` surface the `chat` scope gates.
- [Migrate from cookie auth to an API key](../how-to/migrate-cookie-to-api-key.md) -- moving an existing Mission Control onto bearer tokens.
- [SDK client reference](sdk-client.md) -- the `@ethosagent/sdk` surface each `/rpc/*` scope unlocks.
