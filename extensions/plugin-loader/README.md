# @ethosagent/plugin-loader

Discovers and activates third-party Ethos plugins from `~/.ethos/plugins/`, `.ethos/plugins/`, and npm `node_modules`.

## Why this exists

Ethos's core registries (tools, hooks, injectors) accept registrations at construction time. The plugin-loader lets external packages register tools / hooks / injectors at startup *without* modifying the CLI's wiring code. It bridges `@ethosagent/plugin-contract` (the public schema for what makes a directory or npm package a plugin) and `@ethosagent/plugin-sdk` (the `PluginApi` handed to each plugin's `activate()` function), so plugins can be shipped, installed, and loaded the same way regardless of source.

Without this extension, every new tool or hook would have to be wired manually in `apps/ethos/src/wiring.ts`.

## What it provides

- `PluginLoader` class — discovery, activation, and lifecycle (`unload`, `unloadAll`, `list`, `isLoaded`).
- Three discovery sources, applied in order: `~/.ethos/plugins/` → `<cwd>/.ethos/plugins/` → npm packages.
- Per-plugin `PluginApiImpl` instance (from `@ethosagent/plugin-sdk`) so `unload()` can call `cleanup()` and roll back every registration.

## How it works

`loadAll()` (`src/index.ts:30`) runs the three discovery sources sequentially. Later sources with the same plugin id override earlier ones — npm-installed plugins beat project-local, project-local beats user-global. Each source delegates to `loadFromPluginDir()` or `scanNodeModulesDir()`.

`loadFromPluginDir()` (`src/index.ts:69`) resolves an entry point in this order: `index.ts`, `index.js`, `src/index.ts`, `src/index.js`, then `package.json#main` (`src/index.ts:211`). It then dynamically `import()`s the entry, checks for an `activate` export, constructs a per-plugin `PluginApiImpl`, and calls `activate(api)`. If `activate` throws, `api.cleanup()` is called and the plugin is silently dropped.

`loadFromNodeModules()` (`src/index.ts:93`) only inspects packages whose name matches `ethos-plugin-*` or `@ethos-plugins/*` — this keeps the scan O(filtered packages), not O(all dependencies). Each candidate's `package.json` is checked with `isEthosPlugin()` from `@ethosagent/plugin-contract`, which validates the `ethos.type === "plugin"` field.

`unload(id)` calls `plugin.deactivate?.()` (errors swallowed), then `api.cleanup()` to undo every `register*()` call the plugin made (each `register*` returns a cleanup function that the SDK accumulates). Reloading is `unload` + `activate` — `activatePlugin` (`src/index.ts:172`) calls `unload` first if the id already exists.

## On-disk layout

Per-directory plugin (works in `~/.ethos/plugins/<name>/` or `<cwd>/.ethos/plugins/<name>/`):

```
<plugin-name>/
  index.ts | index.js | src/index.ts | src/index.js   # must export activate(api)
  package.json                                        # optional, used to resolve "main"
  plugin.yaml                                         # mentioned in code comment but not actually read
```

npm-installed plugin (in any `node_modules/`):

```
node_modules/ethos-plugin-foo/
  package.json   # must contain { "ethos": { "type": "plugin" } }
                 # entry resolved via main, exports["."], or default index.js
```

## Gotchas

- The doc comment says `loadFromPluginDir` "must contain either `plugin.yaml` or `package.json`" but the implementation only resolves the entry file — `plugin.yaml` is never parsed. A directory with just an `index.ts` exporting `activate` will load.
- Scoped npm packages are discovered by recursing into the `@ethos-plugins` scope directory (`src/index.ts`). Only the literal `@ethos-plugins` scope is scanned — other scopes (e.g. `@my-org`) are skipped to keep the scan O(filtered packages).
- All discovery / activation failures are silent except for `console.warn` calls; no error propagates from `loadAll()`. The CLAUDE.md notes this package is one of the few allowed to use `console.warn`.
- Plugin order matters for hooks (handlers run in registration order for sequential models like `fireModifying` and `fireClaiming` — see core's hook-registry).
- `unloadAll()` iterates `[...this.plugins.keys()]` (a snapshot) so plugins added during deactivation don't cause iteration issues.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `PluginLoader` class — discovery (dir + node_modules), entry resolution, activation, lifecycle. |
| `src/__tests__/plugin-loader.test.ts` | Tests for directory loading, npm scanning, and unload semantics. |
