---
title: "FilePersonalityRegistry reference"
description: "FilePersonalityRegistry — disk-backed personality loader with mtime caching and CRUD."
kind: reference
audience: developer
slug: personality-registry
updated: 2026-05-22
---

`FilePersonalityRegistry` is the disk-backed loader for [personalities](../../getting-started/glossary.md#personality). It walks one or more directories of `<id>/{SOUL.md, config.yaml, toolset.yaml}` triples, parses them into `PersonalityConfig` values, and caches based on file mtimes so `loadFromDirectory` is cheap to call every turn for hot-reload.

## Source {#source}

[`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts). Ships as `@ethosagent/personalities`.

## FilePersonalityRegistry {#file-personality-registry}

### Signature {#file-personality-registry-signature}

```ts
import { FilePersonalityRegistry, createPersonalityRegistry } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';

const registry = new FilePersonalityRegistry(new FsStorage(), '/home/me/.ethos');
await registry.loadBuiltins();
await registry.loadFromDirectory('/home/me/.ethos/personalities');
```

### Constructor {#constructor}

```ts
constructor(storage?: Storage, userPersonalitiesDir?: string)
```

| Param | Default | Description |
|---|---|---|
| `storage` | `new FsStorage()` | The [`Storage`](./storage-interface.md) backend. Tests pass `InMemoryStorage`. |
| `userPersonalitiesDir` | `undefined` | Root containing a `personalities/` subdir for user-mutable personalities. When unset, CRUD methods throw. |

Convenience factory:

```ts
const registry = await createPersonalityRegistry({
  storage: new FsStorage(),
  userPersonalitiesDir: '/home/me/.ethos',
});
```

### Read methods {#read-methods}

| Method | Returns | Description |
|---|---|---|
| `define(config)` | `void` | Insert / replace by id. Used by plugin-registered personalities and tests. |
| `get(id)` | `PersonalityConfig \| undefined` | Look up by id. |
| `list()` | `PersonalityConfig[]` | Every loaded personality. |
| `getDefault()` | `PersonalityConfig` | Default personality (initially `researcher` if loaded; otherwise the first loaded). |
| `setDefault(id)` | `void` | Set the default. Throws if `id` is not loaded. |
| `describe(id)` | `DescribedPersonality \| null` | Returns `{ config, builtin }`. `builtin === true` when the source dir is the package's bundled `data/`. |
| `describeAll()` | `DescribedPersonality[]` | Same as `describe` for every loaded id. |
| `readSoulMd(id)` | `Promise<string>` | Read the personality's `SOUL.md` body. Returns `''` if absent. |
| `userPathFor(id)` | `string` | Absolute path of `<userPersonalitiesDir>/<id>` (even if it does not exist). Throws if no `userPersonalitiesDir` was configured. |

### Loaders {#loaders}

| Method | Description |
|---|---|
| `loadBuiltins()` | Walk the package's bundled `data/` directory (resolved via `import.meta.dirname`). Sets `default = researcher` if present. |
| `loadFromDirectory(dir)` | Walk `dir/*` and load each subdirectory as a personality. Mtime-cached — re-reading is cheap when nothing changed. |

### CRUD methods {#crud-methods}

Available only when `userPersonalitiesDir` was passed to the constructor. Built-ins are read-only; clone with `duplicate(id, newId)` (table below) first.

| Method | Description |
|---|---|
| `create(input)` | Write a new `<userDir>/personalities/<id>/` with `config.yaml`, `toolset.yaml`, `SOUL.md`. Throws `PERSONALITY_EXISTS` if the id is taken. |
| `update(id, patch)` | Patch one or more fields. Only the fields present in `patch` are rewritten. Throws `PERSONALITY_READ_ONLY` for built-ins. |
| `duplicate(id, newId)` | Copy a built-in (or any other) personality into the user dir. The copy's `name:` becomes `<original> (copy)`. |
| `deletePersonality(id)` | `rm -rf` the personality's user dir and drop from memory. Throws for built-ins. |
| `remove(id)` | In-memory drop only — does not touch disk. Used internally; rarely called directly. |

### CreatePersonalityInput {#create-personality-input}

```ts
export interface CreatePersonalityInput {
  id: string;
  name: string;
  description?: string;
  model?: string;
  toolset: string[];
  soulMd: string;
  memoryScope?: 'global' | 'per-personality';
}
```

### UpdatePersonalityPatch {#update-personality-patch}

```ts
export interface UpdatePersonalityPatch {
  name?: string;
  description?: string;
  model?: string;
  toolset?: string[];
  soulMd?: string;
  memoryScope?: 'global' | 'per-personality';
  mcp_servers?: string[];
  plugins?: string[];
  skin?: string | null;
}
```

`skin === undefined` leaves the existing value alone; `skin === null` clears the override; a string sets it.

## mtime caching {#mtime-caching}

`loadOne()` fingerprints each personality dir by joining the mtimes of `config.yaml`, `SOUL.md`, and `toolset.yaml`:

```
<configMtime>|<ethosMtime>|<toolsetMtime>
```

Cache stored in `fingerprintCache: Map<dir, fingerprint>`. If the recomputed fingerprint matches the cached value, the load is a no-op. Hot-reload at turn-start is therefore cheap when nothing changed.

| Filesystem | mtime resolution |
|---|---|
| APFS | nanosecond |
| ext4 | nanosecond (since 2.6.11) |
| NTFS | 100ns |

Sub-millisecond resolution makes two writes within the same tick vanishingly unlikely for personality files (human-paced edits, not log streams).

## YAML parsing {#yaml-parsing}

`config.yaml` is parsed by a minimal in-package parser — no external YAML dependency.

| Pattern | Behaviour |
|---|---|
| `key: value` | Flat key/value. Quotes stripped. |
| `key1.key2: value` | Dotted key (e.g. `fs_reach.read`). Used for nested config that fits the flat parser. |
| `safety:` block | Recognised top-level nested block (allowlisted). Two levels deep. |
| Any other nested block | Throws — top-level non-safety nested objects are rejected. |
| `key:\n  - a\n  - b` | List value inside a nested block. |

`toolset.yaml` is a flat list:

```yaml
- read_file
- write_file
- web_search
```

## Notes {#notes}

- `describe(id).builtin` is computed by comparing `config.soulFile` against the user-dir prefix. Personalities loaded from the package's `data/` directory always report `builtin: true`.
- `loadBuiltins()` resolves the data directory via `import.meta.dirname` (Node 21.2+). Do not replace with the `fileURLToPath(new URL(...))` workaround — Ethos runs on Node 24.
- `validateUnsafeCombinations` refuses load if a personality has `safety.approvalMode: off` and `platform:` is one of the channel-ingress platforms (`telegram`, `discord`, `slack`, `whatsapp`, `email`). Stranger-driven auto-approval is rejected at config-load time.
- The `defaultId` field is in-memory only; restart resets it to `researcher` (or first loaded).

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `apps/ethos/src/wiring.ts` | Instantiates the registry once at startup. |
| `apps/ethos/src/commands/personality.ts` | Powers `ethos personality list/set/duplicate`. |
| `apps/ethos/src/commands/chat.ts` | `/personality <id>` looks up via `get` and `setDefault`. |
| `apps/web/src/api/personalities.ts` | Web API routes for personality CRUD. |
| `packages/core/src/agent-loop.ts` | Reads `personality.toolset`, `personality.fs_reach`, `personality.plugins`, `personality.mcp_servers` each turn. |

## See also {#see-also}

- [Personality config reference](../../using/reference/personality-yaml.md) — every `config.yaml` field.
- [Storage interface](./storage-interface.md) — backs the registry; tests swap `FsStorage` for `InMemoryStorage`.
- [Glossary: Personality](../../getting-started/glossary.md#personality) — one-line definition shared across every page that names the construct.
- [Glossary: Built-in personality](../../getting-started/glossary.md#built-in-personality) — the three user-facing shipped personalities (plus system personalities) the registry seeds.
