# @ethosagent/llm-openai-compat

`LLMProvider` implementation for any OpenAI-compatible Chat Completions endpoint — OpenAI itself, OpenRouter, Ollama, Google Gemini's compat shim, DeepSeek, Mistral, etc.

## Why this exists

A single OpenAI-shaped client covers most non-Anthropic providers. This package adapts that one wire format to Ethos's provider contract so the CLI can route to local Ollama, an OpenRouter aggregate, or Gemini without a per-vendor adapter. It also handles two real-world wrinkles: Gemini rejects several JSON Schema fields OpenAI accepts, and OpenAI streams tool calls indexed by position rather than ID.

## What it provides

- `OpenAICompatProvider` — implements `LLMProvider` for any base URL that speaks the OpenAI Chat Completions wire format.
- `OpenAICompatProviderConfig` — `{ name, model, apiKey, baseUrl, maxContextTokens? }`.
- `normalizeGeminiSchema` — exported helper that strips fields Gemini's compat layer rejects (`minLength`, `maxLength`, `pattern`, `format`, `$schema`, `additionalProperties`) and collapses array-typed `type` fields.

## How it works

`toOpenAIMessages` (`src/index.ts:74`) flattens Ethos's `MessageContent[]` blocks into the OpenAI shape. User `tool_result` blocks become separate `role: 'tool'` messages keyed by `tool_call_id`. Assistant messages with `tool_use` blocks become a single message with a `tool_calls` array; text and tool calls coexist on one assistant message because OpenAI requires it.

Streaming tool calls is the biggest difference from Anthropic. OpenAI delivers them as deltas on `choices[0].delta.tool_calls[index]`, where the *first* delta for a given numeric `index` carries the `id` and `name` and subsequent deltas carry only `arguments` chunks. The provider keeps a `Map<number, { id, name, args }>` keyed by index (`src/index.ts:228`) and emits `tool_use_start` once per index, `tool_use_delta` per arguments fragment, and `tool_use_end` at `finish_reason`. Do not key by `id` — it shows up late and may be empty on early deltas.

Usage arrives in its own chunk when `stream_options.include_usage: true` is set, signalled by `chunk.usage` being present and `chunk.choices[0]` being absent (`src/index.ts:234`). Cost is estimated against an `OPENAI_PRICING` prefix table; unknown models (Ollama, custom finetunes) report `0`.

If the `baseUrl` host is `generativelanguage.googleapis.com`, `normalizeGeminiSchema` is applied to every tool's `parameters` before send (`src/index.ts:207`). It recursively strips the offending keys and rewrites `type: ["string", "null"]` to the first non-`null` entry.

`countTokens` is a 4-chars-per-token approximation since OpenAI-compat providers don't expose a counting endpoint.

## Gotchas

- OpenAI's `openai@4.87+` has a peer-dep on `zod@^3`. Ethos uses `zod@4` and never touches the structured-output features that depend on zod. The conflict is silenced via `pnpm.peerDependencyRules.ignoreMissing` in the root `package.json` — leave it alone.
- The Gemini detection is host-substring-based. If a future Gemini compat URL changes, update `isGeminiEndpoint` (`src/index.ts:66`).
- `supportsCaching` and `supportsThinking` are hard-coded `false` — neither concept maps cleanly across this many backends.
- `countTokens` is an estimate, not authoritative. Don't use it for billing.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `OpenAICompatProvider`, message conversion, Gemini schema normalization, pricing table. |
