---
title: "LLMProvider interface"
description: "LLMProvider.complete and the seven CompletionChunk variants every Ethos LLM provider streams."
kind: reference
audience: developer
slug: llm-provider-interface
updated: 2026-05-12
---

`LLMProvider` is the contract every Ethos LLM integration implements. `AgentLoop` calls `complete()` once per LLM round-trip and consumes the returned `AsyncIterable<CompletionChunk>` until a `done` chunk arrives.

## Source {#source}

Defined in [`packages/types/src/llm.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/llm.ts). Re-exported from `@ethosagent/types`.

## LLMProvider {#llm-provider}

### Signature {#llm-provider-signature}

```ts
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextTokens: number;
  readonly supportsCaching: boolean;
  readonly supportsThinking: boolean;
  complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk>;
  countTokens(messages: Message[]): Promise<number>;
}
```

### Members {#llm-provider-members}

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Stable provider id used in routing and telemetry (`anthropic`, `openai-compat`). |
| `model` | `string` | Default model id. May be overridden per call via `CompletionOptions.modelOverride`. |
| `maxContextTokens` | `number` | Context-window size. Used by `AgentLoop` to decide when to compact. |
| `supportsCaching` | `boolean` | True when the provider honours `CompletionOptions.cacheSystemPrompt`. |
| `supportsThinking` | `boolean` | True when the provider streams `thinking_delta` chunks for extended thinking. |
| `complete` | function | Streams a single completion. See [below](#complete). |
| `countTokens` | `(messages) => Promise<number>` | Tokeniser estimate. Used for context-window accounting before the call. |

### complete {#complete}

```ts
complete(
  messages: Message[],
  tools: ToolDefinitionLite[],
  options: CompletionOptions,
): AsyncIterable<CompletionChunk>
```

| Param | Type | Description |
|---|---|---|
| `messages` | `Message[]` | Full conversation history. Each message has `role: 'user' \| 'assistant'` and `content` which is either a string or an array of typed content blocks (text, tool_use, tool_result). |
| `tools` | `ToolDefinitionLite[]` | Filtered tool list — `{ name, description, parameters }` per tool. `AgentLoop` precomputes this via `ToolRegistry.toDefinitions(allowedTools)`. |
| `options` | `CompletionOptions` | Per-call overrides — see [below](#completion-options). |

Returns an `AsyncIterable<CompletionChunk>`. The iterable terminates after exactly one `done` chunk; consumers must not `break` early without aborting via `options.abortSignal`.

### Notes {#llm-provider-notes}

- Providers must translate provider-specific streaming events into the seven `CompletionChunk` variants. Errors should be surfaced via thrown exceptions, not via an out-of-band chunk type.
- `countTokens` may approximate. The framework uses it for budget planning, not exact cost accounting (that comes from the `usage` chunk).
- `tools` is the filtered list — do not re-filter inside the provider. If the LLM calls a tool not present in `tools`, that is a provider bug.

## CompletionOptions {#completion-options}

### Signature {#completion-options-signature}

```ts
export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingBudget?: number;
  cacheSystemPrompt?: boolean;
  abortSignal?: AbortSignal;
  stopSequences?: string[];
  modelOverride?: string;
}
```

### Members {#completion-options-members}

| Field | Type | Description |
|---|---|---|
| `system` | `string` | System prompt. Built by `AgentLoop` from `SOUL.md` + memory + injectors. |
| `maxTokens` | `number` | Maximum tokens in the response. Defaults vary by provider. |
| `temperature` | `number` | Sampling temperature. Most surfaces use `0` or `0.2`. |
| `thinkingBudget` | `number` | Token budget for extended thinking. Ignored if `supportsThinking` is false. |
| `cacheSystemPrompt` | `boolean` | Opt into provider-side prompt caching. Ignored if `supportsCaching` is false. |
| `abortSignal` | `AbortSignal` | Same signal threaded through `ToolContext.abortSignal`. Cancel the in-flight call when it fires. |
| `stopSequences` | `string[]` | Hard stop strings. Match any one and the stream ends with `done.finishReason === 'stop_sequence'`. |
| `modelOverride` | `string` | Per-call model override. Used by the routing layer to send a turn to a different model than the provider default. |

## CompletionChunk {#completion-chunk}

The streaming event type yielded by `complete()`. Seven variants.

### Signature {#completion-chunk-signature}

```ts
export type CompletionChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_delta'; toolCallId: string; partialJson: string }
  | { type: 'tool_use_end'; toolCallId: string; inputJson: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' };
```

### Variants {#completion-chunk-variants}

| `type` | When emitted | Payload |
|---|---|---|
| [`text_delta`](#text-delta) | Each chunk of assistant text. | `text: string` |
| [`thinking_delta`](#thinking-delta) | Each chunk of extended-thinking output. | `thinking: string` |
| [`tool_use_start`](#tool-use-start) | When the LLM begins a tool call. | `toolCallId`, `toolName` |
| [`tool_use_delta`](#tool-use-delta) | Streaming JSON args for the in-progress tool call. | `toolCallId`, `partialJson` |
| [`tool_use_end`](#tool-use-end) | When the LLM finishes the tool-call args. | `toolCallId`, `inputJson` |
| [`usage`](#usage) | Once, at the end of the response. | `usage: TokenUsage` |
| [`done`](#done) | Exactly once, last chunk in the stream. | `finishReason` |

#### text_delta {#text-delta}

Append `text` to the current assistant message. Whitespace is preserved as-is.

#### thinking_delta {#thinking-delta}

Extended-thinking output. Emit only when `supportsThinking` is true and `options.thinkingBudget` is set.

#### tool_use_start {#tool-use-start}

Provider has decided to call `toolName` with stable id `toolCallId`. Subsequent `tool_use_delta` chunks with the same id stream the args JSON.

#### tool_use_delta {#tool-use-delta}

Append `partialJson` to the in-progress args buffer for `toolCallId`. Providers that don't stream args may emit zero of these and supply the full payload via `tool_use_end.inputJson`.

#### tool_use_end {#tool-use-end}

The complete args JSON for `toolCallId`. After this chunk the assembled call is handed to `ToolRegistry.executeParallel`.

#### usage {#usage}

Token accounting for the call. `TokenUsage` carries `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `estimatedCostUsd`.

#### done {#done}

Final chunk. `finishReason` tells the loop whether to feed tool results back (`tool_use`) or end the turn (`end_turn`, `max_tokens`, `stop_sequence`).

### Notes {#completion-chunk-notes}

- The stream must end with exactly one `done`. Emitting `done` mid-stream truncates the response.
- `usage` typically arrives just before `done`. Providers that surface usage on the first chunk (Anthropic `message_start`) may emit it earlier — consumers should not assume order beyond `done` being last.
- `tool_use_delta` is optional. A provider that surfaces fully-formed args may emit only `tool_use_start` and `tool_use_end`.
- Provider implementations index streaming tool calls by their stable id (`toolCallId`). OpenAI streams them index-keyed on `choices[0].delta.tool_calls[index]`; the provider implementation rebuilds the id mapping from the first delta. Anthropic streams `content_block_start` / `content_block_delta` events with the id embedded.
- Cache tokens (`cacheReadTokens`, `cacheCreationTokens`) are non-zero only when `supportsCaching` is true and `options.cacheSystemPrompt` was set. Providers without cache support report `0`.

## TokenUsage {#token-usage}

```ts
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}
```

| Field | Description |
|---|---|
| `inputTokens` | Prompt tokens billed (non-cached). |
| `outputTokens` | Completion tokens billed. |
| `cacheReadTokens` | Prompt tokens served from cache. Zero when caching is off. |
| `cacheCreationTokens` | Tokens written into cache on this call. |
| `estimatedCostUsd` | Provider-side cost estimate. Surfaced in the `AgentEvent.usage` event verbatim. |

## FailoverReason {#failover-reason}

Used by `AuthRotatingProvider` and similar wrappers to decide whether to rotate auth profiles. Stable string union:

```ts
export type FailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'timeout'
  | 'network'
  | 'model_not_found'
  | 'content_filter'
  | 'unknown';
```

Providers map their error taxonomy to one of these so the wrapper logic stays provider-agnostic.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `extensions/llm-anthropic/src/index.ts` | `AnthropicProvider` — Claude models via `@anthropic-ai/sdk`. |
| `extensions/llm-anthropic/src/auth-rotating.ts` | `AuthRotatingProvider` — wraps another `LLMProvider` and rotates through auth profiles on failure. |
| `extensions/llm-openai-compat/src/index.ts` | `OpenAICompatProvider` — OpenAI / OpenRouter / Ollama / Gemini. |
| `packages/core/src/agent-loop.ts` | Calls `complete()` and translates `CompletionChunk` events into `AgentEvent`. |
| `packages/plugin-sdk/src/testing.ts` | `mockLLM(responses)` — returns a deterministic provider for plugin tests. |
| `extensions/eval-harness/src/runner.ts` | Eval runner — captures `usage` chunks for cost reporting. |

## See also {#see-also}

- [AgentEvent reference](./agent-event.md) — the surface-facing event stream `AgentLoop` builds from `CompletionChunk`.
- [Tool interface](./tool-interface.md) — `ToolDefinitionLite` mirrors `Tool.schema` for the LLM call.
- [Tutorial: add an LLM provider](../tutorials/add-an-llm-provider.md) — implement this interface end-to-end against a fake `echo` provider.
- [Glossary: Agent](../../getting-started/glossary.md#agent) — one-line definition of the construct this provider drives.
