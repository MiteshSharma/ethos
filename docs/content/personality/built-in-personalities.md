---
title: Built-in Personalities
description: The five personalities that ship with Ethos — researcher, engineer, reviewer, coach, and operator.
sidebar_position: 2
---

# Built-in Personalities

Five personalities ship out of the box. Each has a first-person identity (`ETHOS.md`), a curated toolset, and a memory scope.

| Personality | Identity | Tools | Model | Memory scope |
|---|---|---|---|---|
| `researcher` | methodical · cites sources · flags uncertainty | 8 (web + file + memory) | `claude-opus-4-7` | `global` |
| `engineer` | terse · code-first · runs commands to verify | 10 (terminal + file + web + code) | `claude-sonnet-4-6` | `global` |
| `reviewer` | critical · evidence-based · always explains why | 3 (file + session search) | `claude-sonnet-4-6` | `per-personality` |
| `coach` | warm but direct · question-led · helps you think | 5 (web + memory + session) | `claude-opus-4-7` | `global` |
| `operator` | cautious · confirms before destructive · documents everything | 7 (terminal + file + code) | `claude-sonnet-4-6` | `per-personality` |

> Tool counts are the actual tool names declared in `extensions/personalities/data/<id>/toolset.yaml`. Categories shown for shape; see each section below for the full list. Models are the personality's intended fit (Phase 21 multi-model routing) — override per-personality via `~/.ethos/config.yaml` `modelRouting`.

Switch with `/personality <id>` in chat or `ethos personality set <id>` from the shell.

---

### researcher

A methodical research assistant that prioritises accuracy over speed. Cites sources. Distinguishes clearly between known facts and inferences. Acknowledges uncertainty rather than speculating.

**When to use:** Research tasks, fact-checking, summarising documents, answering questions that require web lookup.

```yaml title="toolset.yaml"
tools:
  - web_search
  - read_file
  - memory
```

Memory scope: `global` — shares context with other global-scope personalities so research findings carry over to engineer sessions.

---

### engineer

A senior engineer persona: terse, direct, code-first. Prefers showing code over explaining it. Runs commands to verify rather than theorise. Does not pad responses.

**When to use:** Writing code, debugging, shell tasks, code review, anything where you want a direct technical collaborator.

```yaml title="toolset.yaml"
tools:
  - terminal
  - read_file
  - write_file
  - web_search
  - code_execution
```

Memory scope: `global` — shares the same memory as researcher so project context persists across modes.

---

### reviewer

A critical, structured reviewer. Looks for problems. Provides evidence-based feedback. Does not encourage for encouragement's sake. Only has read access — cannot modify files.

**When to use:** Code review, document review, design critique. The restricted toolset (file read only) is intentional — a reviewer should not be able to change things.

```yaml title="toolset.yaml"
tools:
  - read_file
```

Memory scope: `per-personality` — review context is isolated so reviewer feedback doesn't bleed into general memory.

---

### coach

A warm, questioning coach focused on growth. Asks good questions rather than giving answers. Connects present challenges to longer-term goals. Encourages reflection.

**When to use:** Thinking through decisions, planning, career conversations, unblocking yourself when stuck.

```yaml title="toolset.yaml"
tools:
  - web_search
  - memory
```

Memory scope: `global` — remembers your goals and ongoing challenges across sessions.

---

### operator

An ultra-cautious operator. Confirms before acting. Runs dry-run variants first. Prefers reversible over irreversible actions. No web access (reduces attack surface).

**When to use:** Infrastructure tasks, deployments, anything where an accidental destructive command would be costly.

```yaml title="toolset.yaml"
tools:
  - terminal
  - read_file
  - write_file
  - code_execution
```

Memory scope: `per-personality` — operational context (what was deployed, what was changed) is isolated from general memory.
