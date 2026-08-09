---
title: "Serve Ethos as an OpenAI-compatible backend"
description: "Boot ethos serve with the web API enabled, point any OpenAI SDK or client at /v1/chat/completions, and route requests to a personality."
kind: how-to
audience: developer
slug: openai-server-chat
time: "10 min"
updated: 2026-05-17
---

## Task

Point any OpenAI-compatible client — `openai` Python SDK, `openai` Node SDK, Aider, Cursor, custom code — at a running Ethos process. The client thinks it is talking to OpenAI. Your [personality](../../getting-started/glossary.md#personality) picks the actual model and toolset.

## Result

`POST /v1/chat/completions` accepts a bearer token, resolves the `model` field to a personality, and streams (or returns) the assistant's response in the OpenAI wire shape.

## Prereqs

- A working Ethos install (`pnpm dev` from the monorepo or a binary install).
- An LLM provider configured in `~/.ethos/config.yaml`.
- One or more personalities on disk (the built-ins ship by default).

## Steps

### 1. Boot the server

```bash
ethos serve --web-port 3000
```

What this gives you:

- `http://localhost:3000/v1/models` — catalog of personalities in OpenAI shape. `GET /v1/models/{id}` returns one entry.
- `http://localhost:3000/v1/chat/completions` — streaming or non-streaming chat.
- The ACP server still runs on `--port 3001` (default).

Both surfaces share the same `sessions.db`, so anything you mint with `ethos api-key` is honored here.

### 2. Mint an API key for the chat scope

`/v1/*` is bearer-gated. Mint a key from the CLI:

```bash
ethos api-key create --name "openai-clients"
```

`--scopes` defaults to `chat`, which is the scope `/v1/chat/completions` requires. The output is shown once:

```
✓ API key created  name: openai-clients

  sk-ethos-abcdef...

  prefix: sk-ethos-abcdef
  scopes: chat
```

Store the secret. You can list keys later (`ethos api-key list`) but the full secret never reappears.

### 3. Try it with curl

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ethos-default",
    "messages": [{"role": "user", "content": "Hello in one word."}]
  }'
```

`ethos-default` is the alias that resolves to whatever `personality` is in `~/.ethos/config.yaml`. To target a specific personality:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "researcher", "messages": [...]}'
```

List every valid `model` id with `GET /v1/models`.

### 4. Point an OpenAI SDK at it

#### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="sk-ethos-...",
)

resp = client.chat.completions.create(
    model="ethos-default",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

#### Node

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: process.env.ETHOS_API_KEY,
});

const stream = await client.chat.completions.create({
  model: 'ethos-default',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0].delta.content ?? '');
}
```

#### Aider, Cursor, and other clients

Set the OpenAI base URL to `http://localhost:3000/v1` and the API key to your `sk-ethos-...` secret. Most clients expose these as `OPENAI_BASE_URL` / `OPENAI_API_KEY` environment variables.

### 5. Pick the right `model`

The `model` field maps to one of three shapes, resolved in `apps/web-api/src/routes/openai/chat.ts`:

| Value | Resolves to |
|---|---|
| `ethos-default` | The personality named in `~/.ethos/config.yaml`. Useful when the client cannot be re-configured per call. |
| `<personality-id>` (e.g. `researcher`) | A loaded personality. The id must match an entry from `GET /v1/models`. |
| `team:<name>` | Reserved for team routing. Currently rejected with `400 team_routing_not_implemented`. |

The personality's `toolset.yaml`, model routing, and memory scope all apply transparently. The OpenAI client never sees that part.

### 6. Pin a session across calls

By default each request starts a fresh session. To keep history across calls, pass the `X-Ethos-Session` header:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "X-Ethos-Session: my-aider-session" \
  -H "Content-Type: application/json" \
  -d '{"model": "ethos-default", "messages": [...]}'
```

Reuse the same value across calls and Ethos appends to the same conversation. This is the bridge between OpenAI's stateless wire shape and Ethos's persistent sessions.

## Verify

A non-streaming call returns a `chat.completion` object with `choices[0].message.content` populated:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "ethos-default", "messages": [{"role": "user", "content": "ping"}]}' \
  | jq .choices[0].message.content
```

A streaming call (`"stream": true`) returns `text/event-stream` with `data: {...}` frames terminated by `data: [DONE]`.

## Non-goals (explicit rejections)

The route rejects features that are not yet implemented, with a precise OpenAI-shaped error so clients fail loudly:

| Request shape | Error code | Why |
|---|---|---|
| `tools: [...]` non-empty | `client_tools_not_implemented` | Client-tools mode lands in a later release. Drop the `tools` field. |
| `messages` contains `role: "tool"` | `client_tools_not_implemented` | Same reason. |
| `messages` contains `assistant.tool_calls` | `client_tools_not_implemented` | Same reason. |
| `model` starts with `team:` | `team_routing_not_implemented` | Team routing not wired yet. Use a personality id. |
| `model` is unknown | `model_not_found` (404) | Not in the personalities list or the `ethos-default` alias. |
| `content` is an array (vision parts) | Schema validation failure (400) | Only `string` content is accepted today. |

`system` messages, `temperature`, and `max_tokens` are accepted but ignored — the personality's system prompt prevails and sampling is not yet forwarded. Each ignored field generates an `x-ethos-warning` response header so the client knows the request was best-effort, not literal.

## Troubleshooting

**`401 invalid_api_key`** — `Authorization` header is missing, malformed, or the key is unknown. Confirm it starts with `Bearer sk-ethos-` and that `ethos api-key list` shows it as active.

**`403 insufficient_scope`** — The key is missing the `chat` scope. Re-mint with `ethos api-key create --name <label> --scopes chat`.

**`404 model_not_found`** — `model` is not a known personality id. Call `GET /v1/models` to list valid ids. The `ethos-default` alias is always available.

**`400 team_routing_not_implemented`** — Drop the `team:` prefix; use a personality id directly.

**The server runs but `/v1/*` returns 404** — Ensure you are running a current version of Ethos. The web API (including the OpenAI surface) always mounts with `ethos serve`.

## See also

- [Mint a Mission Control API key and build a dashboard](../tutorials/build-custom-dashboard.md) — control-plane SDK for richer UIs.
- [API key scopes](../reference/api-key-scopes.md) — the full scope set the bearer middleware honors.
- [Personalities reference](../reference/personality-registry.md) — what gets exposed as a `model` id.
