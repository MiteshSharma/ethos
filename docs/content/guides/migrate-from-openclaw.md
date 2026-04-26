---
title: Migrate from OpenClaw (and use clawhub skills)
description: Migrate an existing OpenClaw install into Ethos in one command, and install any clawhub skill into your personality's toolset.
sidebar_position: 4
---

# Migrate from OpenClaw (and use clawhub skills)

Ethos is OpenClaw-compatible. If you have an existing OpenClaw install, you can migrate it in one command. And whether you migrate or start fresh, you can install **any** [clawhub](https://www.npmjs.com/package/clawhub) skill directly into your personality's toolset — the full catalog runs unmodified.

---

## 1. Migrate an existing OpenClaw install

The CLI ships with a migrator that reads `~/.openclaw/` and writes to `~/.ethos/` without touching the source.

### Preview first

```bash
ethos claw migrate --dry-run
```

You'll get a printed plan that lists:

- **memories** — `MEMORY.md`, `USER.md`, plus any auxiliary memory files
- **skills** — every installed skill directory
- **platform tokens** — Slack, Discord, Telegram, email
- **API keys** — provider keys from your existing config
- **personality** — either resolved to a built-in match or migrated from your `SOUL.md`

Nothing is written.

### Apply the migration

```bash
ethos claw migrate            # interactive — prompts before writing
ethos claw migrate -y         # skip the confirmation prompt
ethos claw migrate --overwrite -y     # clobber existing target files
ethos claw migrate --preset user-data # skip the personality copy
```

The migration is **idempotent** — re-running it after a partial run is safe. If a target file already exists, the migrator skips it (or overwrites with `--overwrite`).

### What gets copied

| Source (under `~/.openclaw/`) | Target (under `~/.ethos/`) |
|---|---|
| `MEMORY.md`, `USER.md`, `*.md` memory files | same names |
| `skills/<slug>/` | `skills/<slug>/` |
| Platform tokens in `config.yaml` | merged into `~/.ethos/config.yaml` |
| Provider API keys | merged into `~/.ethos/config.yaml` |
| `SOUL.md` (if present) | becomes a personality under `~/.ethos/personalities/migrated/` |

After migration, run `ethos setup` if you want to verify your config or change the active personality.

### Source not found

If `~/.openclaw/config.yaml` doesn't exist, the command exits without changes:

```
No OpenClaw install found at /Users/you/.openclaw.
```

You can still use `ethos skills install` independently — see below.

---

## 2. Install any clawhub skill

The `ethos skills` command wraps [clawhub](https://www.npmjs.com/package/clawhub). It uses a globally-installed `clawhub` if available, otherwise falls back to `npx clawhub@latest`.

```bash
ethos skills install steipete/slack          # by clawhub slug
ethos skills install github:owner/repo       # by GitHub source
ethos skills install github:owner/repo/path  # nested skill in a repo

ethos skills list                            # show installed slugs
ethos skills update                           # update all
ethos skills update <slug>                    # update one
ethos skills remove <slug>                    # remove one
```

Skills install into `~/.ethos/skills/` and become available to any personality whose `toolset.yaml` lists them.

### How OpenClaw skills run inside Ethos

The OpenClaw-compatibility layer in `extensions/skills/skill-compat.ts` handles three things:

1. **Frontmatter parsing** — reads the YAML header in each `SKILL.md`
2. **Environment substitutions** — resolves `${ENV_VAR}` references at load time
3. **OS gates** — honours `os: [darwin, linux]` style requirements and skips skills that don't match the host

So the entire clawhub catalog is reachable without forking or maintaining a shim layer.

### Where skills live on disk

```
~/.ethos/skills/
├── steipete/
│   └── slack/
│       └── SKILL.md
└── owner/
    └── repo/
        └── SKILL.md
```

`ethos skills list` walks this tree and prints every slug it finds.

---

## 3. Wire skills into a personality

A personality's `toolset.yaml` controls which installed skills it can call:

```yaml title="~/.ethos/personalities/researcher/toolset.yaml"
tools:
  - search_web
  - read_file
  - steipete/slack          # clawhub slug
```

Switch personalities with `/personality <id>` in chat — only the listed skills will be invokable for that personality.

---

## What's next

- [Built-in Personalities](/docs/personality/built-in-personalities) — see what each personality already includes
- [Create your own personality](/docs/personality/create-your-own) — bundle a curated toolset
- [CLI Reference](/docs/cli-reference) — full command reference
