# @ethosagent/tools-memory

Three tools for reading and writing the agent's persistent memory (`MEMORY.md`, `USER.md`) and full-text searching session history.

## Why this exists

Memory and session history are part of the system prompt by default, but the LLM also needs to act on them mid-turn — to recall a user preference before answering, to record a new fact, or to find a past conversation about a specific topic. These tools surface the existing `MemoryProvider` and `SessionStore` capabilities to the model directly.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `memory_read` | `memory` | Read `MEMORY.md`, `USER.md`, or both via `MemoryProvider.prefetch`, optionally filtered by section header. |
| `memory_write` | `memory` | Apply a single `MemoryUpdate` (`add` / `replace` / `remove`) to either store. |
| `session_search` | `memory` | Full-text search across persisted session messages, scoped to the current session id. |

## How it works

`createMemoryReadTool` (`src/index.ts:7`) calls `memory.prefetch` with the full `ToolContext` (sessionId, sessionKey, platform, workingDir, personalityId, memoryScope) so the provider can apply the same filtering it uses when building the system prompt. When `store === 'memory'` or `store === 'user'`, the result is sliced via `extractSection` (`src/index.ts:200`) which finds the requested `## Memory` or `## About You` header and returns up to the next `\n## ` header — matching the markdown structure the memory provider emits.

`createMemoryWriteTool` (`src/index.ts:62`) validates `store` and `action` against their enums, then forwards a single-element `MemoryUpdate[]` to `memory.sync`. `substring_match` is renamed to `substringMatch` to match the `MemoryUpdate` field shape. The result string is just a confirmation (`Appended to MEMORY.md`, etc.) — the actual file write is the provider's responsibility.

`createSessionSearchTool` (`src/index.ts:140`) caps `limit` at 50 (`Math.min(limit ?? 10, 50)`) and pins the search to `ctx.sessionId` so cross-session leaks don't happen by accident. Each result is rendered as `N. [YYYY-MM-DDTHH:MM] <snippet>` for the LLM to scan.

## Gotchas

- `extractSection` matches the literal headers `## Memory` and `## About You`. If the memory provider ever changes those header strings, the section filter breaks silently and returns the empty fallback.
- `memory_write` only supports a single update per call; the LLM can't batch.
- `memory_read` has `maxResultChars: 20_000`; the provider's own truncation marker is appended as `\n\n[truncated]` only in the `'both'` branch, not in the section-filtered branches.
- `session_search` requires the wired `SessionStore` to implement `search()` — the in-memory store returns `[]`, so this tool is only useful with `@ethosagent/session-sqlite` (which has FTS5).

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Three tool factories, the `extractSection` helper, and the `createMemoryTools(memory, session)` aggregate factory. |
