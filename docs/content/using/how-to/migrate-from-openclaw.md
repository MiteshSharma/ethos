---
title: "Migrate from OpenClaw"
description: "Move an OpenClaw install into Ethos in one command. Copies memory, skills, platform tokens, API keys, and the SOUL.md persona."
kind: how-to
audience: user
slug: migrate-from-openclaw
time: "5 min"
updated: 2026-05-22
---

## Task

Move an existing `~/.openclaw/` install into `~/.ethos/` — memory files, [skills](../../getting-started/glossary.md#skill), platform tokens, provider API keys, and the OpenClaw `SOUL.md` — in a single command, without touching the source tree.

## Result

`~/.ethos/` contains your OpenClaw state, the SOUL becomes a migrated [personality](../../getting-started/glossary.md#personality), and `ethos chat` continues your conversations.

## Prereqs

- An existing OpenClaw install at `~/.openclaw/config.yaml`. The migrator exits without changes if that file is absent.
- `ethos` installed and on `PATH`.
- Write access to `~/.ethos/`. The migrator creates the directory if it does not exist.

## Steps

### 1. Preview the plan

Always dry-run first. The migrator prints every operation it would perform; no files are written.

```bash
ethos claw migrate --dry-run
```

The plan summary lists:

- **memories** — `MEMORY.md`, `USER.md`, and any auxiliary memory files under `~/.openclaw/`.
- **skills** — every installed skill directory under `~/.openclaw/skills/`.
- **platform tokens** — Telegram, Slack, Discord tokens from the OpenClaw `config.yaml`.
- **API keys** — provider keys from the same config.
- **personality** — a built-in match if your OpenClaw persona maps cleanly, otherwise a fresh personality at `~/.ethos/personalities/migrated/` built from `SOUL.md`.

### 2. Run the migration

```bash
ethos claw migrate            # interactive — prompts before writing
ethos claw migrate --yes      # skip the confirmation prompt
ethos claw migrate --overwrite --yes      # clobber files already in ~/.ethos/
ethos claw migrate --preset user-data     # memory + tokens + keys only; skip skills and persona
```

The run is idempotent. If a target file already exists, the migrator skips it; pass `--overwrite` to replace it. Killing the process mid-run leaves `~/.ethos/` in a consistent state — each file is renamed into place atomically.

### 3. What gets copied where

| Source under `~/.openclaw/` | Target under `~/.ethos/` |
|---|---|
| `MEMORY.md`, `USER.md`, other `*.md` memory files | same filenames |
| `skills/<slug>/` | `skills/<slug>/` |
| `telegramToken`, `slackBotToken`, etc. in `config.yaml` | merged into `~/.ethos/config.yaml` |
| Provider API keys | merged into `~/.ethos/config.yaml` |
| `SOUL.md` (when present) | new personality at `~/.ethos/personalities/migrated/` |

The implementation lives in [`extensions/claw-migrate/src/`](https://github.com/ethosagent/ethos/blob/main/extensions/claw-migrate/src/index.ts).

The two presets:

- `--preset all` (default) — copies every category above.
- `--preset user-data` — copies memory, platform tokens, and API keys only. Use this on a host that already has a curated personality and skill library you don't want to overwrite.

### 4. Pick up the migrated personality

The migrated persona is named `migrated`. Set it as the active default:

```bash
ethos personality set migrated
ethos chat
```

To duplicate it under a new id (useful before editing):

```bash
ethos personality duplicate migrated my-persona
```

Then edit `~/.ethos/personalities/my-persona/SOUL.md` and `config.yaml`.

### 5. Verify the provider stayed intact

The migration merges API keys into `~/.ethos/config.yaml` but does not re-run the provider selection wizard. Run `ethos doctor` to confirm the provider, model, and key are still valid:

```bash
ethos doctor
```

If the OpenClaw config used a provider name Ethos does not recognise (the catalog lives in [`packages/wiring/src/provider-catalog.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/provider-catalog.ts)), `doctor` flags it and `ethos setup auth` fixes it.

## Verify

```bash
ethos claw migrate --dry-run   # should report "Nothing to migrate."
ethos skills list              # OpenClaw skills appear under the "ethos" source
ethos personality list         # "migrated" appears alongside the built-ins
ethos doctor                   # provider and key validate
```

A `ethos chat` turn that references prior context — the agent reading from your migrated `MEMORY.md` — closes the loop.

## Troubleshoot

**`No OpenClaw install found at /Users/you/.openclaw.`** — The migrator looks for `~/.openclaw/config.yaml`. If your install lives elsewhere, symlink it into place or copy the directory before re-running.

**`Migration finished with N failures.`** — The output lists each failing operation with a `(reason)` suffix. Common causes: a target file is open in another editor, the filesystem is read-only, or a skill directory has a name with characters the migrator's atomic rename rejects.

**Target file already exists, skipped.** — The migrator never overwrites by default. Re-run with `--overwrite --yes` if you do want to replace `~/.ethos/` content with the OpenClaw version.

**`migrated` personality but no SOUL.md.** — OpenClaw installs without a `SOUL.md` fall back to the personality named in the OpenClaw `config.yaml`. If that name does not match an Ethos built-in, the migrator records it in the plan and you'll need to create the personality yourself.

**Platform tokens not picked up by the gateway.** — `ethos claw migrate` writes them, but `ethos gateway start` only sees them on the next start. Restart the gateway after migrating.

**ClawHub installs after the migration.** — `ethos skills install` is available the moment the migration completes. See [Install and use skills](use-skills.md) for the full skill workflow.
