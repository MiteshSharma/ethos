# Ethos Plugin Development Guide

A plugin is a TypeScript module that registers tools, hooks, injectors, and personalities into a running Ethos agent — without modifying the core codebase.

---

## Quick start

```bash
mkdir ~/.ethos/plugins/my-plugin
cd ~/.ethos/plugins/my-plugin
```

Create `index.ts`:

```typescript
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, ok } from '@ethosagent/plugin-sdk/tool-helpers';

export function activate(api: EthosPluginApi): void {
  api.registerTool(
    defineTool({
      name: 'my_tool',
      description: 'Does something useful',
      schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
      async execute({ input }) {
        return ok(`You said: ${input}`);
      },
    }),
  );
}

export function deactivate(): void {}
```

Restart `ethos` — your tool appears automatically.

---

## Examples

Four complete, tested examples in this directory:

| Example | Pattern | What it shows |
|---|---|---|
| [`example-hello/`](./example-hello/) | Multi-registration | Tool + void hook + personality in one plugin |
| [`example-timestamp/`](./example-timestamp/) | Tool only | Pure tool, no external deps, no API key |
| [`example-memory-logger/`](./example-memory-logger/) | Persistence hook | Writing to disk on `agent_done`, env-var config |
| [`example-safety-adapter/`](./example-safety-adapter/) | Modifying hooks | Blocking dangerous commands, prepending system prompt |
| [`example-personality/`](./example-personality/) | Personality | Custom identity, toolset, and injectors as a plugin |

Each example has `src/__tests__/unit.test.ts` and (where relevant) `integration.test.ts`.

---

## Plugin anatomy

```
my-plugin/
├── package.json        ← required: "ethos": { "type": "plugin" }
├── src/
│   ├── index.ts        ← exports activate() and deactivate()
│   └── __tests__/
│       ├── unit.test.ts
│       └── integration.test.ts
└── README.md
```

### `package.json` minimum

```json
{
  "name": "ethos-plugin-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "ethos": {
    "type": "plugin",
    "pluginApi": "1.0.0"
  }
}
```

### `index.ts` shape

```typescript
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';

export function activate(api: EthosPluginApi): void | Promise<void> {
  // register everything here
}

export function deactivate(): void | Promise<void> {
  // release external resources (DB connections, timers)
  // tools, hooks, injectors are removed automatically
}

export default { activate, deactivate } satisfies EthosPlugin;
```

---

## What a plugin can register

### 1. Tool

```typescript
import { defineTool, ok, err } from '@ethosagent/plugin-sdk/tool-helpers';

api.registerTool(
  defineTool<{ query: string; limit?: number }>({
    name: 'my_search',
    description: 'Search my data source',
    toolset: 'my-plugin',
    maxResultChars: 10_000,
    isAvailable: () => Boolean(process.env.MY_API_KEY),
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async execute({ query, limit = 5 }, ctx) {
      try {
        const results = await fetchMyApi(query, limit, ctx.abortSignal);
        return ok(JSON.stringify(results, null, 2));
      } catch (e) {
        return err(`API error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }),
);
```

**Tool result must be `{ ok: true, value: string }` or `{ ok: false, error, code }`.**
Error codes: `'input_invalid'` | `'not_available'` | `'execution_failed'`

See [`example-timestamp/`](./example-timestamp/) for a complete tool example.

### 2. Void hook (persistence, analytics, logging)

```typescript
api.registerVoidHook('agent_done', async ({ sessionId, text, turnCount }) => {
  await myDb.insert({ sessionId, chars: text.length, turns: turnCount });
});
```

Fire-and-forget. All void handlers run in parallel. Failures are swallowed (fail-open).

Available: `session_start`, `before_llm_call`, `after_llm_call`, `after_tool_call`, `agent_done`, `message_received`, `message_sent`, `subagent_spawned`, `subagent_ended`

See [`example-memory-logger/`](./example-memory-logger/) for the persistence pattern.

### 3. Modifying hook (safety, compliance, access control)

```typescript
// Block or alter tool calls
api.registerModifyingHook('before_tool_call', async ({ toolName, args }) => {
  if (toolName === 'terminal') {
    const cmd = (args as { command?: string })?.command ?? '';
    if (isDangerous(cmd)) return { error: 'Blocked by safety plugin' };
  }
  return null; // no change
});

// Add to system prompt
api.registerModifyingHook('before_prompt_build', async () => {
  return { prependSystem: '## Safety Rules\n\nNever delete system files.' };
});
```

Run sequentially. First non-null value per key wins. Return `null` for no change.

Available: `before_prompt_build`, `before_tool_call`, `message_sending`, `personality_switched`, `subagent_spawning`

See [`example-safety-adapter/`](./example-safety-adapter/) for the adapter pattern.

### 4. Context injector (dynamic system prompt sections)

```typescript
api.registerInjector({
  id: 'my-plugin-context',
  priority: 70,                    // lower than built-ins (80–100)
  shouldInject: (ctx) => ctx.platform === 'telegram',
  async inject(ctx) {
    return { content: `## Telegram Context\n\nUser timezone: UTC+5`, position: 'append' };
  },
});
```

Priority order: `110+ (personality identity)` → `100 (SkillsInjector)` → `90 (FileContextInjector)` → `80 (MemoryGuidanceInjector)` → `70+ (your plugin)`

### 5. Personality

```typescript
api.registerPersonality({
  id: 'strategist',
  name: 'Strategist',
  description: 'Thinks in frameworks, presents options with tradeoffs',
  model: 'claude-opus-4-7',
  memoryScope: 'global',
  toolset: ['web_search', 'read_file', 'memory_read'],
});

// Bundle an identity injector alongside the personality
api.registerInjector({
  id: 'strategist-identity',
  priority: 110,
  shouldInject: (ctx) => ctx.personalityId === 'strategist',
  async inject() {
    return { content: STRATEGIST_ETHOS_MD, position: 'prepend' };
  },
});
```

See [`example-personality/`](./example-personality/) for the complete pattern.

---

## Testing

### Unit tests

Test each function in isolation. No real LLM, no network, no file system.

```typescript
import { describe, expect, it } from 'vitest';
import { myTool } from '../index';

const ctx = {
  sessionId: 'test', sessionKey: 'cli:test', platform: 'cli',
  workingDir: '/tmp', currentTurn: 1, messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {}, resultBudgetChars: 80_000,
};

it('returns ok for valid input', async () => {
  const result = await myTool.execute({ query: 'hello' }, ctx);
  expect(result.ok).toBe(true);
});

it('returns not_available when API key missing', () => {
  const saved = process.env.MY_API_KEY;
  delete process.env.MY_API_KEY;
  expect(myTool.isAvailable?.()).toBe(false);
  if (saved) process.env.MY_API_KEY = saved;
});
```

### Integration tests

Load the plugin into real registries, verify registration and cleanup.

```typescript
import { DefaultHookRegistry, DefaultToolRegistry, DefaultPersonalityRegistry } from '@ethosagent/core';
import { createTestRuntime, mockLLM } from '@ethosagent/plugin-sdk/testing';

const registries = {
  tools: new DefaultToolRegistry(),
  hooks: new DefaultHookRegistry(),
  injectors: [],
  personalities: new DefaultPersonalityRegistry(),
};

// See any example's integration.test.ts for the makeApi() helper
await activate(makeApi('my-plugin', registries));

// Assert registration
expect(registries.tools.get('my_tool')).toBeDefined();

// Run a full agent turn with mockLLM
const loop = createTestRuntime({ llm: mockLLM(['Result here']), tools: registries.tools });
const events = [];
for await (const event of loop.run('Do something')) events.push(event.type);
expect(events).toContain('done');

// Assert cleanup
api._cleanup();
expect(registries.tools.get('my_tool')).toBeUndefined();
```

### Running tests

```bash
# Inside a plugin directory
pnpm test

# From workspace root (runs all plugins)
pnpm test
```

---

## Deployment

### Option 1: Local directory plugin (development / personal use)

No build step needed. Ethos loads `.ts` files directly via tsx.

```bash
# User-global (available in all projects)
cp -r my-plugin ~/.ethos/plugins/

# Project-local (checked into the repo, used by this project only)
mkdir -p .ethos/plugins
cp -r my-plugin .ethos/plugins/
```

Restart `ethos` — plugin is active.

### Option 2: npm package (sharing with others)

**1. Build the plugin:**

```bash
# tsup bundles TypeScript to ESM
pnpm add -D tsup
```

Add to `package.json`:
```json
{
  "scripts": { "build": "tsup src/index.ts --format esm --dts" },
  "main": "./dist/index.js",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } }
}
```

```bash
pnpm build
```

**2. Publish:**

```bash
npm publish
# or for scoped packages:
npm publish --access public
```

**3. Install (manual until `ethos plugin install` lands in Phase 19):**

```bash
pnpm add ethos-plugin-my-plugin
```

The plugin loader auto-discovers npm packages named `ethos-plugin-*` with `"ethos": { "type": "plugin" }` in their `package.json`.

### Option 3: Monorepo plugin (this repo)

If you're contributing a plugin to the Ethos monorepo itself:

```
plugins/
└── my-plugin/
    ├── package.json
    └── src/index.ts
```

It's automatically included in `pnpm-workspace.yaml` and picked up by `pnpm test`.

---

## CI checklist

Add these to your plugin's CI pipeline:

```yaml
- pnpm install
- pnpm typecheck    # zero TypeScript errors
- pnpm test        # all tests pass
- node -e "import('./dist/index.js').then(m => { if (!m.activate) throw new Error('no activate') })"
```

Validate the `package.json` contract:

```typescript
import { validatePluginPackageJson } from '@ethosagent/plugin-contract';
const result = validatePluginPackageJson(require('./package.json'));
if (!result.valid) throw new Error(result.errors.join('\n'));
```

---

## Security

- Plugins run in the **same process** as the agent. A malicious plugin has full Node.js access.
- Only install plugins from sources you trust.
- Use `before_tool_call` modifying hooks to build safety layers (see `example-safety-adapter/`).
- `isAvailable()` is the right place to check env vars — if missing, the tool is hidden from the LLM entirely, not just erroring at call time.
- Never log API keys or secrets in tool results — the LLM reads every value.

---

## Reference

| Import | What you get |
|---|---|
| `@ethosagent/plugin-sdk` | `EthosPluginApi`, `EthosPlugin`, `PluginApiImpl`, type re-exports |
| `@ethosagent/plugin-sdk/tool-helpers` | `ok()`, `err()`, `defineTool<TArgs>()` |
| `@ethosagent/plugin-sdk/testing` | `mockLLM()`, `mockTool()`, `createTestRuntime()` |
| `@ethosagent/plugin-contract` | `validatePluginPackageJson()`, `isEthosPlugin()` |
| `@ethosagent/core` | `DefaultToolRegistry`, `DefaultHookRegistry`, `DefaultPersonalityRegistry` |
