---
title: "Plugin SDK reference"
description: "EthosPlugin, EthosPluginApi, defineTool, mockLLM — the surface a plugin author imports from @ethosagent/plugin-sdk."
kind: reference
audience: developer
slug: plugin-sdk
updated: 2026-05-12
---

A [plugin](../../getting-started/glossary.md#plugin) is an npm package that exports an `EthosPlugin` and is loaded at wiring time. The SDK provides the activation API, type-safe tool helpers, and a test runtime.

## Source {#source}

[`packages/plugin-sdk/src/index.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/plugin-sdk/src/index.ts) — activation API. Tool helpers in [`tool-helpers.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/plugin-sdk/src/tool-helpers.ts) and test utilities in [`testing.ts`](https://github.com/MiteshSharma/ethos/blob/main/packages/plugin-sdk/src/testing.ts).

## EthosPlugin {#ethos-plugin}

### Signature {#ethos-plugin-signature}

```ts
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';

export interface EthosPlugin {
  activate(api: EthosPluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

### Members {#ethos-plugin-members}

| Field | Type | Description |
|---|---|---|
| `activate` | `(api) => void \| Promise<void>` | Called once on load. Register every [tool](../../getting-started/glossary.md#tool), [hook](../../getting-started/glossary.md#hook), injector, and personality here. |
| `deactivate` | `() => void \| Promise<void>` | Optional. Called on unload. Plugins do NOT need to manually unregister via this — `PluginApiImpl.cleanup()` removes everything tagged with the plugin id. Use only for external resources (open handles, sockets). |

### Minimal plugin {#minimal-plugin}

```ts
import type { EthosPlugin } from '@ethosagent/plugin-sdk';
import { defineTool, ok } from '@ethosagent/plugin-sdk';

const helloTool = defineTool<{ name: string }>({
  name: 'hello',
  description: 'Say hello.',
  schema: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  },
  async execute({ name }) {
    return ok(`Hello, ${name}!`);
  },
});

const plugin: EthosPlugin = {
  async activate(api) {
    api.registerTool(helloTool);
  },
};

export default plugin;
```

## EthosPluginApi {#ethos-plugin-api}

The activation surface. Every registration call tags the entry with the plugin's id so the loader can clean up on unload.

### Signature {#ethos-plugin-api-signature}

```ts
export interface EthosPluginApi {
  readonly pluginId: string;
  registerTool(tool: Tool): void;
  registerVoidHook<K extends keyof VoidHooks>(
    name: K,
    handler: (payload: VoidHooks[K]) => Promise<void>,
  ): void;
  registerModifyingHook<K extends keyof ModifyingHooks>(
    name: K,
    handler: (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null>,
  ): void;
  registerInjector(injector: ContextInjector): void;
  registerPersonality(config: PersonalityConfig): void;
  registerContextEngine(engine: ContextEngine): void;
}
```

### Methods {#ethos-plugin-api-methods}

| Method | Description |
|---|---|
| `pluginId` | Stable id assigned by the loader (typically the package name). Reuse for log lines so log analysis can correlate. |
| `registerTool(tool)` | Add a [`Tool`](./tool-interface.md). The tool only appears when its personality lists this plugin in `plugins:`. |
| `registerVoidHook(name, handler)` | Subscribe to a [void hook](./hook-registry.md#void-hooks). Sequential failure-isolated execution. |
| `registerModifyingHook(name, handler)` | Subscribe to a [modifying hook](./hook-registry.md#modifying-hooks). Sequential, merged results. |
| `registerInjector(injector)` | Add a `ContextInjector` that contributes to the system prompt. |
| `registerPersonality(config)` | Define a [personality](../../getting-started/glossary.md#personality) in code (no `~/.ethos/personalities/` directory needed). |
| `registerContextEngine(engine)` | E4 — register a custom context-compaction engine. Throws if the host wiring did not expose a `ContextEngineRegistry`. |

### Notes {#ethos-plugin-api-notes}

- `ContextEngine` has two required members (`name`, `compact`) and two optional ones. `shouldCompact` is declared and conformance-tested but **not wired** — the framework never calls it. `onTurnComplete` **is** wired: it fires at the end of every turn, before the framework's turn-end auto-compaction and memory-flush gates, and lets an engine nominate stale `tool_use` ids for content-only trimming. Both are optional, so an engine built against an older SDK keeps compiling.
- `registerClaimingHook` is NOT exposed. Claiming hooks are gateway-level routing decisions that must be coordinated centrally; plugins cannot register them.
- Personalities registered via `registerPersonality` are NOT removed on plugin unload (the underlying registry has no `unregister`). They persist in memory until the process exits. Treat them as additive.
- Per-personality gating is enforced by the `pluginId` tag. A plugin's tools / hooks fire only when the active personality lists the plugin in `personality.plugins:`.

## defineTool {#define-tool}

Type-safe `Tool<TArgs>` factory.

### Signature {#define-tool-signature}

```ts
import { defineTool } from '@ethosagent/plugin-sdk';

export function defineTool<TArgs = unknown>(def: ToolDefinition<TArgs>): Tool<TArgs>;

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  toolset?: string;
  maxResultChars?: number;
  isAvailable?: () => boolean;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>;
}
```

### Notes {#define-tool-notes}

- Identical to writing a `Tool` literal — pure types, no runtime wrapping.
- The generic `TArgs` flows into `execute(args, ctx)` so `args` is typed inside the function body.
- See the [Tool interface reference](./tool-interface.md#tool) for the full set of `Tool` fields (`outputIsUntrusted`, `alwaysInclude`); `ToolDefinition` exposes the subset plugins normally need.

## ok / err {#ok-err}

`ToolResult` shorthands.

### Signature {#ok-err-signature}

```ts
import { ok, err } from '@ethosagent/plugin-sdk';

export function ok(value: string): ToolResult;
export function err(
  error: string,
  code?: 'input_invalid' | 'not_available' | 'execution_failed',
): ToolResult;
```

`err`'s `code` defaults to `'execution_failed'`. Pass `'input_invalid'` when the LLM provided bad args, `'not_available'` when a dependency is missing.

## Test utilities {#test-utilities}

Importable from `@ethosagent/plugin-sdk/testing`.

### mockLLM {#mock-llm}

```ts
import { mockLLM } from '@ethosagent/plugin-sdk/testing';

const llm = mockLLM(['Hello!', 'Goodbye.']);
```

Returns an `LLMProvider` that streams the given strings in order, one `text_delta` chunk + one `done` chunk per response. `callCount` cycles modulo the array length.

### mockTool {#mock-tool}

```ts
import { mockTool } from '@ethosagent/plugin-sdk/testing';

const t1 = mockTool('greeter', 'Hello, world!');
const t2 = mockTool('fail', { ok: false, error: 'boom', code: 'execution_failed' });
```

Creates a `Tool` whose `execute` always returns the given `ToolResult`. Pass a string as shorthand for `{ ok: true, value: string }`.

### createTestRuntime {#create-test-runtime}

```ts
import { createTestRuntime, mockLLM } from '@ethosagent/plugin-sdk/testing';

const loop = createTestRuntime({ llm: mockLLM(['Hello!']) });
for await (const event of loop.run('hi')) {
  if (event.type === 'done') console.log(event.text);
}
```

Constructs a minimal `AgentLoop` for plugin tests. `tools` defaults to a fresh `DefaultToolRegistry`, `hooks` to a fresh `DefaultHookRegistry`; everything else passes through to `AgentLoopConfig`.

## Re-exported types {#re-exported-types}

The SDK re-exports common types from `@ethosagent/types` so plugin authors only need one import:

```ts
import type {
  ContextInjector,
  InjectionResult,
  ModifyingHooks,
  PersonalityConfig,
  PromptContext,
  Tool,
  ToolContext,
  ToolResult,
  VoidHooks,
} from '@ethosagent/plugin-sdk';
```

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `extensions/plugin-loader/src/` | Discovers npm packages, instantiates `PluginApiImpl`, calls `activate`. |
| `apps/ethos/src/wiring.ts` | Wires the plugin loader's registries into `AgentLoop`. |
| Third-party plugin packages | Import `@ethosagent/plugin-sdk` to register their tools, hooks, injectors. |

## See also {#see-also}

- [Tool interface](./tool-interface.md) — the `Tool<TArgs>` contract `defineTool` constructs and `register.tool` accepts.
- [HookRegistry reference](./hook-registry.md) — every hook point a plugin can attach to via `register.hook`.
- [ToolRegistry reference](./tool-registry.md) — how registered tools get filtered against `personality.toolset` at execution time.
- [How to publish a plugin](../how-to/publish-a-plugin.md) — package, version, and ship a plugin to npm.
- [Glossary: Plugin](../../getting-started/glossary.md#plugin) — one-line definition of the unit a plugin author publishes.
