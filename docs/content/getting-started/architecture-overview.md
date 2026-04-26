---
title: Architecture Overview
description: How AgentLoop works — a 12-step AsyncGenerator turn cycle with fully injectable components.
sidebar_position: 2
---

# Architecture Overview

The core abstraction in Ethos is **`AgentLoop`** — a 12-step `AsyncGenerator<AgentEvent>` that takes a user message and streams typed events back to the caller.

Every component (`LLMProvider`, `SessionStore`, `MemoryProvider`, `PersonalityRegistry`, `ToolRegistry`, `HookRegistry`) is an interface defined in `@ethosagent/types` and injected at construction time. Core never imports concrete implementations.

## The turn cycle

```
~/.ethos/config.yaml
        │
        ▼
    wiring.ts                    assembles all components
    ├── LLMProvider              AnthropicProvider | OpenAICompatProvider
    ├── SessionStore             SQLiteSessionStore (WAL + FTS5)
    ├── MemoryProvider           MarkdownFileMemoryProvider
    └── PersonalityRegistry      FilePersonalityRegistry (mtime hot-reload)
        │
        ▼
    AgentLoop.run(text)          AsyncGenerator<AgentEvent>
    ├── session_start hooks
    ├── MemoryProvider.prefetch()    → system context
    ├── ContextInjector[]            → system prompt assembly
    ├── before_prompt_build hooks
    ├── LLMProvider.complete()       → stream chunks
    │   ├── text_delta events
    │   ├── tool_use_start/delta/end
    │   └── usage event
    ├── ToolRegistry.executeParallel()
    │   ├── before_tool_call hooks   (arg override / rejection)
    │   ├── parallel execution with budget splitting
    │   └── after_tool_call hooks
    ├── MemoryProvider.sync()
    └── agent_done hooks
```

## AgentEvent types

Every event emitted by `AgentLoop.run()` is one of these variants:

```typescript
type AgentEvent =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start';     toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress';  toolName: string; message: string; percent?: number }
  | { type: 'tool_end';       toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: 'usage';          inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error';          error: string; code: string }
  | { type: 'done';           text: string; turnCount: number }
```

Consuming the generator:

```typescript
for await (const event of agentLoop.run('explain this codebase')) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
  if (event.type === 'tool_start') console.log(`\n[${event.toolName}]`)
  if (event.type === 'done') console.log(`\nTurns: ${event.turnCount}`)
}
```

## Injection at construction

`AgentLoop` receives every component via `AgentLoopConfig`. Nothing is global. The `wiring.ts` in the CLI reads `~/.ethos/config.yaml` and wires up concrete implementations:

```typescript title="apps/ethos/src/wiring.ts"
const loop = new AgentLoop({
  llm: new AnthropicProvider({ apiKey, model }),
  session: new SQLiteSessionStore({ path: '~/.ethos/sessions.db' }),
  memory: new MarkdownFileMemoryProvider({ dir: '~/.ethos' }),
  personalities: new FilePersonalityRegistry({ dir: '~/.ethos/personalities' }),
  tools: new DefaultToolRegistry(),
  hooks: new DefaultHookRegistry(),
})
```

To use a different LLM, session store, or memory backend — implement the interface and inject it. No other code changes.

## Extension points

| Interface | Default implementation | Swap to |
|---|---|---|
| `LLMProvider` | `AnthropicProvider` | Any `LLMProvider` implementation |
| `SessionStore` | `SQLiteSessionStore` | Redis, Postgres, in-memory |
| `MemoryProvider` | `MarkdownFileMemoryProvider` | Any file format or database |
| `PersonalityRegistry` | `FilePersonalityRegistry` | Remote registry, database |
| `ToolRegistry` | `DefaultToolRegistry` | Custom tool filtering |
| `HookRegistry` | `DefaultHookRegistry` | Custom hook execution |
| `PlatformAdapter` | CLI (readline) | Telegram, Discord, Slack |

All interfaces are defined in `@ethosagent/types` with zero dependencies — any package can implement them.
