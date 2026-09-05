---
title: "Back up and restore an Ethos install"
description: "Take an ethos backup, restore it onto another machine in one command, and tune the backup.* schedule keys."
kind: how-to
audience: user
slug: back-up-and-restore
time: "10 min"
updated: 2026-09-05
---

## Task

Archive everything your agent has become — config, [personalities](../../getting-started/glossary.md#personality) (directories of files that decide an agent's tools, memory, and model), conversation history, skills, boards — and put it back on this machine or a different one.

## Result

- A single `.tar.gz` you can copy anywhere.
- A new machine running the same agent, with the same history, after one command.
- A nightly archive you did not have to set up, and know how to turn off.

## Prereqs

- Ethos installed (`ethos --version` prints a version).
- Nothing else using this Ethos home during a restore — no `ethos chat`, `serve`, `gateway`, or desktop app.

## Steps

### 1. Take a backup

```bash
ethos backup
```

```
✓ Backup written to: ~/.ethos/backups/ethos-backup-2026-09-05T01-29-39-07c50f1a.tar.gz
  10 file(s), 272.6 KB · scopes: identity, state

  The state scope carries conversation history (sessions, cards, memory).
  Treat it as sensitive as the machine it came from.

  API keys and MCP tokens were NOT archived. The archive lists what is
  missing in secrets.manifest.yaml — refill with `ethos import --secrets prompt`.
```

With no path, the archive lands in `~/.ethos/backups/`. Pass a path (or `--out`) to write it somewhere else.

Two things are deliberately not in it. Secrets — `secrets/`, `keys.json`, `web-token`, MCP OAuth tokens — are excluded, and the archive carries a `secrets.manifest.yaml` naming what a restore has to refill. Machine-local queues — the delivery ledger, the inbound-dedup window, the notify queue — are excluded because replaying them on a second machine would resend real messages to real people.

### 2. Pick the scopes you want

Three scopes exist. `ethos backup` takes `identity,state` when you name none.

| Scope | Holds | In the default |
|---|---|---|
| `identity` | `config.yaml`, `mcp.json`, `MEMORY.md`, `USER.md`, `cron/jobs.json`, `personalities/` | yes |
| `state` | `sessions.db`, `cards.db`, `memory.db`, `board.db`, `jobs.db`, `calls.db`, `goals.db`, `dashboards.db`, `pairing.db`, `a2a/tasks.db`, plus `skills/`, `teams/`, `users/`, `digests/`, `cron/output/` and plugin pins | yes |
| `telemetry` | `observability.db` — metrics and traces | no, opt in |

```bash
ethos backup --scope identity
```

```
✓ Backup written to: ~/.ethos/backups/ethos-backup-2026-09-05T01-29-40-bb48e62d.tar.gz
  6 file(s), 5.5 KB · scopes: identity
```

An `identity`-only archive is the small, portable one: no conversation history, so it is the one to hand to someone else who wants your personalities.

### 3. Know what the nightly job is already doing

`backup.enabled` defaults to on. A serving process — `ethos serve`, `ethos gateway start`, or `ethos boot` — seeds a `backup` cron job on start and writes an `identity,state` archive at 04:00 local, keeping the newest seven. On an install that predates this feature, that begins at the next start; nothing asks first.

To change it, set the keys in `~/.ethos/config.yaml`:

```yaml
backup.enabled: true
backup.cron: 0 4 * * *
backup.scope: identity,state
backup.keep: 7
backup.dir: /mnt/snapshots/ethos
```

Every key is optional and every one is reconciled on the next serving-process start: a changed `cron` reschedules the existing job, and `backup.enabled: false` removes it. The full field table is in the [`backup.*` config reference](../reference/config-yaml.md#backup).

`ethos chat` alone runs no cron. A laptop that only ever runs `ethos chat` takes no scheduled backups — run `ethos backup` yourself.

### 4. Move to a new machine

Copy the archive across first — `scp`, a USB stick, whatever you already trust. `--restore` takes a local path, never a URL.

On the new machine:

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --restore ~/ethos-backup.tar.gz
```

```
✓ Will restore from /home/ada/ethos-backup.tar.gz after install
✓ Detected Linux x86_64
✓ Node 24.8.0 is already installed
✓ Installed @ethosagent/cli 0.7.3

Verifying /home/ada/ethos-backup.tar.gz...
✓ Archive verified against its manifest

✓ Restored 10 file(s) into /home/ada/.ethos
  scopes: identity, state · archive created 2026-09-05T01:29:39.252Z

  in-use check: ran — there was no existing database to displace.

✓ Restored. Verify with:
    ethos doctor
```

The order is fixed: install, then restore. `ethos import` is what does the restoring, so `ethos` has to exist first.

The installer verifies before it writes. It runs `ethos import --dry-run`, which streams the whole archive and checks every entry against the sha256 in the manifest — a truncated or edited archive is refused there, with your Ethos home untouched.

Under `curl … | bash` there is no terminal attached, so no secret prompts are shown. The import prints an `ethos secrets set <ref> <value>` line per missing credential instead; run those to finish. To be asked one question per secret instead, restore from a terminal:

```bash
ethos import ~/ethos-backup.tar.gz --secrets prompt
```

`ethos backup --bootstrap` prints the install and import lines for the archive it just wrote — the same move in two commands instead of one.

### 5. Restore onto a machine that already runs Ethos

Stop everything using this Ethos home first — `ethos chat`, `serve`, `gateway`, the desktop app.

Check what a restore would do before it does it:

```bash
ethos import ~/ethos-backup.tar.gz --dry-run
```

```
· Would restore 10 file(s) into /home/ada/.ethos
  scopes: identity, state · archive created 2026-09-05T01:29:39.252Z
  Dry run — nothing on disk was changed.

  in-use check: NOT made — a dry run cannot take the locks that answer it.
    A real restore may still be refused because something is running.
```

Then run it for real:

```bash
ethos import ~/ethos-backup.tar.gz --secrets prompt
```

Files the restore replaces are moved to `~/.ethos/.pre-restore/<timestamp>/`, not deleted. If you restored the wrong archive, that directory is what you copy back.

Restoring `identity` overwrites `config.yaml` and `mcp.json`, which are read at boot. The report says to restart; a process that was already running is still using the old ones.

## Verify {#verify}

`ethos status` names the newest archive:

```bash
ethos status
```

```
✓ backups       last 2026-09-05 01:29 (0.3 MB, ethos-backup-2026-09-05T01-29-39-07c50f1a.tar.gz, 2 kept)
```

After a restore, `ethos doctor` runs `PRAGMA integrity_check` over every store:

```bash
ethos doctor
```

```
Store integrity
  ✓  PRAGMA integrity_check ok on 4 store(s) (10 not created yet)
```

Then start the agent and ask it something only the old machine would know.

## Troubleshoot {#troubleshoot}

**`sessions.db is in use by another process`** — a `state` restore takes an exclusive lock on every database it is about to replace, and something is holding one. Stop `ethos chat`, `serve`, `gateway` and the desktop app, then retry. `--force` skips the check, and skipping it means nothing verified that another process was not mid-write.

**`Backup archive is corrupt: …`** — the archive failed its manifest checksum, and nothing was written. Restore from a different archive; a partial copy cannot be repaired.

**`IMPORT_NEWER_SCHEMA`** — the archive was written by a newer Ethos than the one reading it. Upgrade this machine, then retry.

**`another backup is already in progress`** — the `backups/.lock` sentinel is held. The message names the holding process. If no backup is running, delete the lock file.

**Restore from the web dashboard says it will not do `state`** — that is the design. Settings › Backup creates archives, downloads them, and restores `identity` only: the server serving that page holds every database open, so a `state` restore could never pass the in-use check. Use the CLI with the server stopped.

## See also {#see-also}

- [`ethos backup` and `ethos import`](../reference/cli.md#ethos-backup) — every flag, and the exit codes.
- [`backup.*` config reference](../reference/config-yaml.md#backup) — the five schedule keys and their defaults.
- [Secrets resolver reference](../reference/secrets-resolver.md) — where the credentials a restore prompts for are stored.
- [Sessions and history](../explanation/sessions-and-history.md) — what is inside the `state` scope, and why it is sensitive.
- [Decommission an Ethos deployment](decommission-ethos-deployment.md) — the teardown side, when the answer is to delete rather than move.
