---
title: "Storage interface"
description: "Storage, FsStorage, InMemoryStorage, ScopedStorage, BoundaryError — the filesystem abstraction for ~/.ethos/."
kind: reference
audience: developer
slug: storage-interface
updated: 2026-05-12
---

`Storage` is the filesystem abstraction every reader and writer of `~/.ethos/` takes in its constructor. Production code wires [`FsStorage`](#fs-storage); tests wire [`InMemoryStorage`](#in-memory-storage); the [`ScopedStorage`](#scoped-storage) decorator enforces a per-[personality](../../getting-started/glossary.md#personality) [fs_reach](../../getting-started/glossary.md#fs-reach) allowlist.

## Source {#source}

Interface in [`packages/types/src/storage.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/storage.ts). Implementations in [`packages/storage-fs/src/`](https://github.com/ethosagent/ethos/blob/main/packages/storage-fs/src/index.ts).

## Storage {#storage}

### Signature {#storage-signature}

```ts
import type {
  Storage,
  StorageDirEntry,
  StorageRemoveOptions,
  StorageWriteOptions,
} from '@ethosagent/types';

export interface Storage {
  read(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  mtime(path: string): Promise<number | null>;
  list(dir: string): Promise<string[]>;
  listEntries(dir: string): Promise<StorageDirEntry[]>;
  write(path: string, content: string, opts?: StorageWriteOptions): Promise<void>;
  append(path: string, content: string): Promise<void>;
  writeAtomic(path: string, content: string, opts?: StorageWriteOptions): Promise<void>;
  mkdir(dir: string): Promise<void>;
  remove(path: string, opts?: StorageRemoveOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
```

### Methods {#storage-methods}

| Method | Returns | Description |
|---|---|---|
| `read(path)` | `string \| null` | Read utf-8 text. Returns `null` if the file does not exist. |
| `exists(path)` | `boolean` | True if the path resolves to a file or directory. |
| `mtime(path)` | `number \| null` | Modification time in epoch milliseconds, or `null` if absent. |
| `list(dir)` | `string[]` | Immediate children (names only). Empty array if missing. |
| `listEntries(dir)` | `StorageDirEntry[]` | Same as `list`, with `{ name, isDir }` plus optional `size` (bytes) and `mtimeMs` (epoch-ms). Both are omitted for directories, and for any entry the backend cannot stat. |
| `write(path, content, opts?)` | `void` | Write utf-8 text. Parent dir must already exist. `opts.mode` applies POSIX permissions atomically. |
| `append(path, content)` | `void` | Append utf-8 text. Creates the file if missing. |
| `writeAtomic(path, content, opts?)` | `void` | Write to `<path>.tmp.<pid>`, then rename. Use for files where a partial write would corrupt state (config, keys, audit). |
| `mkdir(dir)` | `void` | Recursive directory create. No-op if the directory already exists. |
| `remove(path, opts?)` | `void` | Delete. `opts.recursive` enables `rm -rf` semantics. |
| `rename(from, to)` | `void` | Rename or move. |

### Error semantics {#storage-errors}

- `read`, `exists`, and `mtime` return `null` (or `false` for `exists`) for missing paths. Missing-file is the common case, not an exception.
- Every other method throws on failure.
- `ScopedStorage` throws [`BoundaryError`](#boundary-error) when a path lies outside the allowlist; consumers should catch and translate to user-facing tool errors.

### Notes {#storage-notes}

- All paths are absolute. The interface does not manage a root — consumers compute paths (typically via `ethosDir()` helpers) and pass them in.
- `writeAtomic` is a separate method, not a flag on `write`. The split prevents the "did the writer remember?" footgun.
- `StorageWriteOptions.mode` is POSIX only. On Windows the value is partially honoured per `fs.writeFile` semantics.

## FsStorage {#fs-storage}

### Signature {#fs-storage-signature}

```ts
import { FsStorage } from '@ethosagent/storage-fs';

const storage = new FsStorage();
```

Concrete implementation backed by `node:fs/promises`. Construct with no arguments. Use in every production wiring (CLI, web-api, gateway).

### Notes {#fs-storage-notes}

- `writeAtomic` writes to `<path>.tmp.<pid>` and renames into place. On crash the temp file is left behind; consumers can clean up on startup if it matters.
- POSIX `mode` is applied via `fs.chmod` before the rename, so the final file has the requested permissions from the instant it exists at the destination path.

## InMemoryStorage {#in-memory-storage}

### Signature {#in-memory-storage-signature}

```ts
import { InMemoryStorage } from '@ethosagent/storage-fs';

const storage = new InMemoryStorage();
await storage.write('/etc/foo', 'hello');
```

In-memory `Storage` for tests. Populate fixtures via `write()` — no tmpdir scaffolding required. Same surface as `FsStorage`, so tests work against the interface, not the implementation.

### Notes {#in-memory-storage-notes}

- Paths are stored as keys in a `Map<string, string>`. Directories are implicit (any prefix is treated as a directory).
- `mtime` is tracked per-write; reads return the most recent write time.

## ScopedStorage {#scoped-storage}

### Signature {#scoped-storage-signature}

```ts
import { ScopedStorage, type ScopedStorageScope } from '@ethosagent/storage-fs';

const scoped = new ScopedStorage(inner, {
  read: ['/home/me/.ethos/personalities/engineer/', '/home/me/repo/'],
  write: ['/home/me/.ethos/personalities/engineer/'],
  alwaysDeny: ['/home/me/.ssh/', '/etc/'],
});
```

Decorator that enforces a per-personality read/write allowlist plus a universal always-deny floor.

### Members {#scoped-storage-members}

| Field | Type | Description |
|---|---|---|
| `inner` | `Storage` | Underlying storage being decorated. |
| `scope.read` | `readonly string[]` | Path prefixes that may be read. |
| `scope.write` | `readonly string[]` | Path prefixes that may be mutated. |
| `scope.alwaysDeny` | `readonly string[] \| undefined` | Universal deny floor — checked before allow rules. Built-ins include `~/.ssh/`, `~/.aws/`, `/etc/`. |

### Check order {#scoped-storage-check-order}

For every call:

1. `alwaysDeny` match → `BoundaryError` with reason `'always-deny floor'`.
2. No `read` / `write` prefix match → `BoundaryError`.
3. Otherwise → delegate to `inner`.

Deny always wins over allow.

### Notes {#scoped-storage-notes}

- Prefixes are matched literally — no glob expansion. Pass trailing-slash directory prefixes so `/a/b` does not also match `/a/bc/`.
- `ScopedStorage` is built per turn by `AgentLoop` from `personality.fs_reach`. Tools receive it via [`ToolContext.storage`](./tool-interface.md#tool-context).

## BoundaryError {#boundary-error}

### Signature {#boundary-error-signature}

```ts
import { BoundaryError } from '@ethosagent/types';

throw new BoundaryError('read', '/etc/passwd', ['/home/me/.ethos/']);
```

### Members {#boundary-error-members}

| Field | Type | Description |
|---|---|---|
| `code` | `'storage-boundary'` (literal) | Stable error class. Switch-statement safe. |
| `kind` | `'read' \| 'write'` | Which operation was attempted. |
| `path` | `string` | The rejected absolute path. |
| `name` | `'BoundaryError'` | JS error name. |
| `message` | `string` | `"<kind> not permitted: <path> not in [allowed list] (<why>)"` |

### Notes {#boundary-error-notes}

- Caught by `extensions/tools-file/src/` and translated into a user-facing tool error so the LLM sees a structured rejection rather than a stack trace.
- `code` is also exported as a discriminant: `err.code === 'storage-boundary'` reliably identifies the class even across realm boundaries.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `apps/ethos/src/wiring.ts` | Constructs `FsStorage` and threads it into every consumer. |
| `packages/core/src/agent-loop.ts` | Wraps the base `Storage` with `ScopedStorage` per turn and passes it via `ToolContext.storage`. |
| `extensions/personalities/src/index.ts` | `FilePersonalityRegistry` uses the base `Storage` to read personality directories. |
| `extensions/memory-markdown/src/index.ts` | Reads / writes `MEMORY.md` and `USER.md`. |
| `extensions/tools-file/src/` | Tool execution; catches `BoundaryError` and translates. |
| `extensions/observability-sqlite/src/` | Uses raw `node:fs` for SQLite (allowed exception). |
| `packages/storage-fs/src/__tests__/` | `InMemoryStorage` powers the conformance suite. |

## See also {#see-also}

- [Tool interface](./tool-interface.md) — `ToolContext.storage` is the per-turn `ScopedStorage`.
- [Personality registry reference](./personality-registry.md) — produces the `fs_reach` config that drives `ScopedStorage`.
- [Glossary: Storage](../../getting-started/glossary.md#storage) — one-line definition for cross-page reference.
- [Glossary: fs_reach](../../getting-started/glossary.md#fs-reach) — the path-allowlist field as it appears in `personality.yaml`.
