---
title: "Tool interface reference"
description: "Tool, ToolResult, ToolContext, ToolResultReducer, and ToolResultReducerRegistry interfaces from @ethosagent/types."
kind: reference
audience: developer
slug: tool-interface
updated: 2026-05-20
---

The [tool](../../getting-started/glossary.md#tool) contract: what a tool must provide, how its results are shaped, and the reducer pipeline that trims output before it enters the context window.

## Source {#source}

[`packages/types/src/tool.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool.ts) and [`packages/types/src/tool-reducer.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool-reducer.ts). Re-exported from `@ethosagent/types`.

## ToolResult {#tool-result}

### Signature {#tool-result-signature}

```ts
import type { ToolResult } from '@ethosagent/types';

export type ToolResult =
  | {
      ok: true;
      value: string;
      structured?: Record<string, unknown>;
      cost_usd?: number;
    }
  | {
      ok: false;
      error: string;
      code: 'input_invalid' | 'not_available' | 'execution_failed' | 'STALE_WRITE';
    };
```

### Success variant {#tool-result-success}

| Field | Type | Description |
|---|---|---|
| `ok` | `true` | Discriminant. |
| `value` | `string` | Human/LLM-readable string. Always present. Post-trimmed against the per-call budget. Multimodal or structured-data tools use this as a concise text summary so the LLM can react without parsing JSON. |
| `structured` | `Record<string, unknown> \| undefined` | Optional structured payload for non-string results (image bytes as base64, tabular data, JSON documents, multi-part content). Consumers that do not know a tool's specific structured shape should ignore this field; `value` carries the authoritative summary. |
| `cost_usd` | `number \| undefined` | Dollar cost attributed to this call (paid APIs, sandbox time). Surfaced in usage telemetry. |

### Error variant {#tool-result-error}

| Field | Type | Description |
|---|---|---|
| `ok` | `false` | Discriminant. |
| `error` | `string` | Human-readable error message. Goes back to the LLM verbatim. |
| `code` | error code | Stable error class (see table below). |

### Error codes {#tool-result-error-codes}

| Code | Meaning |
|---|---|
| `input_invalid` | The LLM produced args that fail validation. |
| `not_available` | The tool is gated off (missing API key, binary, or personality allowlist). |
| `execution_failed` | Runtime failure inside `execute`. |
| `STALE_WRITE` | The file's on-disk mtime differs from the value recorded at read time; the write is refused to prevent silent clobber. |

### Notes {#tool-result-notes}

- A tool that throws is automatically converted into `{ ok: false, code: 'execution_failed', error: err.message }` by `ToolRegistry.executeParallel`.
- Always return a `ToolResult` even on partial success -- encode the partial result in `value` and explain what worked. The LLM cannot recover from a thrown exception.
- The `[truncated -- N chars total]` marker appended by the registry is part of `value`. Test fixtures should expect it.

## ToolProgressEvent {#tool-progress-event}

### Signature {#tool-progress-event-signature}

```ts
import type { ToolProgressEvent } from '@ethosagent/types';

export interface ToolProgressEvent {
  type: 'progress';
  toolName: string;
  message: string;
  percent?: number;
  audience?: 'internal' | 'user' | 'dashboard';
}
```

### Members {#tool-progress-event-members}

| Field | Type | Description |
|---|---|---|
| `type` | `'progress'` | Literal discriminant. |
| `toolName` | `string` | Name of the tool emitting the event. |
| `message` | `string` | Human-readable progress description. |
| `percent` | `number \| undefined` | Optional 0--100 completion percentage. |
| `audience` | `'internal' \| 'user' \| 'dashboard'` | Controls who sees the event. `'internal'` (default when absent): framework only (logs, telemetry, dev TUI). `'user'`: surfaced in the user-visible stream. `'dashboard'`: surfaced on operator dashboards but not to end users. See [audience boundary](../explanation/audience-boundary.md). |

### Notes {#tool-progress-event-notes}

- Channel adapters (telegram, discord, slack, whatsapp, email) and `apps/ethos/src/commands/chat.ts` must not surface `'internal'` events.
- Use `'user'` sparingly: long-running operations where silent latency would confuse the user (`read_file` reading >1 MB, multi-step `bash` commands).
- The framework never opts in for the tool -- `audience` is always a per-event decision by the tool author.

## ToolContext {#tool-context}

### Signature {#tool-context-signature}

```ts
import type { ToolContext, ToolProgressEvent } from '@ethosagent/types';

export interface ToolContext {
  sessionId: string;
  sessionKey: string;
  platform: string;
  workingDir: string;
  agentId?: string;
  personalityId?: string;
  memoryScope?: 'global' | 'per-personality';
  memoryScopeId?: string;
  teamId?: string;
  currentTurn: number;
  messageCount: number;
  abortSignal: AbortSignal;
  emit: (event: ToolProgressEvent) => void;
  resultBudgetChars: number;
  storage?: import('@ethosagent/types').Storage;
  readMtimes?: Map<string, { mtimeMs: number; readAtTurn: number }>;
  networkPolicy?: {
    allow?: string[];
    deny?: string[];
    allow_private_urls?: boolean;
  };
  kvStore?: import('@ethosagent/types').KeyValueStore;
  secretsResolver?: import('@ethosagent/types').ScopedSecretsResolver;
  scopedFetch?: import('@ethosagent/types').ScopedFetch;
  scopedFs?: import('@ethosagent/types').ScopedFs;
  scopedProcess?: import('@ethosagent/types').ScopedProcess;
  attachments?: import('@ethosagent/types').ScopedAttachments;
  dryRun?: boolean;
}
```

### Members {#tool-context-members}

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Stable id of the current [session](../../getting-started/glossary.md#session). |
| `sessionKey` | `string` | Human-meaningful session key (e.g. `cli:my-repo`). |
| `platform` | `string` | Surface the turn is running on (`cli`, `telegram`, `discord`, ...). |
| `workingDir` | `string` | Process cwd at turn start. Anchor relative paths against this. |
| `agentId` | `string \| undefined` | Stable agent identity (multi-agent / [mesh](../../getting-started/glossary.md#mesh) deployments). |
| `personalityId` | `string \| undefined` | Active [personality](../../getting-started/glossary.md#personality). Thread through to memory and storage. |
| `memoryScope` | `'global' \| 'per-personality' \| undefined` | Resolved [memory scope](../../getting-started/glossary.md#memory-scope) for this turn. |
| `memoryScopeId` | `string \| undefined` | Opaque scope id resolved by AgentLoop. When present, memory tools use it directly instead of deriving `personality:<id>` from `personalityId` and `memoryScope`. |
| `teamId` | `string \| undefined` | Active team id. Set by AgentLoop when the loop runs inside a team (`WiringConfig.teamName`). Team memory tools use this to build the `team:<id>` scope id. Absent when running solo. |
| `currentTurn` | `number` | 1-indexed [turn](../../getting-started/glossary.md#turn) counter for the session. |
| `messageCount` | `number` | Total messages in the session so far. |
| `abortSignal` | `AbortSignal` | Fires when the user cancels or the turn times out. Wire into `fetch`, child processes, anywhere blocking. |
| `emit` | `(ev: ToolProgressEvent) => void` | Emits a [`tool_progress`](./agent-event.md#tool-progress) event. See [ToolProgressEvent](#tool-progress-event). |
| `resultBudgetChars` | `number` | Maximum characters the success `value` may contain before truncation. See [tool-result-budget](../explanation/tool-result-budget.md). |
| `storage` | `Storage \| undefined` | Per-turn [Storage](./storage-interface.md) decorated with the personality's `fs_reach` allowlist. Tools that touch `~/.ethos/` must use this rather than `node:fs`. |
| `readMtimes` | `Map<string, { mtimeMs: number; readAtTurn: number }> \| undefined` | Per-run mtime registry for stale-write prevention. Populated by `read_file`; checked by `write_file` / `patch_file` before writing. Absent in tests that do not wire AgentLoop. |
| `networkPolicy` | object \| undefined | Per-personality network reach. URL-capable tools must thread this through `safeFetch` from `@ethosagent/safety-network`. |
| `kvStore` | `KeyValueStore \| undefined` | Key-value storage capability. See [tool-capabilities](./tool-capabilities.md). |
| `secretsResolver` | `ScopedSecretsResolver \| undefined` | Secrets resolution capability. See [tool-capabilities](./tool-capabilities.md). |
| `scopedFetch` | `ScopedFetch \| undefined` | Scoped HTTP fetch capability. See [tool-capabilities](./tool-capabilities.md). |
| `scopedFs` | `ScopedFs \| undefined` | Scoped filesystem capability. See [tool-capabilities](./tool-capabilities.md). |
| `scopedProcess` | `ScopedProcess \| undefined` | Scoped process execution capability. See [tool-capabilities](./tool-capabilities.md). |
| `attachments` | `ScopedAttachments \| undefined` | Attachment handling capability. See [tool-capabilities](./tool-capabilities.md). |
| `dryRun` | `boolean \| undefined` | When true, the tool should return synthetic results without performing side effects. |

### Notes {#tool-context-notes}

- `emit` defaults events to `audience: 'internal'` if the tool omits the field. Opt into `'user'` only when silent latency would confuse the user.
- `storage` is undefined in some test wirings -- tools that need filesystem access should fall back gracefully (e.g. read-only) rather than crash.
- The same `abortSignal` is passed to the LLM call. Once aborted, expect `abortSignal.aborted === true` for the rest of the turn.
- `readMtimes` enables the `STALE_WRITE` error code. Tools skip the mtime check when the map is undefined.

## Tool&lt;TArgs&gt; {#tool}

### Signature {#tool-signature}

```ts
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  capabilities: import('@ethosagent/types').ToolCapabilities;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
  isAvailable?: () => boolean;
  alwaysInclude?: boolean;
  outputIsUntrusted?: boolean;
}
```

### Members {#tool-members}

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique identifier exposed to the LLM. Conventionally snake_case (`read_file`, `web_search`). |
| `description` | `string` | One-paragraph natural-language description the LLM reads to decide when to call this tool. |
| `schema` | `Record<string, unknown>` | JSON Schema for the `args` object. The LLM sees this and constructs calls against it. |
| `toolset` | `string \| undefined` | Group label (`file`, `web`, `terminal`, ...). Used by `ToolRegistry.getForToolset` and personality toolset filtering. |
| `maxResultChars` | `number \| undefined` | Per-call output cap. Combined with the turn-wide budget: `Math.min(perCallBudget, maxResultChars ?? perCallBudget)`. See [tool-result-budget](../explanation/tool-result-budget.md). |
| `capabilities` | `ToolCapabilities` | Declares which scoped capabilities the tool requires (fs, network, process, secrets, kv). See [tool-capabilities](./tool-capabilities.md). |
| `execute` | `(args: TArgs, ctx: ToolContext) => Promise<ToolResult>` | Body. Must return a `ToolResult`; thrown errors become `code: 'execution_failed'`. |
| `isAvailable` | `() => boolean \| undefined` | Optional gate. Called every time the tool list is built -- return `false` to hide when a dependency (API key, binary) is missing. |
| `alwaysInclude` | `boolean \| undefined` | When true, the tool ignores `personality.toolset` filtering. Reserve for framework-internal tools (e.g. `get_skill`). |
| `outputIsUntrusted` | `boolean \| undefined` | When true, `AgentLoop` sanitises chat-template tokens in the success output and wraps it in `<untrusted source="..." tool="...">...</untrusted>`. Set on every tool that returns adversary-controlled content (file contents, web pages, email bodies, subprocess stdout). |

### Notes {#tool-notes}

- `TArgs` is the runtime type of the parsed `args`. The framework does not validate against `schema` -- pair the type with a Zod / Valibot parser inside `execute` if you need strict checking.
- A tool whose `name` starts with `mcp__<server>__` is treated as an MCP-server tool and gated by `personality.mcp_servers` rather than `personality.toolset`.

## ToolFilterOpts {#tool-filter-opts}

### Signature {#tool-filter-opts-signature}

```ts
import type { ToolFilterOpts } from '@ethosagent/types';

export interface ToolFilterOpts {
  allowedMcpServers?: string[];
  allowedPlugins?: string[];
}
```

### Members {#tool-filter-opts-members}

| Field | Type | Description |
|---|---|---|
| `allowedMcpServers` | `string[] \| undefined` | MCP server allowlist. Tools named `mcp__<server>__*` are excluded unless their server name is in this list. `undefined` means no MCP filter. |
| `allowedPlugins` | `string[] \| undefined` | Plugin allowlist. Tools registered by a plugin are excluded unless their `pluginId` is in this list. `undefined` allows all plugin tools. `[]` allows only built-in (non-plugin) tools. |

## ToolReducerContext {#tool-reducer-context}

### Signature {#tool-reducer-context-signature}

```ts
import type { ToolReducerContext } from '@ethosagent/types';

export interface ToolReducerContext {
  args: unknown;
  turnCount: number;
}
```

### Members {#tool-reducer-context-members}

| Field | Type | Description |
|---|---|---|
| `args` | `unknown` | The original args passed to the tool's `execute` call. Useful for reducers that need to know what was requested (e.g. a `read_file` reducer that strips differently based on the requested line range). |
| `turnCount` | `number` | Current turn count. Reducers may apply more aggressive trimming on later turns when context pressure is higher. |

## ToolResultReducer {#tool-result-reducer}

### Signature {#tool-result-reducer-signature}

```ts
import type { ToolResultReducer, ToolResult, ToolReducerContext } from '@ethosagent/types';

export interface ToolResultReducer {
  readonly toolName: string;
  reduce(result: ToolResult, ctx: ToolReducerContext): ToolResult;
}
```

### Members {#tool-result-reducer-members}

| Field | Type | Description |
|---|---|---|
| `toolName` | `readonly string` | Name of the tool this reducer applies to. Exact match -- no regex, no wildcards. |
| `reduce` | `(result: ToolResult, ctx: ToolReducerContext) => ToolResult` | Transform a tool result into a signal-only form. Must be deterministic: same input must produce same output. No LLM calls. Must not throw -- return the original result on any internal error. |

### Notes {#tool-result-reducer-notes}

- Reducers run inside `ToolRegistry.executeParallel` after `execute` returns and before the result is placed into the LLM context.
- A reducer that throws violates the contract. Defensive callers wrap the call, but the reducer itself must handle its own errors.
- Reducers must not call LLM APIs. They are a deterministic, synchronous-shaped transform (the signature is sync despite operating on `ToolResult`).

## ToolResultReducerRegistry {#tool-result-reducer-registry}

### Signature {#tool-result-reducer-registry-signature}

```ts
import type { ToolResultReducerRegistry } from '@ethosagent/types';

export interface ToolResultReducerRegistry {
  register(reducer: ToolResultReducer): () => void;
  get(toolName: string): ToolResultReducer | undefined;
}
```

### Members {#tool-result-reducer-registry-members}

| Method | Returns | Description |
|---|---|---|
| `register` | `() => void` | Register a reducer for a specific tool name. Returns a cleanup function that unregisters the reducer. Throws if a reducer for the same `toolName` is already registered -- one reducer per tool. |
| `get` | `ToolResultReducer \| undefined` | Look up the reducer for a tool by name. Returns `undefined` if no reducer is registered. |

### Notes {#tool-result-reducer-registry-notes}

- Duplicate registration throws -- this is intentional. Two reducers for the same tool would produce ambiguous output. If a plugin needs to override a built-in reducer, unregister the existing one first (via the cleanup function) then register the replacement.
- The cleanup function returned by `register` is idempotent -- calling it twice is safe.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `extensions/tools-file/src/` | `read_file`, `write_file`, `patch_file`, `search_files`. |
| `extensions/tools-terminal/src/` | `terminal` (bash subprocess). |
| `extensions/tools-web/src/` | `web_search`, `fetch_url`. |
| `extensions/tools-browser/src/` | Playwright-driven `browser_*` tools. |
| `extensions/tools-code/src/` | `lint`, `typecheck`, `run_tests`. |
| `extensions/tools-memory/src/` | `memory_read`, `memory_write`, `session_search`. |
| `extensions/tools-todo/src/` | TODO list CRUD. |
| `extensions/tools-mcp/src/` | Bridges MCP-server tools into the registry. |
| `extensions/tools-delegation/src/` | `task` -- spawns subagents. |
| `packages/core/src/tool-registry.ts` | `DefaultToolRegistry.executeParallel` invokes `execute` for every `Tool` and applies `ToolResultReducer` to results. |
| `packages/plugin-sdk/src/tool-helpers.ts` | `defineTool<TArgs>` factory + `ok` / `err` `ToolResult` shorthands. |

## See also {#see-also}

- [ToolRegistry reference](./tool-registry.md) -- `executeParallel` and the reduction pipeline.
- [Why is there an 80k tool result budget?](../explanation/tool-result-budget.md)
- [Context cost optimization](../explanation/context-cost-optimization.md) -- the seven-layer defense.
- [Tool capabilities reference](./tool-capabilities.md)
- [Architecture in 90 seconds](../../getting-started/architecture-90-seconds.md)
