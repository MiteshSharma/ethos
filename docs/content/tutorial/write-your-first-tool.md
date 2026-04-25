---
title: Write Your First Tool
description: Implement the Tool interface, handle results, and register your tool with Ethos.
sidebar_position: 3
---

# Write Your First Tool

:::info ~10 min
Prerequisite: completed [Create a custom personality](./create-a-custom-personality).
:::

Tools are the way agents take actions — read files, run shell commands, search the web. This tutorial walks through building a simple tool from scratch.

## The Tool interface

Every tool implements `Tool<TArgs>` from `@ethosagent/types`:

```typescript
interface Tool<TArgs extends ZodSchema> {
  name: string            // unique identifier used in toolset.yaml
  description: string     // shown to the LLM to decide when to use this tool
  schema: TArgs           // Zod schema for argument validation
  toolset: string         // group name (e.g. 'web', 'file', 'terminal')
  maxResultChars?: number // optional output limit
  isAvailable?(): boolean // gate on env vars or services
  execute(args: z.infer<TArgs>, ctx: ToolContext): Promise<ToolResult>
}
```

`ToolResult` is a discriminated union:

```typescript
type ToolResult =
  | { ok: true;  value: string }
  | { ok: false; error: string; code: string }
```

## Build a "current time" tool

```typescript title="extensions/tools-custom/src/current-time.ts"
import { z } from 'zod'
import type { Tool, ToolResult } from '@ethosagent/types'

const schema = z.object({
  timezone: z.string().optional().describe('IANA timezone name, e.g. America/New_York'),
})

export const currentTimeTool: Tool<typeof schema> = {
  name: 'current_time',
  description: 'Returns the current date and time, optionally in a specific timezone.',
  schema,
  toolset: 'utility',

  execute(args): Promise<ToolResult> {
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: args.timezone ?? 'UTC',
    }
    try {
      const formatted = new Intl.DateTimeFormat('en-US', options).format(new Date())
      return Promise.resolve({ ok: true, value: formatted })
    } catch {
      return Promise.resolve({
        ok: false,
        error: `Invalid timezone: ${args.timezone}`,
        code: 'INVALID_TIMEZONE',
      })
    }
  },
}
```

## Register the tool

Pass your tool to `DefaultToolRegistry` when wiring up `AgentLoop`:

```typescript title="apps/ethos/src/wiring.ts"
import { currentTimeTool } from '@ethosagent/tools-custom'

const tools = new DefaultToolRegistry([
  ...defaultTools,
  currentTimeTool,  // highlight-next-line
])
```

## Add it to a personality toolset

```yaml title="~/.ethos/personalities/strategist/toolset.yaml"
tools:
  - web_search
  - read_file
  - memory
  - current_time   # your new tool
```

## Test it

```
/personality strategist

> What time is it in Tokyo?

[current_time] Tokyo time...

It is currently Wednesday, April 25, 2026 at 2:47 PM Japan Standard Time.
```

## The result budget

`AgentLoop` sets a total result budget of 80,000 characters split evenly across concurrent tool calls. If your tool returns large output, set `maxResultChars`:

```typescript
export const readFileTool: Tool<typeof schema> = {
  name: 'read_file',
  maxResultChars: 20_000,  // highlight-next-line
  // ...
}
```

If the result exceeds the budget, it's trimmed with `[truncated — N chars total]` appended.

## Using `isAvailable`

Gate a tool on an environment variable:

```typescript
export const someApiTool: Tool<typeof schema> = {
  name: 'some_api',
  isAvailable() {
    return Boolean(process.env.SOME_API_KEY)
  },
  // ...
}
```

Tools that return `false` from `isAvailable()` are excluded from the LLM's tool list entirely.
