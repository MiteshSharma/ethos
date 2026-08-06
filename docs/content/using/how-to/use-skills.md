---
title: "Install and use skills"
description: "Install skills from ClawHub, reuse Claude Code or Hermes libraries already on disk, and invoke them inside ethos chat."
kind: how-to
audience: user
slug: use-skills
time: "10 min"
updated: 2026-05-12
---

## Task

Install a [skill](../../getting-started/glossary.md#skill) into `~/.ethos/skills/`, reuse skills already on disk under Claude Code or OpenClaw, and invoke them inside `ethos chat`.

## Result

`ethos skills list` shows the skill under its source. `ethos chat` loads it on a relevant message, or `/skill-name` invokes it directly.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- A network connection for ClawHub installs, or an existing skill library on disk for reuse.
- `node` 24+ on `PATH` — `ethos skills install` falls back to `npx clawhub@latest` if no global `clawhub` is found.

## Steps

### 1. List what's already discovered

```bash
ethos skills list
```

Output groups skills by source. The expected labels are:

| Source label | Path | Trust tier |
|---|---|---|
| `ethos-bundled` | shipped inside `@ethosagent/skills-library` | trusted-repo |
| `ethos` | `~/.ethos/skills/` | trusted-repo |
| `claude-code` | `~/.claude/skills/` | community |
| `claude-code-project` | `./.claude/skills/` in the cwd | community |
| `opencode-project` | `./.opencode/skills/` in the cwd | community |

The list comes from [`extensions/skills/src/universal-scanner.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/skills/src/universal-scanner.ts). Other Hermes or OpenClaw paths are opt-in — see step 4.

### 2. Install a skill from ClawHub

```bash
ethos skills install steipete/slack
```

The CLI:

1. Acquires a lock at `~/.ethos/skills/.lock` so concurrent installs serialise.
2. Runs `clawhub install` (or `npx clawhub@latest`) into a per-pid temp dir.
3. Runs the safety scanner against the candidate `SKILL.md` — red findings block; yellow on community-tier installs prompts.
4. Atomically renames the temp directory into `~/.ethos/skills/<slug>/` so a killed process never leaves a half-written skill.

Variants the installer accepts:

```bash
ethos skills install steipete/slack          # ClawHub slug
ethos skills install github:owner/repo       # any public GitHub repo
ethos skills install github:owner/repo/path  # a nested skill in a repo
```

### 3. Manage installed skills

```bash
ethos skills list                   # show all discovered skills, grouped by source
ethos skills update                 # re-run the installer for every ClawHub slug
ethos skills update steipete/slack  # update one
ethos skills remove steipete/slack  # delete one
```

### 4. Reuse skills from Claude Code, Hermes, or OpenClaw

If your skills already live at `~/.claude/skills/`, the scanner picks them up at boot — nothing to copy. Claude Code project-local skills under `./.claude/skills/` in the working directory load too.

For Hermes (`~/.hermes/skills/`) or OpenClaw (`~/.openclaw/skills/`), the discovery is opt-in. Two options:

- **Migrate once** with `ethos claw migrate` — see [Migrate from OpenClaw](migrate-from-openclaw.md).
- **Symlink** the source dir under `~/.ethos/skills/`:

```bash
ln -s ~/.openclaw/skills ~/.ethos/skills/openclaw
ln -s ~/.hermes/skills   ~/.ethos/skills/hermes
```

The scanner dedupes by qualified name (`<source>/<name>`), so symlinks don't double-count.

### 5. Author your own skill

A skill is a directory under `~/.ethos/skills/` with one entry file. Minimum shape:

```text
~/.ethos/skills/explain-code/
└── SKILL.md
```

`SKILL.md` is markdown with YAML frontmatter:

```markdown
---
name: explain-code
description: Walks through unfamiliar code with an analogy plus an ASCII diagram. Use when the user asks "how does this work?".
---

When the user asks how some code works:

1. Open the file with the read_file tool.
2. Lead with one everyday analogy.
3. Draw an ASCII diagram of the call flow.
4. Walk the code top to bottom; call out one common gotcha at the end.
```

Restart `ethos chat` (or just start a new turn — the scanner is mtime-cached) and `/explain-code` becomes available.

### 6. Invoke a skill

Two paths:

- **Model-invoked** — when the user message matches the skill's `description`, the agent loads the skill body into context for that turn. No special syntax.
- **User-invoked** — type `/<skill-name>` as the first token of your message. Required for any skill with `disable-model-invocation: true` in its frontmatter.

The active [personality](../../getting-started/glossary.md#personality)'s [toolset](../../getting-started/glossary.md#tool) gates skills the same way it gates tools — a skill listing `required_tools: [terminal_run]` only flows into a personality whose `toolset.yaml` allows `terminal_run`.

### 7. Wire a skill into a personality

Edit `~/.ethos/personalities/<id>/toolset.yaml` to expose a skill alongside the personality's tools:

```yaml
tools:
  - read_file
  - search_web
  - steipete/slack
```

Switch personalities with `/personality <id>` and only the listed entries are reachable for that turn.

## Verify

```bash
ethos skills list
```

The installed slug appears under `ethos` (or `claude-code` if it lived there to begin with). Then inside chat:

```text
/explain-code apps/ethos/src/index.ts
```

The agent should respond with the skill's prescribed structure. Run `/skills` inside the chat to inspect the skills the active personality sees this turn.

## Troubleshoot

**`Skill 'foo/bar' blocked by safety scan`.** — The pre-install scanner flagged red content (prompt-injection patterns). Review the findings printed above the error. Remove the offending lines or pick a different skill — there is no `--force` flag.

**`another skill install is in progress (lock held: .../.lock)`.** — A previous run died without releasing the lock. Wait 60 seconds; the next caller times out and prints the lock path. If no other process is running, remove the lock file manually.

**`installer produced no SKILL.md`.** — The slug resolved to a directory without a `SKILL.md` leaf. Check the spelling and the upstream repo layout — ClawHub expects `<slug>/SKILL.md` or `<scope>/<name>/SKILL.md`.

**Skill installed but `ethos chat` ignores it.** — The active personality's `toolset.yaml` may not allow the skill's `required_tools`. Run `/skills` inside chat to see what flowed through the per-personality filter. Switch to a personality whose toolset covers the requirement, or extend the current one.

**Skill at `~/.openclaw/skills/foo/` not visible in `ethos skills list`.** — External tool homes are opt-in. Symlink it under `~/.ethos/skills/` or run `ethos claw migrate` once.

**`clawhub: command not found` and `npx` is slow.** — Install ClawHub globally: `npm i -g clawhub`. Subsequent `ethos skills install` calls use the global binary instead of `npx`.
