---
title: Memory System
description: How Ethos memory works — prefetch/sync cycle, MEMORY.md and USER.md, and memory scope per personality.
sidebar_position: 4
---

# Memory System

Ethos uses a file-based memory system. Two markdown files in `~/.ethos/` give the agent persistent context across sessions.

## The two files

```
~/.ethos/
├── MEMORY.md    ← rolling project context (updated after sessions)
└── USER.md      ← who you are (persistent across sessions and personalities)
```

**`USER.md`** is written once and updated occasionally. It describes you: your role, expertise, preferences, and how you like to work. The agent reads this to calibrate its responses to you.

**`MEMORY.md`** is a rolling log. After each session, the agent appends what it learned, what changed, and what's in progress. It's the equivalent of handoff notes — context that would otherwise be lost between sessions.

## Prefetch/sync cycle

Every turn follows this pattern:

1. **Prefetch** — before building the system prompt, `MemoryProvider.prefetch()` reads both files. Their contents become part of the system context for the turn.
2. **Sync** — after the turn completes, `MemoryProvider.sync(updates)` applies any `MemoryUpdate[]` the model returned.

If both files are empty or absent, `prefetch()` returns `null` and the system prompt is built without a memory section. No error.

## MemoryUpdate actions

The model can request three types of memory update:

```typescript
type MemoryUpdate =
  | { action: 'add';     content: string }
  | { action: 'replace'; content: string }
  | { action: 'remove';  substringMatch: string }
```

| Action | Effect |
|---|---|
| `add` | Appends `content` to the end of the file |
| `replace` | Overwrites the entire file with `content` |
| `remove` | Removes lines containing `substringMatch` |

## Memory scope

Each personality can have its own memory scope, configured in `config.yaml`:

```yaml
memoryScope: global           # reads/writes ~/.ethos/MEMORY.md
# or
memoryScope: per-personality  # reads/writes ~/.ethos/personalities/<id>/MEMORY.md
```

**`global`** — all global-scope personalities share the same `MEMORY.md`. Research findings from the researcher personality are visible to the engineer personality. Good for personalities that collaborate on the same work.

**`per-personality`** — each personality maintains its own isolated memory. The reviewer's feedback notes don't appear in the engineer's context. Good for personas that should stay separate.

## Viewing memory

```
/memory
```

Prints the current contents of both `MEMORY.md` and `USER.md` in the chat session.

## Customising the provider

The default `MarkdownFileMemoryProvider` reads flat markdown files. To use a different backend (database, Redis, remote storage), implement `MemoryProvider` from `@ethosagent/types` and inject it at construction. See [Custom memory providers](/docs/extending-ethos/custom-memory-providers).
