---
title: "Publish a plugin"
description: "Package a plugin against the EthosPlugin contract, register tools, hooks, providers, and ship it to npm so the loader picks it up."
kind: how-to
audience: developer
slug: publish-a-plugin
time: "15 min"
updated: 2026-05-12
---

## Task

Build, package, and publish an Ethos [plugin](../../getting-started/glossary.md#plugin) to npm so any user can install it with `ethos plugin install <pkg>` and the loader registers its tools, hooks, and providers at startup.

## Result

A package named `ethos-plugin-<name>` (or `@<scope>/ethos-plugin-<name>`) on npm. After `ethos plugin install <pkg>`, the [tool](../../getting-started/glossary.md#tool), [hook](../../getting-started/glossary.md#hook), and [personality](../../getting-started/glossary.md#personality) registrations the plugin declares appear in `ethos doctor` and become reachable to any personality whose toolset and plugin allowlist include them.

## Prereqs

- Node 24+ and pnpm (or npm) on `PATH`.
- An npm account with publish rights to your scope; `npm whoami` returns your handle.
- Ethos checked out or installed locally — you'll import types from `@ethosagent/plugin-sdk` (`workspace:*` if you're inside the monorepo, otherwise a published version).
- A clear idea of what the plugin adds: one to five tightly related tools, hooks, or providers. Anything broader belongs in two plugins.

## Steps

### 1. Scaffold the package

```bash
mkdir ethos-plugin-myplugin
cd ethos-plugin-myplugin
pnpm init
```

Set the `name`, `description`, the `ethos.type` manifest field, and the contract major. `PLUGIN_CONTRACT_MAJOR` in `@ethosagent/plugin-contract` is currently `4`. The loader accepts any `ethos.pluginContractMajor` inside the inclusive supported range — `2` through `4` today — and rejects anything outside it.

```json
{
  "name": "@yourscope/ethos-plugin-myplugin",
  "version": "0.1.0",
  "description": "Adds X to Ethos via a single tool.",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "keywords": ["ethos", "ethos-plugin"],
  "ethos": {
    "type": "plugin",
    "pluginContractMajor": 4
  },
  "peerDependencies": {
    "@ethosagent/plugin-sdk": ">=0.1.0",
    "@ethosagent/types": ">=0.1.0"
  },
  "devDependencies": {
    "@ethosagent/plugin-sdk": "^0.1.0",
    "@ethosagent/types": "^0.1.0",
    "tsup": "^8",
    "typescript": "^5",
    "vitest": "^4"
  }
}
```

Package names starting with `ethos-plugin-` or scoped under `@ethos-plugins/` are auto-discovered when the user runs `ethos plugin install`. Other names work too, but the user must add them by full id to `~/.ethos/config.yaml`.

### 2. Define the plugin module

Every plugin exports an `activate(api)` function. The loader instantiates one `EthosPluginApi` per plugin, calls `activate`, and tracks every registration so `unload()` can remove it later.

```ts title="src/index.ts"
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, ok } from '@ethosagent/plugin-sdk/tool-helpers';

const greetTool = defineTool<{ name: string }>({
  name: 'greet',
  description: 'Greet someone by name.',
  toolset: 'hello',
  schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  async execute({ name }) {
    return ok(`Hello, ${name}.`);
  },
});

async function onSessionStart(payload: {
  sessionId: string;
  platform: string;
}): Promise<void> {
  console.error(`[myplugin] session ${payload.sessionId} on ${payload.platform}`);
}

export function activate(api: EthosPluginApi): void {
  api.registerTool(greetTool);
  api.registerVoidHook('session_start', onSessionStart);
}

export function deactivate(): void {
  // Tools and hooks are removed by PluginApiImpl.cleanup() automatically.
  // Only release external resources here (DB pools, timers, sockets).
}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

`EthosPluginApi` exposes 28 registration methods. The six you are most likely to start with are `registerTool`, `registerVoidHook`, `registerModifyingHook`, `registerInjector`, `registerPersonality`, and `registerContextEngine`. See the [plugin SDK reference](../reference/plugin-sdk.md) for the full list and signatures.

### 3. Add build config

The plugin ships compiled ESM with type declarations. The Ethos loader does a dynamic `import()` of `dist/index.js`.

```ts title="tsup.config.ts"
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
});
```

```json title="tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

### 4. Write tests against real registries

Drive `activate()` against a real `PluginApiImpl` backed by core registries, then assert that the tool the LLM would see is the one you registered. `@ethosagent/plugin-sdk/testing` ships `mockLLM` and `createTestRuntime` for the end-to-end path.

```ts title="src/__tests__/index.test.ts"
import {
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';
import type { ContextInjector } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { activate } from '../index';

describe('myplugin', () => {
  it('registers the greet tool', async () => {
    const injectors: ContextInjector[] = [];
    const tools = new DefaultToolRegistry();
    const api = new PluginApiImpl('myplugin', {
      tools,
      hooks: new DefaultHookRegistry(),
      injectors,
      injectorPluginIds: new Map(),
      personalities: new DefaultPersonalityRegistry(),
    });

    await activate(api);

    expect(tools.toDefinitions().map((d) => d.name)).toContain('greet');
  });
});
```

Run `pnpm test`. A failing test here means the loader will silently skip your plugin in production — fix it before shipping.

### 5. Document required config

Include a `README.md` that lists every env var the plugin reads, every tool it adds, and how to add it to `~/.ethos/config.yaml`:

```yaml
plugins:
  - "@yourscope/ethos-plugin-myplugin"
```

Plugins that touch `terminal` or external network require an entry in the personality's `pluginAllowlist`. Spell that out so users know which personalities get the tool.

### 6. Build and publish

```bash
pnpm build
ls dist/                   # confirm dist/index.js and dist/index.d.ts exist
npm publish --dry-run      # inspect what would ship
npm publish --access public
```

Bump versions per semver: patch for fixes, minor for new tools or hooks, major for breaking changes to a tool's argument schema or to the `ethos` manifest shape.

## Verify

Install the plugin locally and confirm the loader picks it up.

```bash
ethos plugin install @yourscope/ethos-plugin-myplugin
ethos doctor
```

`doctor` lists the loaded plugins, the tools each registered, and any hook subscriptions. Then run one turn:

```bash
ethos chat -q "use the greet tool to say hi to mitesh"
```

A `tool_start` / `tool_end` pair for `greet` in the stream confirms the plugin reached the agent.

## Troubleshoot

**`Plugin "<name>" declares pluginContractMajor=N, but Ethos's current plugin contract is major=1`.** — The loader rejected the package before importing it. Bump `ethos.pluginContractMajor` in `package.json` to match the current major and republish.

**`"<name>" has no activate() or register() export — skipping`.** — The entry point resolved but the module does not expose `activate`. Confirm `dist/index.js` exports a named `activate` function (or a default object with one).

**`"<name>" blocked by safety scan: ...`.** — The plugin scanner found a red or yellow finding (suspicious shell usage, undeclared network access, prompt-injection patterns in static strings). Move side effects out of top-level code, declare network hosts under `ethos.permissions.network` in `package.json`, or split the risky path into a user-confirmed code path.

**Plugin loads but the tool never appears to the LLM.** — Tools are gated by both the personality `toolset` and the personality `pluginAllowlist`. Add the tool name to `toolset.yaml` and the plugin id to `pluginAllowlist` for the personalities that should see it.

**`ECONNREFUSED` or `EACCES` inside `activate`.** — `activate` runs synchronously during startup; do not open sockets, read large files, or call APIs there. Lazy-init inside the tool's `execute`.
