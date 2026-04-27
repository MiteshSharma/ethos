# @ethosagent/personalities

Filesystem-backed `PersonalityRegistry` with five built-in personalities and an mtime-cached loader for user overrides.

## Why this exists

In Ethos, a personality is structural — it shapes tool access, model routing, and prompt content all at once (see the root `CLAUDE.md`, "Adding a personality"). The core `AgentLoop` only knows the `PersonalityRegistry` interface from `@ethosagent/types`; this extension is the concrete implementation that reads `ETHOS.md` / `config.yaml` / `toolset.yaml` from disk and turns them into `PersonalityConfig` records the loop can resolve every turn.

Without this extension there are no personalities to choose from, so `AgentLoop` would have nothing to consult when filtering tools or selecting a model.

## What it provides

- `FilePersonalityRegistry` — implements `PersonalityRegistry`, holds an in-memory map keyed by personality id with mtime caching of `config.yaml`.
- `createPersonalityRegistry()` — async factory that returns a registry pre-loaded with the five built-ins.
- A `data/` directory shipped alongside `src/` containing the built-in personalities.

Built-ins shipped in `data/`:

| id | model | purpose |
|---|---|---|
| `researcher` | `claude-opus-4-7` | Methodical research, primary sources, flagged uncertainty. Default. |
| `engineer` | `claude-sonnet-4-6` | Terse, code-first. |
| `coach` | — | Conversational coaching personality. |
| `operator` | — | Operations-focused personality. |
| `reviewer` | — | Code/plan review personality. |

## How it works

`createPersonalityRegistry()` calls `loadBuiltins()`, which resolves the bundled `data/` directory via `join(import.meta.dirname, '..', 'data')` (see `src/index.ts:89`). `import.meta.dirname` is the Node 21.2+ replacement for the old `fileURLToPath(new URL(...))` workaround — see the root `CLAUDE.md` "Learnings" section for why we use it directly.

The CLI then calls `loadFromDirectory(~/.ethos/personalities)` on top of the built-ins, so user-defined personalities can override any built-in id (`apps/ethos/src/wiring.ts:59-61`). Defaulting works the same way: `setDefault('researcher')` is called after built-ins load, and the CLI calls `setDefault(config.personality)` on top if the user has set one.

`loadOne()` (`src/index.ts:99`) caches `config.yaml` mtime per directory. On subsequent calls, if the file has not changed, the personality is not re-read — so the chat REPL can call `loadFromDirectory()` cheaply on every turn for hot-reload.

`buildConfig()` (`src/index.ts:126`) is permissive: a directory needs only `config.yaml` *or* `ETHOS.md` to be considered a personality. Missing `toolset.yaml` means the personality has no toolset filter, and `AgentLoop` will expose every registered tool to the LLM (toolset-based filtering only kicks in when `personality.toolset` is set — see `tool-registry.ts:57`).

The YAML parsers are intentionally minimal — `parseConfigYaml` is `^(\w+):\s*(.+)$` line-by-line (no nesting), `parseToolsetYaml` accepts only flat `- item` lists. No external YAML dependency.

## On-disk layout

```
~/.ethos/personalities/<id>/
  config.yaml      # name, description, model, provider, platform,
                   # memoryScope, capabilities (CSV), streamingTimeoutMs
  ETHOS.md         # first-person identity prompt (optional)
  toolset.yaml     # flat - <tool_name> list (optional)
  skills/          # directory of skill markdown files (optional)
```

`extensions/personalities/data/<id>/` follows the same shape — that's how the five built-ins are stored.

## Gotchas

- A directory with neither `config.yaml` nor `ETHOS.md` is silently ignored (`src/index.ts:135`).
- `config.yaml` is single-level only — `parseConfigYaml` does not handle nested keys or multiline values.
- `capabilities` is comma-separated *inside the value*, not a YAML list (`code, file, terminal`).
- The mtime cache tracks the max mtime of `config.yaml`, `ETHOS.md`, and `toolset.yaml`. Adding or removing files inside the personality's `skills/` directory is *not* watched — those changes are picked up by `SkillsInjector` directly on the next turn, not by a personality reload.
- `getDefault()` falls back to the first inserted personality if `defaultId` is unknown, then to a hard-coded `{ id: 'default', name: 'Default' }` if the registry is empty.
- `loadFromDirectory()` swallows ENOENT — a missing personalities directory is treated as no personalities, not an error.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `FilePersonalityRegistry`, `createPersonalityRegistry`, YAML parsers, mtime cache. |
| `src/__tests__/personalities.test.ts` | Loader, mtime cache, and built-in coverage tests. |
| `data/<id>/` | Bundled built-in personalities (researcher, engineer, coach, operator, reviewer). |
