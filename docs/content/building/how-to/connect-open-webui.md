---
title: "Connect Open WebUI to Ethos"
description: "Point Open WebUI at ethos serve's OpenAI-compatible API, with the system-prompt, tool-calling, and CORS settings it needs to work on the first request."
kind: how-to
audience: developer
slug: connect-open-webui
time: "10 min"
updated: 2026-08-19
---

## Task

Connect [Open WebUI](https://openwebui.com) — self-hosted, Dockerized, or on another machine — to a running Ethos process, so it drives a [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) through Ethos's OpenAI-compatible `/v1/*` surface.

## Result

Open WebUI's model dropdown lists your personalities plus `ethos-default`, and a chat turn streams token-by-token — with no `400`s from settings Open WebUI turns on by default.

## Prereqs

- A working Ethos install with an LLM provider configured in `~/.ethos/config.yaml` (`pnpm dev` from the monorepo, or a binary install).
- One or more personalities on disk — the built-ins ship by default.
- Open WebUI running, either via `docker run` or `pip install open-webui`.

## Steps

### 1. Mint an API key

```bash
ethos api-key create --name "open-webui"
```

```
✓ API key created  name: open-webui

  sk-ethos-abcdef...

  prefix: sk-ethos-abcdef
  scopes: chat

  This is the only time the full key is shown. Save it now.
```

`--scopes` defaults to `chat` — the only scope `/v1/*` accepts. Save the `sk-ethos-…` secret; it is not shown again (`ethos api-key list` shows the prefix and metadata, never the secret).

### 2. Boot Ethos where Open WebUI can reach it {#loopback-only-by-default}

If Open WebUI and Ethos run on the same host, outside a container, the loopback default works:

```bash
ethos serve
```

If Open WebUI runs in Docker (the common case) or on a different machine, Ethos must bind to more than loopback:

```bash
ethos serve --web-host 0.0.0.0 --web-port 3000
```

```
┌─────────────────────────────────────────────────────────────────────────┐
│ SECURITY: the web server is bound to a NON-LOOPBACK address.            │
│                                                                         │
│   bind: 0.0.0.0:3000                                                    │
│                                                                         │
│ These surfaces are now reachable from other hosts on the network:       │
│   - /v1/*   OpenAI-compatible API                                       │
│   - /rpc/*  Mission Control RPC                                         │
│   - the web UI                                                          │
│ Any personality whose toolset includes `bash` therefore exposes command │
│ execution on this host to whoever can reach this port.                  │
│                                                                         │
│ The auth cookie is marked Secure on a non-loopback bind, so the web UI  │
│ WILL NOT LOG IN over plain http. Front this port with a TLS-terminating │
│ reverse proxy and set `webBaseUrl` to its https:// URL rather than      │
│ exposing the port directly.                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

That banner is expected — it confirms the non-loopback bind, not a misconfiguration. `--web-port` defaults to `3000` either way.

**This trade-off breaks the Ethos web UI login, not `/v1/*`.** Ethos marks its dashboard's `ethos_auth` cookie `Secure` whenever the bind is non-loopback, and a browser will not send a `Secure` cookie over plain `http://`. Bearer tokens are unaffected — Open WebUI keeps working over `http://host:3000/v1` — but you lose the Ethos web dashboard at `http://<host>:3000` until you either put TLS in front of it (set `webBaseUrl: https://…` in `~/.ethos/config.yaml`) or accept that the dashboard is loopback-only. This is a deliberate security rule; it is not something to configure around.

### 3. Point Open WebUI at Ethos

In Open WebUI: **Admin Settings → Connections → OpenAI API** (or **+ Add Connection**), fill in:

| Field | Value |
|---|---|
| URL | `http://<host>:3000/v1` |
| Key | the `sk-ethos-…` secret from step 1 |

Where `<host>` depends on how Open WebUI reaches Ethos:

| Open WebUI is… | `<host>` |
|---|---|
| On the same host, outside Docker | `localhost` |
| In a Docker container, Ethos on the host | `host.docker.internal` |
| On another machine | that machine's LAN/VPN address |

Save the connection, then open **Admin Settings → Models** (or the model picker in a new chat) — your personalities and `ethos-default` should appear, sourced from `GET /v1/models`.

### 4. Clear the default system prompt

**This is the single most likely first-run failure.** Ethos rejects any request carrying a `role: "system"` message with `400 system_messages_not_supported` — the personality owns its own system prompt (`SOUL.md`), and Ethos will not silently override or merge a client-supplied one. Open WebUI ships or lets you set a system prompt in more than one place; clear all of them for the model you point at Ethos:

- **Workspace → Models → (create or edit the model) → System Prompt.** This is the per-model system prompt in the model editor's "System prompt and variables" section — leave it empty.
- **Admin Settings → Connections → your Ethos connection**, if your Open WebUI version sets a default there.
- **The active chat's model settings** (the sliders icon in chat controls) — a per-chat override takes priority over both of the above.

If a request still 400s after clearing all three, the error body's `message` field names exactly which client-visible cause it hit — read it, it is written for this.

### 5. Turn off tool/function calling

Any non-empty `tools` field, or an `assistant.tool_calls` / `role: "tool"` message, gets `400 client_tools_not_implemented` — Ethos runs tools server-side inside the agent loop and never negotiates client-owned tools. Open WebUI sends `tools` whenever a model has any of the following turned on, in **Workspace → Models → (edit) → Capabilities and bindings**:

- **Tools** — any tool bound here (e.g. Calculator)
- **Web Search**, **Code Interpreter**, **Image Generation** — each is implemented as a callable tool
- **Knowledge** in native retrieval mode (the model calls a builtin retrieval tool instead of Open WebUI pre-injecting context)

Leave all of these off (or unbound) for the model connected to Ethos. The personality's own `toolset.yaml` already decides what it can call — Open WebUI does not need to offer any.

### 6. Skip Open WebUI's embedding/RAG settings

There is no `/v1/embeddings` on Ethos — a request to it 404s. Do not point Open WebUI's **Admin Settings → Documents** embedding model at your Ethos connection. Leave Open WebUI's embedder on its own local model (the built-in `sentence-transformers` default, or any other OpenAI-compatible embedding endpoint you already run) — Open WebUI's RAG pipeline runs independently of which connection handles chat completions.

### 7. CORS — only if a browser calls `/v1/*` directly {#cors}

Open WebUI's own backend proxies requests to Ethos server-to-server, so no CORS configuration is needed for the setup above. Set `ETHOS_API_CORS_ORIGINS` (env var) or `web.corsOrigins` in `~/.ethos/config.yaml` only if some *other* client — a browser-based app calling `/v1/chat/completions` directly with `fetch()` — needs it:

```yaml
web.corsOrigins: "https://your-browser-app.example.com"
```

Comma-separate multiple origins, or use `*`. Unset means no CORS headers at all, which is what Open WebUI needs.

### 8. Optional: check support with `GET /v1/capabilities`

An advanced client (or a script wiring up a new connection) can ask what `/v1/*` supports instead of learning it from failed requests:

```bash
curl http://localhost:3000/v1/capabilities \
  -H "Authorization: Bearer sk-ethos-..."
```

```json
{
  "byok": true,
  "voice_stt": false,
  "voice_tts": false,
  "chat_completions": true,
  "embeddings": false,
  "audio_transcriptions": false,
  "client_tools": false,
  "system_messages": false
}
```

`embeddings`, `client_tools`, and `system_messages` are always `false` on this surface — steps 4–6 above are exactly why. `audio_transcriptions` flips to `true` once an STT provider is configured (`POST /v1/audio/transcriptions` accepts multipart audio uploads when it is).

## Verify

Open a new chat in Open WebUI, pick a personality from the model dropdown, and send a message. The reply streams token-by-token, the same as talking to OpenAI. To confirm the same request succeeds outside Open WebUI:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-ethos-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "ethos-default", "messages": [{"role": "user", "content": "ping"}]}' \
  | jq .choices[0].message.content
```

## Troubleshoot

**Every request 400s with `system_messages_not_supported`** — Open WebUI is still sending a system prompt. Recheck all three locations in step 4; the per-chat override in chat controls is the one people miss.

**Every request 400s with `client_tools_not_implemented`** — A capability toggle in step 5 is still on for the model (Web Search and Knowledge-native-mode are the two people forget). Turn them off in **Workspace → Models → (edit) → Capabilities and bindings**.

**Model dropdown is empty, or the connection test fails** — Confirm the URL ends in `/v1` (not just the host and port) and the key starts with `sk-ethos-`. Test the connection directly: `curl http://<host>:3000/v1/models -H "Authorization: Bearer sk-ethos-..."`.

**Open WebUI's document/RAG upload embeds against the wrong model** — Check **Admin Settings → Documents**; the embedding model there must not be the Ethos connection (step 6).

**The Ethos dashboard won't log in after `--web-host 0.0.0.0`** — Expected; see step 2. `/v1/*` and Open WebUI are unaffected.

## Other OpenAI-compatible clients

The same connection shape — base URL `http://<host>:3000/v1`, bearer key, clear the system prompt, disable client-side tools — works for any OpenAI-compatible client, including LibreChat (**Custom Endpoints** in `librechat.yaml`, with `baseURL` and `apiKey` set the same way, and its own per-preset system-prompt field cleared). Aider, Cursor, and the raw `openai` Python/Node SDKs are covered end to end in [Serve Ethos as an OpenAI-compatible backend](openai-server-chat.md), which this page assumes and links back to for the underlying mechanics — `X-Ethos-Session`, `Idempotency-Key`, sampling params, and vision content.

## See also

- [Serve Ethos as an OpenAI-compatible backend](openai-server-chat.md) — the full `/v1/*` reference this page's Open WebUI setup builds on.
- [API key scopes](../reference/api-key-scopes.md) — the `chat` scope this page's key uses, and what else a bearer token can be scoped to.
- [Glossary](../../getting-started/glossary.md#personality) — what a personality is and how `model` maps to one.
