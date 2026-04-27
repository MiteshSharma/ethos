# @ethosagent/memory-markdown

`MemoryProvider` backed by two flat markdown files: `MEMORY.md` (rolling project memory) and `USER.md` (who the human is).

## Why this exists

Ethos personalities need persistent context across sessions but don't always need a database. This provider writes plain markdown that the user can open in any editor, version-control, or copy between machines. It's the default memory implementation wired in `apps/ethos/src/wiring.ts`. The split between `MEMORY.md` (per-personality when scoped) and `USER.md` (always shared, since it describes the human) is enforced here, not in core.

## What it provides

- `MarkdownFileMemoryProvider` — implements `MemoryProvider` from `@ethosagent/types`.
- `MarkdownMemoryConfig` — `{ dir?, maxChars? }`. `dir` defaults to `~/.ethos`, `maxChars` to `20_000`.

## How it works

`prefetch()` (`src/index.ts:42`) reads `USER.md` from the shared root and `MEMORY.md` from a directory chosen by `resolveMemoryDir()` — either the shared root (`memoryScope: 'global'` or unset) or `<root>/personalities/<id>/` (`memoryScope: 'per-personality'`). USER.md is *always* shared because it describes the human, not the agent. Returns `null` when both files are empty or absent so the system prompt skips the memory section entirely.

When the combined content exceeds `maxChars`, the *tail* is kept and `[...truncated]` is prepended (`src/index.ts:58`). The most recent memory lives at the end of the file, so trimming the head loses the least signal.

`sync()` (`src/index.ts:65`) groups updates by `store` (`memory` or `user`), routes `memory` to the scope-resolved path and `user` to the shared root, then applies sequentially. The three update actions in `applyUpdates`:

- `add` — appends after a blank line, normalising trailing whitespace.
- `replace` — overwrites the file with the new content.
- `remove` — line-level filter; drops any line containing `substringMatch`.

Personality IDs are validated by `isSafePersonalityId` (`src/index.ts:138`) — only `[a-zA-Z0-9_-]+`. An invalid id silently falls back to the shared root rather than risking path traversal.

## Gotchas

- USER.md is always at `<dir>/USER.md` regardless of `memoryScope`. Do not "fix" this — it's intentional.
- `remove` matches by substring on each line. There is no regex support, no multi-line matching, and the match is case-sensitive.
- Truncation keeps the *tail*. If you want head-biased retention, use a different provider.
- `prefetch` returns `null` when both files are empty or unreadable. `AgentLoop` treats null as "no memory section" rather than an empty one.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `MarkdownFileMemoryProvider`, scope resolution, update application, ID validation. |
