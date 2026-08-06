---
title: "ToolRegistry reference"
description: "ToolRegistry interface and DefaultToolRegistry implementation — registration, executeParallel, reducer pipeline, budget split, and toolset filtering."
kind: reference
audience: developer
slug: tool-registry
updated: 2026-05-20
---

The [tool](../../getting-started/glossary.md#tool) registry holds every tool the agent can invoke, filters by [personality](../../getting-started/glossary.md#personality) toolset, and runs parallel execution with budget enforcement and output reduction.

## Source {#source}

Interface in [`packages/types/src/tool.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool.ts) (`ToolRegistry`, `ToolFilterOpts`). Implementation in [`packages/core/src/tool-registry.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/tool-registry.ts) (`DefaultToolRegistry`). Reducer registry in [`packages/core/src/tool-reducer-registry.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/tool-reducer-registry.ts) (`DefaultToolResultReducerRegistry`).

## ToolRegistry {#tool-registry}

### Signature {#tool-registry-signature}

```ts
import type {
  Attachment,
  Tool,
  ToolContext,
  ToolFilterOpts,
  ToolRegistry,
  ToolResult,
} from '@ethosagent/types';
import type { ToolDefinitionLite } from '@ethosagent/types';

export interface ToolRegistry {
  register(tool: Tool, opts?: { pluginId?: string }): void;
  registerAll(tools: Tool[]): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  getAvailable(): Tool[];
  getForToolset(toolset: string): Tool[];
  executeParallel(
    calls: Array<{ toolCallId: string; name: string; args: unknown }>,
    ctx: ToolContext,
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
    turnAttachments?: Attachment[],
  ): Promise<Array<{ toolCallId: string; name: string; result: ToolResult }>>;
  toDefinitions(
    allowedTools?: string[],
    filterOpts?: ToolFilterOpts,
  ): ToolDefinitionLite[];
}
```

### Methods {#tool-registry-methods}

| Method | Signature | Description |
|---|---|---|
| `register` | `(tool: Tool, opts?: { pluginId?: string }): void` | Register a tool. Optional `pluginId` tags it for per-personality plugin gating. |
| `registerAll` | `(tools: Tool[]): void` | Register multiple tools. |
| `unregister` | `(name: string): void` | Remove a tool by name. |
| `get` | `(name: string): Tool \| undefined` | Lookup by name. |
| `getAvailable` | `(): Tool[]` | All tools where `isAvailable()` returns true (or is absent). |
| `getForToolset` | `(toolset: string): Tool[]` | All tools in a given toolset group. |
| `executeParallel` | `(calls, ctx, allowedTools?, filterOpts?, turnAttachments?): Promise<...>` | Run tool calls concurrently with budget split and reduction. See [executeParallel](#execute-parallel). |
| `toDefinitions` | `(allowedTools?, filterOpts?): ToolDefinitionLite[]` | Build LLM tool definitions, filtered by personality toolset. See [toDefinitions](#to-definitions). |

## DefaultToolRegistry {#default-tool-registry}

The concrete implementation in `packages/core/src/tool-registry.ts`.

### Constructor {#default-tool-registry-constructor}

```ts
import type { CapabilityBackends } from '@ethosagent/core';
import type { ToolResultReducerRegistry } from '@ethosagent/types';

const tools = new DefaultToolRegistry(capabilityBackends?, reducerRegistry?);
```

| Parameter | Type | Description |
|---|---|---|
| `capabilityBackends` | `CapabilityBackends \| undefined` | Optional backends for tools that declare [capabilities](./tool-capabilities.md) (network, secrets, storage, fs_reach, process, attachments). |
| `reducerRegistry` | `ToolResultReducerRegistry \| undefined` | Optional registry of [result reducers](#tool-result-reducer-registry). When present, `executeParallel` applies reducers after execution and before budget trim. |

## executeParallel {#execute-parallel}

The core method. Runs every requested tool call concurrently via `Promise.allSettled`. Returns results in input order. Never throws -- failures become `{ ok: false }` results.

### Pipeline {#execute-parallel-pipeline}

1. **Budget split** -- `perCallBudget = Math.floor(ctx.resultBudgetChars / Math.max(calls.length, 1))`. Default total budget: 80,000 chars.
2. **Unknown tool check** -- If the tool name is not in the registry: `{ ok: false, error: 'Unknown tool: ...', code: 'not_available' }`.
3. **Allowlist check** -- Each call is checked against `allowedTools` + `filterOpts`. Built-in tools (not `mcp__*`, no `pluginId`) must appear in `allowedTools` when that list is non-empty. MCP and plugin tools are gated by `filterOpts` via `passesFilter()`. Rejected calls get `{ ok: false, error: '...not permitted...', code: 'not_available' }`.
4. **Availability check** -- If the tool declares `isAvailable()` and it returns `false`: `{ ok: false, error: '...not currently available', code: 'not_available' }`.
5. **Capability backend check** -- If the tool declares capabilities that need backends (`network`, `secrets`, `storage`, `fs_reach`, `process`, `attachments`) and no backends are configured: `{ ok: false, code: 'not_available' }`.
6. **Dry-run mode** -- If `ctx.dryRun`, returns a synthetic result without execution.
7. **Per-call budget** -- `Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget)`.
8. **Capability resolution** -- If the tool declares capabilities and backends are configured, backends are resolved and injected into the tool context.
9. **Execution** -- `tool.execute(args, ctx)`.
10. **Reducer pipeline** -- After execution, before budget trim. Looks up `ToolResultReducer` by tool name in the reducer registry. If found, calls `safeReduce(reducer, result, { args, turnCount })`. Safe: catches reducer errors and returns the original result.
11. **Post-trim** -- If the result value exceeds the per-call budget, truncates and appends `\n[truncated — N chars total]`.

## toDefinitions {#to-definitions}

Filters the registry by personality toolset (`allowedTools`) + MCP/plugin filters (`filterOpts`). Returns `ToolDefinitionLite[]` for the LLM request.

### Filtering gates (applied in order) {#to-definitions-gates}

1. **`isAvailable()` gate** -- Tools that declare `isAvailable` and return `false` are dropped.
2. **Toolset gate (built-in tools only)** -- Built-in tools (name does not start with `mcp__`, no `pluginId`) must appear in `allowedTools` when that list is non-empty. `alwaysInclude: true` bypasses this gate.
3. **`filterOpts` gate** -- `allowedMcpServers` filters `mcp__<server>__*` tools by server name. `allowedPlugins` filters plugin-tagged tools by `pluginId`.

Surviving entries are mapped to `{ name, description, parameters: tool.schema }`.

## DefaultToolResultReducerRegistry {#tool-result-reducer-registry}

The reducer registry implementation in `packages/core/src/tool-reducer-registry.ts`. Provides exact-match lookup of `ToolResultReducer` by tool name.

### Signature {#tool-result-reducer-registry-signature}

```ts
import type { ToolResultReducer, ToolResultReducerRegistry } from '@ethosagent/types';

export class DefaultToolResultReducerRegistry implements ToolResultReducerRegistry {
  register(reducer: ToolResultReducer): () => void;
  get(toolName: string): ToolResultReducer | undefined;
}
```

### Methods {#tool-result-reducer-registry-methods}

| Method | Signature | Description |
|---|---|---|
| `register` | `(reducer: ToolResultReducer): () => void` | Register a reducer. Throws if one is already registered for the same tool name. Returns a cleanup function that unregisters the reducer. |
| `get` | `(toolName: string): ToolResultReducer \| undefined` | Lookup reducer by tool name. Exact match. |

## Built-in reducers {#built-in-reducers}

| Reducer | Tool name | Source | Strategy |
|---|---|---|---|
| Bash reducer | `terminal` | `extensions/tools-terminal/src/reducers/bash.ts` | Recognizes `git status`, test runs, package installs; head+tail fallback for output exceeding 8 KB. |
| Read-file reducer | `read_file` | `extensions/tools-code/src/reducers/read-file.ts` | Prepends file-size hint, truncates to 200 lines on unconstrained reads (no `lineStart`/`lineEnd`). |
| Kanban-list reducer | `kanban_list` | `extensions/tools-kanban/src/reducers/kanban-list.ts` | Status counts + top 5 open tickets when list exceeds 10 items. |

## Wiring {#wiring}

How it is assembled at startup in `packages/wiring/src/index.ts`:

```ts
import { DefaultToolRegistry, DefaultToolResultReducerRegistry } from '@ethosagent/core';
import { bashReducer } from '@ethosagent/tools-terminal/reducers/bash';
import { readFileReducer } from '@ethosagent/tools-code/reducers/read-file';
import { kanbanListReducer } from '@ethosagent/tools-kanban/reducers/kanban-list';

const reducerRegistry = new DefaultToolResultReducerRegistry();
reducerRegistry.register(bashReducer);
reducerRegistry.register(readFileReducer);
reducerRegistry.register(kanbanListReducer);
const tools = new DefaultToolRegistry(capabilityBackends, reducerRegistry);
```

## See also {#see-also}

- [Tool interface reference](./tool-interface.md) -- `Tool`, `ToolResult`, `ToolResultReducer` contracts.
- [Why is there an 80k tool result budget?](../explanation/tool-result-budget.md)
- [Context cost optimization](../explanation/context-cost-optimization.md) -- the seven-layer defense.
- [HookRegistry reference](./hook-registry.md) -- the parallel registry for hooks.
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md)
