# @ethosagent/llm-anthropic

`LLMProvider` implementation for Anthropic's Messages API, with optional auth-key rotation on auth/rate-limit/overload failures.

## Why this exists

`@ethosagent/core`'s `AgentLoop` is provider-agnostic — it talks to whatever satisfies the `LLMProvider` contract from `@ethosagent/types`. This package supplies that contract for Claude models, mapping Anthropic's streaming events to the seven-variant `CompletionChunk` discriminated union and translating Ethos's `Message[]`/`MessageContent[]` shapes into Anthropic's `MessageParam[]`/`ContentBlockParam[]`. Without it, the CLI cannot talk to Claude.

## What it provides

- `AnthropicProvider` — single-key provider. Streams text, tool use, thinking, and usage events.
- `AuthRotatingProvider` — wraps multiple `AnthropicProvider` instances; rotates on `auth`, `rate_limit`, or `overloaded` (HTTP 529) errors and gives up only after a full rotation.
- `AnthropicProviderConfig` — `{ apiKey, model, baseUrl? }`.
- `toAnthropicMessages` — exported helper used internally and by `countTokens`.

## How it works

`AnthropicProvider.complete()` (`src/index.ts:156`) builds the request params, calls `client.messages.stream(...)`, then dispatches on event type. Cache token fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) live on `message_start.usage` — they are not in the SDK's `Usage` type, so the code casts to read them (`src/index.ts:206`). Output tokens come later on `message_delta`, where the `usage` chunk is finally emitted with the cost estimate.

Tool use is streamed as three discrete events: `content_block_start` (id + name) → repeated `content_block_delta` of type `input_json_delta` (partial JSON) → `content_block_stop`. These map to `tool_use_start`, `tool_use_delta`, `tool_use_end`. Thinking deltas arrive as `content_block_delta` with type `thinking_delta` and are forwarded to the loop verbatim.

`isThinkingModel()` (`src/index.ts:31`) gates the extended-thinking opt-in to `claude-3-7`, `claude-opus-4`, and `claude-sonnet-4` model strings. When enabled and `options.thinkingBudget > 0`, `params.thinking = { type: 'enabled', budget_tokens }` is added — typed as `any` because the SDK has not exported these fields yet (`src/index.ts:180`).

`AuthRotatingProvider` (`src/index.ts:299`) sorts profiles by `priority` (high-first) at construction, then on each `complete()` call iterates from the current index forward. `classifyError()` decides whether the failure is rotation-eligible — anything other than `auth`/`rate_limit`/`overloaded` is rethrown immediately. After a full rotation back to `startIdx` it gives up and rethrows the last error.

Cost is estimated from a per-model-prefix `PRICING` table (`src/index.ts:40`); unknown prefixes fall back to the Sonnet rate. The `200_000` token context is a flat default for all current Claude models.

## Gotchas

- Cache token fields are on `message_start`, not `message_delta`. The cast at `src/index.ts:206` is intentional — do not "type-narrow" it without adding the fields back.
- Extended-thinking params (`thinking`, `betas`) are not in `MessageStreamParams`. The `// biome-ignore lint/suspicious/noExplicitAny` is required.
- `AuthRotatingProvider.model` etc. reflect the *current* provider; if rotation has happened the answer changes mid-session.
- Pricing is hand-maintained at the top of the file. Update it when Anthropic does.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `AnthropicProvider`, `AuthRotatingProvider`, message conversion, cost estimation. |
