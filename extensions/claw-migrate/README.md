# @ethosagent/claw-migrate

One-command migration from an existing `~/.openclaw/` install to `~/.ethos/`. Plans first, executes after confirmation, never merges file contents.

## Why this exists

Ethos is the successor to OpenClaw. Users with an existing OpenClaw install have config, memories, skills, API keys, platform tokens, and a custom `SOUL.md` personality on disk that they shouldn't have to re-create by hand. This package reads the OpenClaw layout, produces a typed `MigrationPlan`, and applies it with skip-or-overwrite semantics — zero new runtime deps, pure `node:fs/promises`.

## What it provides

- `ClawMigrator` — `plan()` + `execute()` driver.
- `MigrateOptions` — `source`, `target`, `workspace`, `preset` (`'all'` | `'user-data'`), `overwrite`, `dryRun`.
- `MigrationPlan` — detected files, ordered `CopyOp[]`, summary counts, resolved personality decision.
- `MigrationResult` — `copied` / `skipped` / `failed` counts plus per-item reasons.
- `CopyOp`, `CopyKind`, `ItemResult` — typed contracts.

## How it works

`plan()` probes the source directory for seven known files (`config.yaml`, `MEMORY.md`, `USER.md`, `SOUL.md`, `skills/`, `keys.json`, `AGENTS.md`) and parses the OpenClaw `config.yaml` with a small flat-YAML reader (`src/index.ts:459`). It resolves the target personality up front so `execute()` can write a coherent `config.yaml` whether or not `SOUL.md` exists: a built-in name passes through, anything else (or anything backed by a `SOUL.md`) becomes `'migrated'` (`src/index.ts:147`).

The plan emits `CopyOp`s in a deliberate order — config → keys → memory → user → skills → soul → workspace AGENTS — so the dry-run print and the execute pass both read top-down (`src/index.ts:171`).

| `CopyKind` | Maps |
|---|---|
| `file` | Verbatim copy (MEMORY.md, USER.md, keys.json, AGENTS.md). |
| `tree` | Recursive copy (skills/ → skills/openclaw-imports/). |
| `config-merge` | OpenClaw config.yaml → translated Ethos config.yaml with `personality:` resolved. |
| `soul-as-personality` | SOUL.md → `personalities/migrated/{ETHOS.md, config.yaml, toolset.yaml}`. |

`execute()` walks the ops sequentially. Each `apply*` checks the destination and bails with `status: 'skipped'` if it exists and `overwrite` is false (`src/index.ts:308`). On `dryRun`, the existence check still runs so the user sees the same skip list they'd hit on a real run — only the actual write is suppressed. Failures are caught per-op and reported as `status: 'failed'` with the error message; one bad op never aborts the rest.

`applySoul()` synthesizes a three-file personality bundle: `ETHOS.md` is the SOUL.md content verbatim, `config.yaml` declares `name: Migrated` with a model picked from the resolved personality hint, and `toolset.yaml` is a comment-only stub so the LLM provider's default toolset applies (`src/index.ts:352`). The "already exists" check looks specifically for `ETHOS.md` inside the destination dir.

`applyConfigMerge()` rewrites OpenClaw config keys into Ethos format: keeps `provider`, `model`, `baseUrl`, all known platform tokens (`telegramToken`, `discordToken`, three Slack keys), and writes the resolved `personality:` regardless of what was in the source. `apiKey` is only carried over when `preset === 'all'`; `--preset user-data` strips secrets (`src/index.ts:339`).

`copyTree()` skips symlinks and non-regular files deliberately — skill bundles shouldn't depend on them, and following them is a footgun (`src/index.ts:418`). `countSkills()` recognises both flat (`skills/<name>/SKILL.md`) and scoped (`skills/<scope>/<slug>/SKILL.md`) layouts (`src/index.ts:423`).

## Usage

CLI:

```
ethos claw migrate --dry-run               # preview
ethos claw migrate                         # interactive confirm
ethos claw migrate --preset user-data      # strip API keys
ethos claw migrate --overwrite --yes       # non-interactive, replace existing
```

See `apps/ethos/src/commands/claw.ts`.

Programmatic:

```ts
import { ClawMigrator } from '@ethosagent/claw-migrate';

const m = new ClawMigrator({ dryRun: true });
if (await m.sourceExists()) {
  const plan = await m.plan();
  const result = await m.execute(plan);
}
```

## Gotchas

- Built-in personality list is hardcoded (`researcher`, `engineer`, `reviewer`, `coach`, `operator`) — keep `BUILTIN_PERSONALITIES` in `src/index.ts:89` in sync with what `extensions/personalities/data/` ships.
- `parseFlatYaml` only handles `key: value` lines with optional surrounding quotes. Nested YAML, lists, and multi-line strings are silently dropped — fine for OpenClaw config, not a general parser.
- `--overwrite` is all-or-nothing per op; there is no per-file selection.
- `AGENTS.md` lands in `workspace` (defaults to `process.cwd()`), not `~/.ethos/`. Run from the project root you want it in.
- `readModel()` falls back to a default rather than re-reading the source — the personality's `model:` is a hint, not a faithful copy of the user's setting. The actual user model is preserved by `config-merge`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `ClawMigrator`, types, flat-YAML parser, tree copy, skill counter. |
