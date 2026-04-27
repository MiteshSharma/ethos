# @ethosagent/tools-file

Filesystem tools for reading, writing, patching, and grep-style searching from an Ethos agent.

## Why this exists

Agents need first-class access to the local filesystem to inspect, edit, and locate code. This package implements the four `Tool<TArgs>` contracts that cover that surface — paginated reads, exact-match patching, blocked-path-aware writes, and a depth-limited text search — without pulling in any external dependencies.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `read_file` | `file` | Read a file, optionally restricted to a `start_line`/`end_line` range. |
| `write_file` | `file` | Write content to a file, creating parent directories as needed. |
| `patch_file` | `file` | Replace an exact `old_text` block with `new_text` (single replacement). |
| `search_files` | `file` | Walk a directory tree and find lines containing a substring pattern. |

A single factory `createFileTools()` returns all four.

## How it works

Paths starting with `~/` are expanded against `homedir()`; relative paths resolve against `ctx.workingDir`. See `expandPath` in `src/index.ts:13`.

`write_file` and `patch_file` refuse to touch `~/.ethos/config.yaml` or anything under `~/.ethos/sessions/` — see `BLOCKED_WRITE_PATHS`/`BLOCKED_WRITE_PREFIXES` at `src/index.ts:10`. The error code is `execution_failed`, with a hint to use the proper Ethos command instead.

`read_file` declares `maxResultChars: 40_000`. When a range is requested, the value is prefixed with `[abs] lines from–to of total`; otherwise the whole file is returned with a `[abs] N lines` header.

`patch_file` requires `old_text` to appear verbatim in the file (whitespace included). It performs a single `String.replace` — only the first occurrence is replaced. If `old_text` is missing, the tool errors with a hint to call `read_file` first.

`search_files` walks up to 6 directory levels, skips hidden entries (except `.env`), and skips `node_modules`, `dist`, `.git`, `.turbo`, and `coverage`. Files larger than 2 MB are skipped. Only extensions in the `TEXT_EXTENSIONS` allowlist (or extensionless files) are scanned. Defaults to 50 matches, capped at 200. Glob filter supports `*` and `?` only — see `matchGlob` at `src/index.ts:69`.

## Gotchas

- `patch_file` errors with `execution_failed` when `old_text` matches more than once — the file is left untouched. Callers must add surrounding context to make the match unique, or call the tool once per location.
- `search_files` is a substring match, not a regex — special characters in `pattern` are matched literally.
- The blocked-write list is hardcoded; new sensitive paths must be added to `BLOCKED_WRITE_PATHS`/`BLOCKED_WRITE_PREFIXES`.
- `isTextFile` returns `true` for any extension not present in the allowlist if the extension is empty — extensionless files are scanned.
- Directory-walk skip list is hardcoded in `walkAndSearch` (`src/index.ts:277`); it is not configurable per call.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | All four tool definitions and the `createFileTools()` factory. |
| `src/__tests__/` | Unit tests for path expansion, blocked writes, patch semantics, and search. |
