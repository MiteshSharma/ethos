---
title: Tool Registry
description: How executeParallel works, tool result budgets, and how to control output size.
sidebar_position: 3
---

# Tool Registry

`ToolRegistry.executeParallel()` runs all tool calls from a single LLM turn in parallel and enforces a shared output budget.

## executeParallel

When the LLM requests multiple tools in one turn (e.g., read three files simultaneously), they all execute concurrently. The `before_tool_call` hook fires for each before any execute — rejected tools are excluded from the batch.

```typescript
const results = await toolRegistry.executeParallel(toolCalls, {
  hooks,
  resultBudgetChars: 80_000,
})
```

## Result budget

The default budget is **80,000 characters** total across all concurrent tool calls in a single turn. This budget is split evenly across the tools being executed:

```
3 tools executing → 80,000 / 3 = ~26,666 chars per tool
```

If a tool's result exceeds its per-call budget, it's trimmed and appended with:

```
[truncated — 45,231 chars total]
```

This prevents runaway tool results from consuming the entire LLM context window.

## Per-tool `maxResultChars`

Tools can declare a tighter limit than their share of the budget:

```typescript
export const readFileTool: Tool<typeof schema> = {
  name: 'read_file',
  // highlight-next-line
  maxResultChars: 20_000,
  // ...
}
```

The actual per-call budget is:

```typescript
Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget)
```

A `read_file` tool with `maxResultChars: 20_000` won't produce more than 20,000 chars even if the split budget allows more.

## Adjusting the budget

Pass `resultBudgetChars` in `AgentLoopConfig`:

```typescript
const loop = new AgentLoop({
  // ...
  resultBudgetChars: 120_000,  // increase for tools with large outputs
})
```

## `isAvailable`

Tools that implement `isAvailable()` are checked at registration time. Tools returning `false` are excluded from the LLM's tool list — the model never sees them or tries to call them.

```typescript
export const browserTool: Tool<typeof schema> = {
  name: 'browser',
  isAvailable() {
    return Boolean(process.env.PLAYWRIGHT_HEADLESS)
  },
  // ...
}
```
