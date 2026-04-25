---
title: AgentLoop
description: The 13-step AsyncGenerator turn cycle that powers every Ethos agent.
sidebar_position: 1
---

# AgentLoop

`AgentLoop.run(text)` is an `AsyncGenerator<AgentEvent>` — a turn cycle that takes a user message and streams typed events back to the caller. Every component is injected at construction; the loop itself has no knowledge of which LLM, session store, or memory backend is in use.

## Turn cycle

Each call to `run(text)` executes these steps in order:

1. **`session_start` hooks** — `fireVoid` — side effects only (logging, analytics)
2. **`MemoryProvider.prefetch()`** — loads `MEMORY.md` + `USER.md` into the system context
3. **`ContextInjector[]`** — assembles the final system prompt from all injectors
4. **`before_prompt_build` hooks** — `fireModifying` — handlers can amend the prompt
5. **`LLMProvider.complete()`** — begins streaming; emits `text_delta` and `thinking_delta` events
6. **Tool calls** — when the LLM requests tools, `tool_use_start/delta/end` events are emitted
7. **`usage` event** — input/output tokens and estimated cost
8. **`before_tool_call` hooks** — `fireClaiming` — can reject or override tool arguments
9. **`ToolRegistry.executeParallel()`** — runs approved tools in parallel with budget splitting
10. **`after_tool_call` hooks** — `fireVoid` — side effects after tool execution
11. **Continue LLM turn** — model processes tool results, may call more tools (loop back to step 5)
12. **`MemoryProvider.sync()`** — applies `MemoryUpdate[]` from the model's memory instructions
13. **`agent_done` hooks** — `fireVoid` — session cleanup, notifications

## AgentEvent types

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

## Consuming the generator

```typescript
for await (const event of agentLoop.run('explain this codebase')) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text)
      break
    case 'tool_start':
      console.log(`\n[${event.toolName}] starting...`)
      break
    case 'tool_end':
      console.log(`[${event.toolName}] ${event.ok ? '✓' : '✗'} ${event.durationMs}ms`)
      break
    case 'usage':
      console.log(`\nTokens: ${event.inputTokens}↑ ${event.outputTokens}↓  ~$${event.estimatedCostUsd.toFixed(4)}`)
      break
    case 'done':
      console.log(`\nTurns: ${event.turnCount}`)
      break
  }
}
```

## Hook interactions

### `before_tool_call` — rejection pattern

The `before_tool_call` hook fires before `executeParallel`. To reject a tool call, the hook must:
1. Add it to a rejected list
2. Exclude it from `execInputs`
3. Still persist an error `tool_result` for the rejected call

Step 3 is critical. Anthropic requires a `tool_result` block for **every** `tool_use` block in the preceding assistant message — even rejected ones. Missing `tool_result` blocks cause API validation errors.

### `session_start` and `agent_done`

These use `fireVoid` — all handlers run in parallel via `Promise.allSettled`, failures are swallowed. Safe for logging, metrics, and notifications where a failure must not abort the agent turn.

## `AgentLoopConfig`

```typescript
interface AgentLoopConfig {
  llm: LLMProvider
  session: SessionStore
  memory: MemoryProvider
  personalities: PersonalityRegistry
  tools: ToolRegistry
  hooks: HookRegistry
  contextInjectors?: ContextInjector[]
  resultBudgetChars?: number  // default: 80_000
}
```

All fields are interfaces. Swap any component by providing a different implementation. See [Extending Ethos](/docs/extending-ethos/overview) for details.
