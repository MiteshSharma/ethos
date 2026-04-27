# @ethosagent/skills

`ContextInjector` implementations that load skill markdown files, project context (`AGENTS.md` / `CLAUDE.md` / `SOUL.md`), and memory guidance into the system prompt — with a prompt-injection sanitizer and OpenClaw skill compatibility.

## Why this exists

`AgentLoop` builds the system prompt from a list of `ContextInjector`s sorted by priority. The injectors here are how an Ethos agent actually picks up your project's `AGENTS.md`, the personality's skill markdown files, and any third-party OpenClaw / ClawHub skills you've dropped into `~/.ethos/skills/`. Without these injectors the system prompt would contain only the personality's `ETHOS.md` and memory; nothing project- or skill-specific would reach the model.

This package also implements OpenClaw frontmatter parsing (`metadata.openclaw|clawdbot|clawdis`) so skills authored for other agent frameworks load without modification — see the migrate-from-openclaw guide for context.

## What it provides

- `SkillsInjector` (priority 100) — discovers skill files from the active personality's `skillsDirs` plus the global `~/.ethos/skills/` directory.
- `FileContextInjector` (priority 90) — reads `AGENTS.md`, `CLAUDE.md`, `SOUL.md` from `ctx.workingDir` (first match per file, all three appended if present).
- `MemoryGuidanceInjector` (priority 80) — appends a static prompt teaching the model how to use `memory_read` / `memory_write` / `session_search`. Only fires after turn 0.
- `sanitize()` — strips lines matching adversarial prompt-injection patterns (`ignore previous instructions`, `[SYSTEM]`, etc.) from any injected content.
- `parseSkillFrontmatter`, `shouldInject`, `applySubstitutions` — OpenClaw compat helpers (env/bin/os gating, `${ETHOS_SKILL_DIR}` and `${ETHOS_SESSION_ID}` substitution).
- `createInjectors(personalities, config)` — convenience factory used by `apps/ethos/src/wiring.ts:94`.

## How it works

`SkillsInjector.discoverSkillFiles` (`src/skills-injector.ts:109`) supports three layouts in the same directory: top-level `*.md` (legacy Ethos), `<slug>/SKILL.md` (OpenClaw), and `<scope>/<slug>/SKILL.md` (ClawHub-style). Files are sorted alphabetically so injection order is deterministic. Subdirectories named `pending` or starting with `.` are skipped (this matches the convention in `@ethosagent/skill-evolver` which writes drafts into `skills/pending/`).

For each discovered file, `parseSkillFrontmatter` (`src/skill-compat.ts:51`) parses the optional YAML frontmatter using a hand-rolled minimal parser (no external YAML dep). If a skill declares `metadata.openclaw.requires.{env,bins,anyBins}` or `metadata.openclaw.os`, `shouldInject` (`src/skill-compat.ts:78`) gates the skill against the current process — missing env vars or binaries trigger the `onSkip` callback and the skill is silently dropped from this turn.

Both `SkillsInjector` and `FileContextInjector` cache file contents by mtime. Cache hits skip the read entirely; misses re-read from disk. Cache lives for the lifetime of the injector, so the chat REPL gets free hot-reload.

Every injected string passes through `sanitize()` (`src/prompt-injection-guard.ts`) before reaching the system prompt. Lines matching the eight adversarial patterns are replaced with `[line removed by injection guard]` so the gap is visible in the assembled prompt.

The CLI tracks which skill files were actually injected by writing `ctx.meta.skillFilesUsed` (`src/skills-injector.ts:62`). The eval / evolve commands consume this to attribute task scores back to specific skill files.

## On-disk layout

Skill discovery (per directory):

```
<dir>/
  some-skill.md            # legacy Ethos: top-level markdown
  cool-skill/SKILL.md      # OpenClaw layout
  steipete/slack/SKILL.md  # scoped (e.g. published to ClawHub)
  pending/                 # SKIPPED (used by skill-evolver for drafts)
```

Project context (per `ctx.workingDir`):

```
<cwd>/AGENTS.md   # checked first
<cwd>/CLAUDE.md   # checked second
<cwd>/SOUL.md     # checked third
```

All three files are appended if present — there is no priority ordering between them.

## Gotchas

- The minimal YAML parser handles only the OpenClaw subset: 2-space indent, scalar values, inline arrays `[a, b, c]`, and nested `requires` maps. Anything richer will silently parse as the empty record.
- `hasBinary()` (`src/skill-compat.ts:168`) walks `PATH` synchronously to avoid spawning `which`/`where`. On Windows it tries `PATHEXT` extensions in order.
- `MemoryGuidanceInjector` returns `null` on turn 0 (via `shouldInject`) to avoid bloating the first prompt with guidance the model doesn't yet need.
- `SkillsInjector` deduplicates `skillsDirs` against the global dir using `new Set` — listing the global dir in a personality's `skillsDirs` is harmless, not duplicated.
- `sanitize()` is line-by-line. Multi-line attacks split across lines won't be caught — keep this in mind if you author skills that legitimately need words like "ignore" or "system".

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Public exports + `createInjectors()` factory. |
| `src/skills-injector.ts` | `SkillsInjector` — skill discovery, mtime cache, OpenClaw gating. |
| `src/file-context-injector.ts` | `FileContextInjector` — `AGENTS.md` / `CLAUDE.md` / `SOUL.md` loader. |
| `src/memory-guidance-injector.ts` | `MemoryGuidanceInjector` — static memory-tool guidance. |
| `src/prompt-injection-guard.ts` | `sanitize()` — adversarial-pattern line stripper. |
| `src/skill-compat.ts` | OpenClaw frontmatter parser, `shouldInject`, `applySubstitutions`, minimal YAML. |
| `src/__tests__/` | Injector + skill-compat tests. |
