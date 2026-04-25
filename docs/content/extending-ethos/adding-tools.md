---
sidebar_position: 3
title: Adding Tools
---

# Adding Tools

Tools are the actions your agent can take — reading files, searching the web, running shell commands. Each tool is a typed class that implements the `Tool<TArgs>` interface.

## The `Tool` interface

```typescript
interface Tool<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  toolset?: string;
  maxResultChars?: number;
  isAvailable?(): boolean | Promise<boolean>;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Unique identifier — the LLM calls this by name |
| `description` | yes | Shown to the LLM; write it as a capability statement |
| `inputSchema` | yes | JSON Schema defining the args the LLM must pass |
| `toolset` | no | Logical group for personality-based filtering (`'file'`, `'web'`, etc.) |
| `maxResultChars` | no | Hard cap on result length; excess is trimmed and marked |
| `isAvailable()` | no | Return `false` to hide the tool when env vars are missing |
| `execute()` | yes | The actual implementation |

## `ToolResult`

```typescript
type ToolResult =
  | { ok: true;  value: string }
  | { ok: false; error: string; code: string }
```

Always return a result — never throw. An `ok: false` result is shown to the LLM as an error message so it can recover or report the failure.

## Example: `current_time` tool

```typescript
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

interface CurrentTimeArgs {
  timezone?: string;
}

export const currentTimeTool: Tool<CurrentTimeArgs> = {
  name: 'current_time',
  description: 'Returns the current date and time, optionally in a given IANA timezone.',
  toolset: 'utility',
  maxResultChars: 200,

  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name, e.g. "America/New_York". Defaults to UTC.',
      },
    },
  },

  async execute(args: CurrentTimeArgs, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const tz = args.timezone ?? 'UTC';
      const now = new Date().toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' });
      return { ok: true, value: now };
    } catch (err) {
      return { ok: false, error: `Invalid timezone: ${args.timezone}`, code: 'INVALID_TIMEZONE' };
    }
  },
};
```

## Registering your tool

### Via `ToolRegistry`

```typescript
import { DefaultToolRegistry } from '@ethosagent/core';
import { currentTimeTool } from './current-time';

const toolRegistry = new DefaultToolRegistry();
toolRegistry.register(currentTimeTool);
```

Then pass `toolRegistry` to `AgentLoop`:

```typescript
const loop = new AgentLoop({
  ...config,
  toolRegistry,
});
```

### Via plugin

Wrap your tool in a plugin to make it distributable as an npm package:

```typescript
import type { Plugin } from '@ethosagent/types';
import { currentTimeTool } from './current-time';

export const utilityPlugin: Plugin = {
  name: '@myorg/ethos-utility-tools',
  version: '1.0.0',
  tools: [currentTimeTool],
  hooks: [],
};
```

See [Plugin SDK](./plugin-sdk) for packaging and distribution.

## Tool budget

`AgentLoop` sets `resultBudgetChars: 80_000` by default. When multiple tools run in parallel, this budget is split evenly across concurrent calls. Each tool's result is trimmed at `Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget)` chars and marked `[truncated]`.

Set a conservative `maxResultChars` on any tool that can return large outputs (files, API responses, HTML pages). This protects the context window from being consumed by a single large result.

## Async and side effects

`execute()` is fully async — you can make HTTP requests, read files, run subprocesses. Just:

1. Return `{ ok: false, error, code }` on failure instead of throwing
2. Respect `ctx.signal` for cancellation if your operation is long-running

```typescript
async execute(args, ctx): Promise<ToolResult> {
  const res = await fetch(args.url, { signal: ctx.signal });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, code: 'HTTP_ERROR' };
  }
  return { ok: true, value: await res.text() };
}
```

## `isAvailable()`

Use `isAvailable()` to hide a tool when its dependencies aren't configured:

```typescript
isAvailable() {
  return Boolean(process.env.OPENWEATHER_API_KEY);
}
```

The tool won't appear in the LLM's tool list if this returns `false`. This prevents the LLM from attempting calls that will always fail.

## Tool naming conventions

- Use `snake_case` for tool names: `read_file`, `search_web`, `run_shell`
- Keep `description` under 200 chars — it's included in every prompt
- Name args descriptively: `file_path` not `path`, `search_query` not `q`
