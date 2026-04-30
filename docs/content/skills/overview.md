---
title: Skills Overview
description: How Ethos discovers, loads, and scopes skills — universal scanner across Claude Code, OpenClaw, OpenCode, Hermes, plus the per-personality filter.
sidebar_position: 1
---

# Skills

Skills are reusable instruction packets — playbooks, checklists, conventions — that the agent loads when relevant. Ethos follows the [Agent Skills](https://agentskills.io) open standard, the same format used by Claude Code, OpenCode, Cursor, Junie, Goose, and 30+ other frameworks.

This means **your existing skill library works in Ethos with no porting**. Drop a skill once; every framework that adopts the standard finds it.

## What Ethos does that others don't

Two things, and both matter:

1. **Universal discovery.** Ethos scans every common skill location on your machine — `~/.claude/skills/`, `~/.openclaw/skills/`, `~/.opencode/skills/`, `~/.hermes/skills/`, plus its own `~/.ethos/skills/` and any project-local variants. Three dialect parsers (agentskills.io, OpenClaw, Hermes) handle each format.

2. **Per-personality filter.** The discovered pool is filtered per personality. By default, a skill flows to a personality only if its `required_tools` are reachable by that personality's toolset. Your `researcher` doesn't see deploy skills; your `engineer` doesn't see dietary research skills. Same global library, different visibility per role.

No other framework gives you both. ([why-ethos](../getting-started/why-ethos))

---

## Quickstart — your first skill (90 seconds)

```bash
mkdir -p ~/.ethos/skills/explain-code
```

Create `~/.ethos/skills/explain-code/SKILL.md`:

```markdown
---
name: explain-code
description: Explains code with an analogy + ASCII diagram. Use when the user asks "how does this work?" or wants a tour of unfamiliar code.
---

When explaining code:

1. Start with an analogy from everyday life
2. Draw an ASCII diagram showing the flow
3. Walk through the code step by step
4. Highlight one common gotcha
```

That's it. Open `ethos chat`, ask "how does this auth code work?", and the skill loads automatically.

To invoke directly:

```text
/explain-code src/auth/login.ts
```

---

## Where skills are discovered

Ethos scans these paths at startup. Each is parsed with the appropriate dialect; duplicates across sources are deduped by qualified name (`<source>/<name>`).

| Path | Source label | Dialect | When |
|---|---|---|---|
| `~/.ethos/skills/<name>/SKILL.md` | `ethos` | agentskills.io | Always |
| `.ethos/skills/<name>/SKILL.md` | `ethos-project` | agentskills.io | When run inside a project with this dir |
| `~/.claude/skills/<name>/SKILL.md` | `claude-code` | agentskills.io | When the dir exists |
| `.claude/skills/<name>/SKILL.md` | `claude-code-project` | agentskills.io | Project-local |
| `~/.openclaw/skills/<name>/SKILL.md` | `openclaw` | OpenClaw | When the dir exists |
| `~/.opencode/skills/<name>/SKILL.md` | `opencode` | agentskills.io | When the dir exists |
| `~/.hermes/skills/<name>/SKILL.md` | `hermes` | Hermes | When the dir exists |

Ethos caches per-source by mtime — re-reading a directory only when something changed on disk.

### Where to put new skills

If you only use Ethos, put them in `~/.ethos/skills/`. If you also use Claude Code or another framework that follows the same standard, put them in `~/.<framework>/skills/` so both tools find them.

---

## SKILL.md format

Every skill is a directory with `SKILL.md` as the entrypoint. Optional supporting files (scripts, references, assets) live alongside it.

```text
my-skill/
├── SKILL.md           # Required — main instructions + frontmatter
├── reference.md       # Optional — detailed reference, loaded on demand
├── examples/          # Optional — sample outputs for the agent to follow
└── scripts/           # Optional — executables the skill invokes
    └── helper.sh
```

`SKILL.md` is markdown with a YAML frontmatter block at the top:

```markdown
---
name: skill-id-here
description: One sentence describing what this skill does and when to use it.
---

Markdown body — the instructions the agent follows when this skill activates.
Reference supporting files like [reference.md](./reference.md) if you have them.
```

### Frontmatter reference

| Field | Required | Description |
|---|---|---|
| `name` | No | Slug used for `/skill-name`. Defaults to the directory name. Lowercase + hyphens, max 64 chars. |
| `description` | **Recommended** | What the skill does and when to use it. The agent reads this to decide when to load the skill. Keep keywords up front; truncated at ~1500 chars. |
| `required_tools` | No | List of tool names the skill needs (e.g. `[read_file, web_search]`, or `[mcp__filesystem__*]`). The per-personality filter uses this — see [Per-personality filter](./per-personality-filter). |
| `tags` | No | List of semantic tags (e.g. `[research, citation]`). Used by `tags` filter mode. |
| `disable-model-invocation` | No | `true` = only the user can invoke via `/name`. Use for skills with side effects (deploy, commit). |
| `allowed-tools` | No | Tools the skill can use without per-call permission. |
| `argument-hint` | No | Hint shown during autocomplete (e.g. `[issue-number]`). |

Other fields from the agentskills.io spec are accepted by the parser and ignored if Ethos doesn't have a use for them yet — your skills stay portable.

---

## Migrating an existing library

You probably don't have to. If your skills are already at `~/.claude/skills/` or `~/.openclaw/skills/`, the universal scanner picks them up at next startup. No copy step.

If they're in a non-standard location, either move them to one of the discovered paths above or add a symlink:

```bash
ln -s ~/projects/team-skills ~/.ethos/skills/team
```

To verify what got discovered, start the agent and watch the boot output:

```text
$ ethos chat
Skills loaded: 47 total · 14 visible to <active-personality>
  sources: ethos (12), claude-code (28), openclaw (7)
```

---

## Distribution scopes

| Scope | Path | Visible to |
|---|---|---|
| **Personal** | `~/.ethos/skills/<skill>/SKILL.md` | All your projects on this machine |
| **Project** | `.ethos/skills/<skill>/SKILL.md` (committed) | Anyone running Ethos in this repo |
| **Cross-framework** | `~/.claude/skills/<skill>/SKILL.md` | Ethos AND Claude Code AND any other agentskills.io client |
| **clawhub catalogue** | `ethos skills install <slug>` | Pulls from [clawhub.ai](https://clawhub.ai) into `~/.ethos/skills/` |

For project-level skills, commit `.ethos/skills/` to version control. Anyone who clones the repo and runs `ethos chat` gets the skills automatically.

---

## What happens at runtime

1. Universal scanner walks every source path; the dialect parser produces a unified `Skill` record per directory.
2. Records are deduped by qualified name (`<source>/<name>`). Conflicts: enterprise > personal > project, last-write-wins within a source.
3. The active personality's filter (default `capability` mode) decides which skills flow into the prompt.
4. Skills that pass the filter become part of the system prompt for the next turn.
5. mtime cache means re-startup is fast; only changed sources get re-parsed.

---

## Next steps

- [Per-personality filter](./per-personality-filter) — the unique Ethos behaviour: how a skill is gated per role.
- [Create a personality](../personality/create-your-own) — pair custom personalities with curated skill libraries.
- [agentskills.io standard](https://agentskills.io) — the format spec; same skill works in Claude Code, OpenCode, Cursor, Junie, etc.
