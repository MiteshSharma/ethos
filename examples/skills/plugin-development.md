# Ethos Plugin Development

Use this skill when helping a user write, test, or debug an Ethos plugin.

## What a plugin is

A plugin is a TypeScript file (or npm package) that exports `activate(api)`. The loader calls it at startup with an `EthosPluginApi` object. Everything a plugin registers is removed cleanly when the plugin is unloaded.

## File structure

```
my-plugin/
├── package.json        ← must have "ethos": { "type": "plugin" }
└── src/
    ├── index.ts        ← exports activate() and deactivate()
    └── __tests__/
        ├── unit.test.ts
        └── integration.test.ts
```

## The four registration methods

```typescript
// 1. Tool — the LLM can call this
api.registerTool(defineTool({ name, description, schema, execute }))

// 2. Void hook — fire-and-forget side effect
api.registerVoidHook('agent_done', async ({ sessionId, text }) => { ... })

// 3. Modifying hook — can change prompt or block tool calls
api.registerModifyingHook('before_tool_call', async ({ toolName, args }) => {
  return null          // no change
  return { error: '…' } // block the call
  return { args: newArgs } // replace the args
})

// 4. Context injector — adds a section to the system prompt
api.registerInjector({ id, priority: 70, async inject(ctx) { return { content, position: 'append' } } })
```

## Tool result format

Always return `ok(string)` or `err(message, code)`. Never throw.

```typescript
import { ok, err } from '@ethosagent/plugin-sdk/tool-helpers';

return ok('Search results: ...')
return err('API key missing', 'not_available')
return err('Bad args: query is required', 'input_invalid')
return err('Network timeout', 'execution_failed')
```

## isAvailable pattern

Hide a tool when its dependencies are missing:

```typescript
defineTool({
  name: 'my_tool',
  isAvailable: () => Boolean(process.env.MY_API_KEY),
  ...
})
```

## Testing approach

**Unit test** — test the `execute()` function directly with a fake `ctx`:

```typescript
const ctx = { sessionId: 'test', sessionKey: 'cli:test', platform: 'cli',
  workingDir: '/tmp', currentTurn: 1, messageCount: 1,
  abortSignal: new AbortController().signal, emit: () => {}, resultBudgetChars: 80_000 }

const result = await myTool.execute({ query: 'hello' }, ctx)
expect(result.ok).toBe(true)
```

**Integration test** — load the plugin into real registries and verify registration/cleanup:

```typescript
import { DefaultToolRegistry, DefaultHookRegistry, DefaultPersonalityRegistry } from '@ethosagent/core'
import { createTestRuntime, mockLLM } from '@ethosagent/plugin-sdk/testing'

const registries = { tools: new DefaultToolRegistry(), hooks: new DefaultHookRegistry(),
  injectors: [], personalities: new DefaultPersonalityRegistry() }
await activate(makeApi('my-plugin', registries))
expect(registries.tools.get('my_tool')).toBeDefined()
```

## Common mistakes

- Exporting only a default object but not named `activate` — the loader requires a named export
- Forgetting `"ethos": { "type": "plugin" }` in `package.json` — npm discovery skips the package
- Not handling `ctx.abortSignal` in async tools — long-running tools won't abort on Ctrl+C
- Returning non-string values from `execute` — `value` must be a string the LLM can read
- Registering tools in `deactivate` instead of `activate` — they won't be removed on unload

## Installation locations

```
~/.ethos/plugins/my-plugin/    global (any project)
.ethos/plugins/my-plugin/      project-local
node_modules/ethos-plugin-*/   npm (auto-discovered)
```

## Where to look for help

- `examples/plugins/README.md` — full guide with all registration patterns
- `examples/plugins/hello/` — complete working example with unit + integration tests
- `packages/plugin-sdk/src/index.ts` — EthosPluginApi interface definition
- `packages/plugin-sdk/src/tool-helpers.ts` — ok(), err(), defineTool()
- `packages/plugin-sdk/src/testing.ts` — mockLLM(), mockTool(), createTestRuntime()
