---
title: "Configure an LLM provider"
description: "Set up Anthropic, OpenAI, Codex, OpenRouter, Azure, or a local Ollama/vLLM endpoint as the Ethos provider. Includes verify and troubleshoot."
kind: how-to
audience: user
slug: configure-providers
time: "5 min"
updated: 2026-08-06
---

## Task

Point Ethos at one of the supported LLM providers — Anthropic, OpenAI, OpenAI Codex, OpenRouter, Azure OpenAI, or a local Ollama or vLLM endpoint — and verify the next chat turn routes through it.

## Result

`ethos chat` reaches the chosen provider, streams tokens back, and `ethos doctor` reports the provider as valid.

## Prereqs

- `ethos` on `PATH` (Node 24+). Run `ethos --version` to confirm.
- An API key for the provider you're configuring, or a local Ollama install if you go that route.
- Write access to `~/.ethos/config.yaml`.

## Steps

The wizard handles the common path. Drop into hand-edit only when you need a non-default base URL or you're scripting the install.

### Option A — Use the wizard

```bash
ethos setup
```

The wizard writes `~/.ethos/config.yaml` and prompts for:

- **Provider** — one of `anthropic`, `openai`, `codex`, `openrouter`, `azure`, `ollama`, `vllm`.
- **Model** — the model id for that provider (see the table below). For `azure`, this is the deployment name. For `ollama` and `vllm`, the wizard fetches the served model list from the endpoint's `GET /v1/models` and lets you pick.
- **API key** — stored locally in `~/.ethos/config.yaml`. The local providers (`ollama`, `vllm`) skip this prompt.
- **Default [personality](../../getting-started/glossary.md#personality)** — pick one of the built-ins.

To re-run only the provider step on an existing config:

```bash
ethos setup auth
ethos setup model
```

### Option B — Hand-edit the config

Open `~/.ethos/config.yaml` and set four keys. The shape is plain `key: value` — no nested YAML.

```yaml
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-XXXXXXXXXXXX
personality: researcher
```

For OpenAI-compatible providers (`openai`, `openrouter`, `ollama`, `vllm`), add `baseUrl` if you want a non-default endpoint:

```yaml
provider: openrouter
model: anthropic/claude-3.5-sonnet
apiKey: sk-or-XXXXXXXXXXXX
baseUrl: https://openrouter.ai/api/v1
personality: researcher
```

For `azure`, `baseUrl` is your resource endpoint, `model` is the deployment name, and `apiVersion` is required:

```yaml
provider: azure
model: <your-deployment-name>
apiKey: XXXXXXXXXXXX
baseUrl: https://<your-resource>.openai.azure.com
apiVersion: 2024-10-21
personality: researcher
```

### Provider matrix

| `provider` | Default base URL | Where to get a key | Notes |
|---|---|---|---|
| `anthropic` | n/a (SDK default) | [console.anthropic.com](https://console.anthropic.com) | Best fit for `claude-*` models; supports key rotation via `ethos keys`. |
| `openai` | `https://api.openai.com/v1` | [platform.openai.com](https://platform.openai.com/api-keys) | Use for `gpt-4o`, `o1`, etc. |
| `codex` | n/a — device auth | [openai.com](https://openai.com) (ChatGPT account) | Experimental; authenticates via device code, no API key. See [Use a ChatGPT subscription for coding work](use-chatgpt-subscription-via-codex). |
| `openrouter` | `https://openrouter.ai/api/v1` | [openrouter.ai/keys](https://openrouter.ai/keys) | One key for Claude, GPT, Gemini, Llama, and 200+ more. |
| `azure` | `https://<your-resource>.openai.azure.com` | [portal.azure.com](https://portal.azure.com) | `model:` is the deployment name; `apiVersion:` required (default `2024-10-21`). |
| `ollama` | `http://localhost:11434/v1` | n/a — local | No API key; the wizard offers the served model list. |
| `vllm` | `http://localhost:8000/v1` | n/a — local | No API key; the wizard offers the served model list. |

Provider strings are validated against [`packages/wiring/src/provider-catalog.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/wiring/src/provider-catalog.ts). Anything else is rejected by `ethos doctor`.

### Local endpoints (Ollama and vLLM)

Pull and run the model before pointing Ethos at it:

```bash
ollama pull llama3.1:8b
ollama serve   # leave running
```

Then in `~/.ethos/config.yaml`:

```yaml
provider: ollama
model: llama3.1:8b
apiKey: ollama
baseUrl: http://localhost:11434/v1
personality: researcher
```

For vLLM, the same shape with `provider: vllm` and `baseUrl: http://localhost:8000/v1`.

A local server needs serving flags before it works well for agent turns — context length, prefix caching, tool-call parsing. Set them per [Configure local model serving](configure-local-serving), then score the model with [Qualify a local model](qualify-a-local-model).

### Optional — a fallback chain

Stack two providers so Ethos fails over automatically when the first one rate-limits or 5xx's. The chain triggers when two or more `providers.<n>.*` blocks are present.

```yaml
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-XXXXXXXXXXXX
personality: researcher

providers.0.provider: anthropic
providers.0.apiKey: sk-ant-XXXXXXXXXXXX
providers.0.model: claude-opus-4-7

providers.1.provider: openrouter
providers.1.apiKey: sk-or-XXXXXXXXXXXX
providers.1.model: anthropic/claude-3.5-sonnet
```

The top-level `provider`, `model`, and `apiKey` keys stay in place — they're used when the chain has fewer than two entries.

## Verify

Run the health check and then one turn:

```bash
ethos doctor
```

`doctor` reports the active provider, the model, whether the SDK module is installed, and whether the API key is reachable.

Then:

```bash
ethos chat -q "respond with the single word 'ok'"
```

A streamed `ok` and a non-zero `usage` line means the provider, key, and model resolved end-to-end.

## Troubleshoot

**`Unknown provider 'foo'. Did you mean 'anthropic'?`** — `ethos doctor` rejects provider strings outside the catalog. Set `provider:` to one of `anthropic`, `openai`, `codex`, `openrouter`, `azure`, `ollama`, `vllm`.

**`401 Unauthorized` from the provider.** — The key is wrong, expired, or missing the right scope. Regenerate at the provider console and re-run `ethos setup auth`.

**`ECONNREFUSED 127.0.0.1:11434` with `provider: ollama`.** — `ollama serve` is not running. Start it in another terminal or check `lsof -i :11434`.

**`model not found` from OpenRouter.** — OpenRouter model ids are namespaced (`anthropic/claude-3.5-sonnet`, not `claude-3.5-sonnet`). Copy the exact id from the OpenRouter model page.

**Empty stream, no error.** — The base URL points at an endpoint that accepts requests but returns nothing useful (common with custom OpenAI-compatible gateways). Run `ethos doctor` and compare `baseUrl` against the provider's docs.

**Rate-limited on Anthropic.** — Add a rotation key with `ethos keys add` (Anthropic only) or fall back via the `providers.<n>` chain shown above.
