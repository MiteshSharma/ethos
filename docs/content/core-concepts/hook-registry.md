---
title: Hook Registry
description: Three hook execution models — Void, Modifying, and Claiming — and when to use each.
sidebar_position: 2
---

# Hook Registry

The hook registry lets you intercept and modify agent behaviour at specific points in the turn cycle without modifying core code. There are three execution models, each suited to a different kind of hook.

## Execution models

| Model | Method | Execution | Failure | Use for |
|---|---|---|---|---|
| Void | `fireVoid` | All handlers in parallel (`Promise.allSettled`) | Swallowed (fail-open) | Logging, analytics, notifications |
| Modifying | `fireModifying` | Sequential, results merged | Propagated | Amend prompts, override args |
| Claiming | `fireClaiming` | Sequential, stops at first `{ handled: true }` | Propagated | Routing decisions, blocking |

## Hook points in the turn cycle

| Hook point | Model | When it fires |
|---|---|---|
| `session_start` | Void | Before the turn begins |
| `before_prompt_build` | Modifying | After memory prefetch, before LLM call |
| `before_tool_call` | Claiming | Before each tool executes |
| `after_tool_call` | Void | After each tool executes |
| `agent_done` | Void | After the full turn completes |

## Registering a hook

All `register*()` methods return a cleanup function — call it to deregister:

```typescript
const unhook = hookRegistry.registerVoid('agent_done', async (ctx) => {
  await analytics.track('turn_completed', {
    sessionId: ctx.sessionId,
    turnCount: ctx.turnCount,
  })
})

// Later, when cleaning up:
unhook()
```

## Void hooks

All void handlers run in parallel. If one throws, the others still complete and the error is swallowed. Safe for any side effect that must not abort the agent.

```typescript
hookRegistry.registerVoid('session_start', async (ctx) => {
  console.log(`Session started: ${ctx.sessionId}`)
})
```

## Modifying hooks

Handlers run sequentially. Each can return a partial object; results are merged — **first non-null value per key wins**. Later handlers cannot override an earlier handler's value.

```typescript
hookRegistry.registerModifying('before_prompt_build', async (ctx) => {
  // Inject additional context into the system prompt
  return {
    additionalContext: `Today is ${new Date().toDateString()}.`,
  }
})
```

## Claiming hooks

Handlers run sequentially and stop as soon as one returns `{ handled: true }`. Designed for routing: the first handler that claims the input wins.

```typescript
// Dangerous command gate — rejects shell commands that match known destructive patterns
hookRegistry.registerClaiming('before_tool_call', async (ctx) => {
  if (ctx.toolName !== 'terminal') return { handled: false }

  const dangerous = isDangerousCommand(ctx.args.command)
  if (!dangerous) return { handled: false }

  return {
    handled: true,
    error: `Blocked: '${ctx.args.command}' matches a dangerous command pattern.`,
  }
})
```

:::warning Tool rejection requires a matching tool_result
If a `before_tool_call` hook rejects a tool, you must still persist an error `tool_result` for the rejected call. Anthropic requires a `tool_result` for every `tool_use` in the preceding assistant message — even blocked ones. The core handles this automatically when hooks return `{ handled: true, error: '...' }`.
:::
