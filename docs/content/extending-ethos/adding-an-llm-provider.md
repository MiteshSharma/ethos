---
sidebar_position: 2
title: Adding an LLM Provider
---

# Adding an LLM Provider

An LLM provider wraps a model API and maps its streaming output to Ethos's `CompletionChunk` events. Ethos ships with Anthropic and OpenAI-compatible providers; you can add any other API using the same pattern.

## The `LLMProvider` interface

```typescript
interface LLMProvider {
  complete(params: CompletionParams): AsyncIterable<CompletionChunk>;
  countTokens?(messages: Message[]): Promise<number>;
}
```

`complete()` is the only required method. It receives a request and returns an async iterator that yields `CompletionChunk` events as they stream in.

## `CompletionChunk` events

```typescript
type CompletionChunk =
  | { type: 'text_delta';      text: string }
  | { type: 'thinking_delta';  thinking: string }
  | { type: 'tool_use_start';  toolCallId: string; toolName: string }
  | { type: 'tool_use_delta';  toolCallId: string; argsJson: string }
  | { type: 'tool_use_end';    toolCallId: string }
  | { type: 'usage';           inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'done' }
```

Your job is to map your API's streaming events to these 7 shapes.

## Step-by-step

### 1. Create the extension package

```
extensions/llm-myprovider/
├── package.json
└── src/
    └── index.ts
```

`package.json`:

```json
{
  "name": "@ethosagent/llm-myprovider",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "production": "./dist/index.js"
    }
  },
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

### 2. Implement the provider

```typescript
import type { LLMProvider, CompletionParams, CompletionChunk } from '@ethosagent/types';

export class MyProvider implements LLMProvider {
  constructor(private apiKey: string) {}

  async *complete(params: CompletionParams): AsyncIterable<CompletionChunk> {
    const stream = await myApiClient.chat.stream({
      model: params.model,
      messages: mapMessages(params.messages),
      tools: mapTools(params.tools),
      stream: true,
    });

    for await (const chunk of stream) {
      // Map to CompletionChunk events
      if (chunk.type === 'text') {
        yield { type: 'text_delta', text: chunk.delta };
      } else if (chunk.type === 'tool_call') {
        yield { type: 'tool_use_start', toolCallId: chunk.id, toolName: chunk.name };
        yield { type: 'tool_use_delta', toolCallId: chunk.id, argsJson: chunk.args };
        yield { type: 'tool_use_end', toolCallId: chunk.id };
      } else if (chunk.type === 'usage') {
        yield {
          type: 'usage',
          inputTokens: chunk.input,
          outputTokens: chunk.output,
          estimatedCostUsd: estimateCost(params.model, chunk.input, chunk.output),
        };
      }
    }

    yield { type: 'done' };
  }
}
```

### 3. Add path alias to root `tsconfig.json`

```json
{
  "compilerOptions": {
    "paths": {
      "@ethosagent/llm-myprovider": ["./extensions/llm-myprovider/src"]
    }
  }
}
```

### 4. Wire it in `apps/ethos/src/wiring.ts`

```typescript
import { MyProvider } from '@ethosagent/llm-myprovider';

// In buildAgentLoop():
if (config.provider === 'myprovider') {
  llmProvider = new MyProvider(process.env.MY_API_KEY ?? '');
}
```

### 5. Update `~/.ethos/config.yaml`

```yaml
provider: myprovider
model: my-model-name
```

## Tool call streaming: OpenAI vs Anthropic

OpenAI streams tool calls as index-keyed deltas. The first delta for a given `index` has the `id` and `name`; subsequent deltas only have `arguments`. Build a `Map<number, { id, name, args }>` keyed by index — not by `id`, which arrives late and may be empty on early deltas.

```typescript
const toolCalls = new Map<number, { id: string; name: string; args: string }>();

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (!toolCalls.has(tc.index)) {
        toolCalls.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
        yield { type: 'tool_use_start', toolCallId: tc.id ?? '', toolName: tc.function?.name ?? '' };
      }
      const entry = toolCalls.get(tc.index)!;
      entry.args += tc.function?.arguments ?? '';
      if (tc.function?.arguments) {
        yield { type: 'tool_use_delta', toolCallId: entry.id, argsJson: tc.function.arguments };
      }
    }
  }
}
```

Anthropic uses content block indexing differently — see `extensions/llm-anthropic/src/index.ts` for the reference implementation.

## Cost estimation

The `estimatedCostUsd` in the `usage` chunk is informational — it's what's shown in `/usage` output. If your provider doesn't publish pricing, return `0`. The agent continues working regardless.
