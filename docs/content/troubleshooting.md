---
title: "Troubleshooting"
description: "Error catalogue for Ethos — common failure modes by symptom, with Cause / Fix / Prevent per entry."
kind: reference
audience: shared
slug: troubleshooting
updated: 2026-09-05
---

When something goes wrong, the CLI prints a three-line block: a code, a one-line cause, and a one-line action. Search this page for the code or the symptom you saw. Each entry follows the same shape: **Cause**, **Fix**, **Prevent** (when applicable).

## Synopsis {#synopsis}

User-facing errors are rendered by `formatError` in [`packages/types/src/errors.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/errors.ts):

```
✗ INVALID_INPUT: --concurrency must be a positive integer
  → Pass a positive integer, e.g. --concurrency 4.
```

The [Error reference table](#error-reference) at the bottom lists every registered code. Entries above cover the symptoms users hit most often — install, provider, [personality](getting-started/glossary.md#personality), [session](getting-started/glossary.md#session), [tool](getting-started/glossary.md#tool), [skill](getting-started/glossary.md#skill), and channel adapter failures. For a local diagnostics view, run `ethos logs summary` or `ethos logs bundle`.

## Install and setup {#install-and-setup}

### `ethos: command not found` {#command-not-found}

Cause · The CLI binary is not on your `PATH`, or the shell has not picked up the new install yet.

Fix ·
1. Open a new terminal. Confirm Node 24: `node --version` (or `nvm use 24`).
2. Reinstall globally: `npm install -g @ethosagent/cli`, then verify with `ethos --version`.

Prevent · Pin Node 24 in `.nvmrc` for any project that calls `ethos` from scripts.

### `CONFIG_MISSING` {#config-missing}

Cause · The first-run setup wizard never completed, or `~/.ethos/config.yaml` was deleted or moved.

Fix · Run `ethos setup`. The wizard writes a fresh `~/.ethos/config.yaml`. For a clean slate, `rm -rf ~/.ethos/` first.

### `CONFIG_INVALID` {#config-invalid}

Cause · The config file parses as YAML but is missing one of `provider`, `model`, or `apiKey`.

Fix · Re-run `ethos setup` — answers default to the current config — or edit the file by hand and re-run.

### SQLite {#sqlite}

Ethos uses Node 24's built-in `node:sqlite` module (wrapped by `@ethosagent/sqlite`). There is no native compilation step — if Node 24 runs, SQLite works. If you see SQLite-related errors, confirm your Node version is 24 or later (`node --version`).

## Provider and API keys {#provider-and-api-keys}

### `PROVIDER_AUTH_FAILED` {#provider-auth-failed}

Cause · The LLM provider rejected the API key. The key is wrong, the env var is unset, or the key was rotated.

Fix ·
1. Re-export the key, e.g. `export ANTHROPIC_API_KEY="sk-ant-..."` or `export OPENAI_API_KEY="sk-..."`.
2. To persist, run `ethos setup keys`.
3. Sanity-check the key with a raw `curl` against the provider's `/v1/messages` or `/v1/chat/completions` endpoint.

Prevent · Store keys in a password manager and inject them via a shell init file — never commit them.

### `LLM_ERROR` {#llm-error}

Cause · The provider terminated the streamed response with a hard error (usually a 5xx or a content-policy refusal).

Fix · Re-run the same prompt — transient 5xxs clear on retry. If it repeats, capture the printed `cause` and file a bug.

### `STREAM_TIMEOUT` {#stream-timeout}

Cause · The provider opened the stream but did not produce a token for longer than `streamingTimeoutMs`.

Fix · Re-run the request. If your network is slow, raise `streamingTimeoutMs` in the personality `config.yaml`.

Prevent · On flaky connections, prefer a smaller model — first-token latency is lower.

### Rate-limited by the provider {#rate-limited}

Cause · You crossed the per-minute or per-day quota for the provider's tier.

Fix · Wait a minute and retry — most limits reset per minute. For development, switch to a cheaper model. For sustained load, configure `AuthRotatingProvider` from `@ethosagent/llm-anthropic` with multiple API keys.

## Personality {#personality}

### `PERSONALITY_NOT_FOUND` {#personality-not-found}

Cause · The configured personality id does not match any built-in or `~/.ethos/personalities/<id>/` directory.

Fix ·
1. Run `ethos personality list` and copy a valid id.
2. Switch with `ethos personality set <id>`, or edit `personality:` in `~/.ethos/config.yaml`.
3. For a custom personality, check the directory contains `SOUL.md`, `config.yaml`, and `toolset.yaml`.

### `PERSONALITY_READ_ONLY` {#personality-read-only}

Cause · You tried to edit or delete one of the built-in personalities. Built-ins are immutable on disk.

Fix · Duplicate first: `ethos personality duplicate <built-in-id> <new-id>`, then edit the copy under `~/.ethos/personalities/<new-id>/`.

### `PERSONALITY_EXISTS` {#personality-exists}

Cause · The id passed to `ethos personality duplicate` or `personalities.create` already names an existing personality.

Fix · Pick a different id, or remove the existing user copy first.

### Personality is not hot-reloading {#personality-not-reloading}

Cause · `FilePersonalityRegistry.loadFromDirectory()` is mtime-cached on `config.yaml`. Edits to `SOUL.md` or `toolset.yaml` alone do not invalidate the cache.

Fix · `touch ~/.ethos/personalities/<id>/config.yaml` after editing the other files.

Prevent · Edit `config.yaml` last so its mtime moves after the other files.

## Sessions and memory {#sessions-and-memory}

### Agent forgets context mid-conversation {#agent-forgets-context}

Cause · `getMessages(sessionId, { limit })` returns the most recent N messages — the LLM sees the tail, not the head. Long conversations drop older context.

Fix ·
1. Use `/new` in chat to start a fresh [session](getting-started/glossary.md#session) when context is stale.
2. Ask the agent to write key facts to memory: "Remember that X" — they land in `~/.ethos/MEMORY.md`.
3. Raise the message `limit` in personality config (costs more tokens per turn).

Prevent · Keep important state in memory, not in conversation. Memory survives `/new` and session resets.

### `sessions.db` shows the wrong order or duplicates {#sessions-db-order}

Cause · Same-millisecond inserts need rowid tie-breaking. The current SQLite store handles this — if you see the symptom, the DB was written by an older build.

Fix · Back up (`cp ~/.ethos/sessions.db ~/.ethos/sessions.db.bak`), then delete (`rm ~/.ethos/sessions.db`). A fresh DB is created on the next run.

Prevent · Upgrade the CLI before reusing a database written by a build older than 0.2.0.

## Tools and boundaries {#tools-and-boundaries}

### `Tool 'X' not found` {#tool-not-found}

Cause · The named [tool](getting-started/glossary.md#tool) is not registered, or it is registered but not in the personality's `toolset.yaml`.

Fix ·
1. In chat, run `/tools` to list every registered tool the personality can see.
2. Add the tool to `toolset.yaml` if you want this personality to use it.
3. If the tool needs an env var (e.g. an API key), confirm `isAvailable()` returns `true`.

### `TOOL_REJECTED` {#tool-rejected}

Cause · A `before_tool_call` [hook](getting-started/glossary.md#hook) chose not to let the tool run. The hook's reason appears in the printed cause line.

Fix · Read the cause string — it names the hook. Adjust the hook config (or the tool call) so the boundary is satisfied.

### `BoundaryError` (fs_reach violation) {#boundary-error}

Cause · A file tool tried to read or write a path outside the personality's [fs_reach](getting-started/glossary.md#fs-reach) allowlist. `ScopedStorage` raises this; the surface translates it into a user-facing tool error.

Fix · Add the path (or a parent) to `fs_reach`, or move the file under an existing allowed path. If the path is sensitive on purpose, leave the boundary alone and work on a copy under the allowlist.

Prevent · Default-deny is intentional — broaden the allowlist deliberately, not reactively.

### `BUDGET_EXCEEDED` {#budget-exceeded}

Cause · The session crossed a token, tool-call, or cost budget configured on the personality. Session-scoped only in v1.

Fix · Run `/new` to reset the budget counter, or raise the budget in personality config.

### `MULTIPLE_IN_PROGRESS` (todo tool) {#multiple-in-progress}

Cause · The `todo` tool was asked to mark a second item `in_progress` while another is already in that state. Only one task may be in progress at a time.

Fix · Mark the existing in-progress task `done` or `pending`, then flip the new one to `in_progress`.

### Tool results are truncated {#tool-results-truncated}

Cause · Tool output exceeded the per-call slice of the turn's result budget. `ToolRegistry.executeParallel()` post-trims and appends `[truncated — N chars total]`. Default total is 80,000 characters per turn, split evenly across concurrent calls.

Fix · Paginate ("read the file 100 lines at a time"), reduce parallel tool calls, or raise `resultBudgetChars` in `AgentLoop` config (raises token costs).

## Skills and plugins {#skills-and-plugins}

### `SKILL_NOT_FOUND` {#skill-not-found}

Cause · The [skill](getting-started/glossary.md#skill) id passed to a Skills tab action is not under `~/.ethos/skills/` — often the file was deleted out-of-band.

Fix · Refresh the Skills tab. If still missing, re-install: `ethos skills install <slug-or-url>`.

### `SKILL_INSTALL_FAILED` {#skill-install-failed}

Cause · `ethos skills install` could not complete. The temp directory is rolled back, so nothing is left half-installed.

Fix · Re-run the install — most failures are network blips. If the source URL is wrong, fix the slug. If repeated, check `~/.ethos/logs/errors.jsonl`.

### `SKILL_EXISTS` {#skill-exists}

Cause · A new skill collides with an existing file under `~/.ethos/skills/`.

Fix · Pick a different id, or open the existing skill from the Library panel and edit it in place.

### `PLUGIN_CONTRACT_INCOMPATIBLE` {#plugin-contract-incompatible}

Cause · A plugin declares a `pluginContractMajor` not supported by this CLI.

Fix · Upgrade the plugin or the CLI per `packages/plugin-contract/MIGRATIONS.md`. Check both with `ethos plugins list` and `ethos --version`.

### `PLUGIN_INSTALL_FAILED` {#plugin-install-failed}

Cause · `ethos plugins install` could not record the capability grant. Installing a plugin runs its code in your Ethos process, so the install refuses to proceed without a grant on record — and stdin is not a TTY, so nobody could be asked.

Fix · Re-run interactively and answer the prompt, or pass `--yes` to record the grant unattended. A `--yes` grant is stored with `consent: 'flag'`, so a later reader can see nobody was at the keyboard.

Prevent · On CI and managed hosts, pass `--yes` in the install command rather than relying on a prompt that will never render.

## Channels and gateway {#channels-and-gateway}

### Duplicate outbound message on a channel adapter {#duplicate-outbound}

Cause · The [gateway](getting-started/glossary.md#gateway) dedupes outbound messages with a 30-second TTL, keyed by `(sessionId, sha256(content))`. The same text within the window is silently dropped.

Fix · For intentional retransmission, vary the text or wait the TTL. To disable, set `GatewayConfig.outboundDedupTtlMs: 0` or `ETHOS_DEDUP_LEGACY=1` (one-release rollback hatch).

Prevent · Do not roll adapter-local dedup. The gateway is the single dedup path; adapter dedup is a bug.

### Telegram or Discord bot does not respond {#bot-not-responding}

Cause · The bot's token is invalid or the bot is not added to the channel. Bad tokens used to crash the gateway; the current build catches `Bot.start` rejections and logs them.

Fix · Re-run `ethos setup messaging` and paste a fresh token. Check `~/.ethos/logs/gateway.log`. Confirm the bot is in the target chat with the required permissions.

### `TEAM_MANIFEST_INVALID` {#team-manifest-invalid}

Cause · `team.yaml` failed to parse or failed schema validation. The offending field is named in the cause.

Fix · Fix the named field in `team.yaml` and re-run `ethos team start`.

### `ffmpeg not found` at gateway startup {#ffmpeg-not-found}

Cause · `ffmpeg` is not on the gateway's `PATH`. It is an optional runtime dependency: the gateway starts and runs without it, but it can only deliver a voice note whose container the TTS provider already produces, and it can only hand speech-to-text the platform's raw bytes.

Fix ·
1. Install it: `brew install ffmpeg`, `sudo apt-get install -y ffmpeg`, or `sudo dnf install -y ffmpeg`.
2. Confirm with `ffmpeg -version`.
3. If it is installed somewhere the gateway's `PATH` does not reach, set `voice.transcode.ffmpegPath` to the absolute path in `~/.ethos/config.yaml`.
4. Restart the gateway. The notice disappears.

Prevent · Add `ffmpeg` to the host's provisioning. The shipped Docker image does not include it — see [Run Ethos in Docker](using/how-to/run-in-docker.md#prerequisites).

### Text reply arrives but the voice note does not {#voice-note-missing}

Cause · The reply was skipped, not lost, and the gateway recorded why. The four usual reasons: the platform was silenced with `voice.channels.<platform>.ttsOut: false`; the adapter declares no voice caps; the synthesized format is not one the adapter accepts and there is no `ffmpeg` to convert it; or the audio exceeded the platform's `maxBytes`.

Fix ·
1. Check `voice.channels.<platform>.ttsOut` — an explicit `false` outranks `/voice all`.
2. Check the channel supports voice out at all in the [capability matrix](platforms/capability-matrix.md#voice-caps).
3. Install `ffmpeg` (above).
4. Check the conversation's mode with `/voice`.

Prevent · Run `ethos doctor` after changing voice providers; it reports which STT and TTS actually resolved.

### A voice note arrives twice, or long after the fact {#voice-note-redelivered}

Cause · Voice delivery is at-least-once. A synthesized reply whose send was never confirmed stays as a `pending` obligation in the delivery ledger and is re-sent at the next gateway start, bypassing the dedup cache on purpose.

Fix · Nothing, if it arrived. If pending obligations are accumulating, the underlying sends are failing — check the gateway log and the delivery readout in **Settings → Voice**.

Prevent · Bound the backlog with [`voice.artifacts.abandonAfterDays`](using/reference/config-yaml.md#voice-artifacts) and `voice.artifacts.maxTotalMb`. See [Why does a redelivered voice note re-send the recording?](building/explanation/why-voice-replies-redeliver.md).

### A voice memo is answered as if it were empty {#voice-in-empty}

Cause · The turn ran but carried no transcript, so it degraded to `(voice message)` rather than being dropped. Either no speech-to-text provider resolved, or the provider returned nothing usable, or the upload was never classified as audio in the first place.

Fix ·
1. Run `ethos doctor` and read its Voice section — it names the STT provider that actually resolved.
2. Check the recording's container. A `.webm` upload is treated as video on Slack and Discord and never reaches transcription; re-record as `.ogg`, `.m4a`, or `.mp3`.
3. Install `ffmpeg` (above) so the audio is normalized into a container the provider accepts.

Prevent · Check the [capability matrix](platforms/capability-matrix.md#matrix) before assuming symmetry — voice in and voice out are separate capabilities.

## Cron and jobs {#cron-and-jobs}

### `JOB_NOT_FOUND` {#job-not-found}

Cause · The cron job id passed to `ethos cron remove`, `run`, or `disable` does not exist.

Fix · Run `ethos cron list` and copy the exact id.

### `JOB_LOCK_FAILED` {#job-lock-failed}

Cause · Another cron-mutating command is holding the lock.

Fix · Wait and re-run. If it repeats, check for a stuck `ethos cron` process and kill it.

### `CRON_INVALID` {#cron-invalid}

Cause · The cron expression failed validation.

Fix · Use a valid 5-field cron expression. Test on `https://crontab.guru` before re-running.

## Error reference {#error-reference}

The full list of registered codes. Every code shipped in `@ethosagent/types` `EthosErrorCode` appears here.

| Code | Cause | Action |
|---|---|---|
| `CONFIG_MISSING` | `~/.ethos/config.yaml` is absent or unreadable. | Run `ethos setup`. |
| `CONFIG_INVALID` | Config parsed but missing required fields. | Re-run `ethos setup`, or edit the file. |
| `PERSONALITY_NOT_FOUND` | Personality id does not exist. | `ethos personality list` and pick a valid id. |
| `PROVIDER_AUTH_FAILED` | LLM provider rejected the key. | Re-export the API key or run `ethos setup keys`. |
| `LLM_ERROR` | Provider returned a non-recoverable error mid-stream. | Re-run. If repeated, file a bug with the cause. |
| `STREAM_TIMEOUT` | The LLM streamed nothing for the watchdog window. | Re-run; tune `streamingTimeoutMs` if your network is slow. |
| `INVALID_INPUT` | A required CLI flag is missing or out of range. | Read the printed `Usage:` and re-run. |
| `INVALID_PROVIDER` | `--provider` names a provider Ethos does not ship. | Use one of the providers listed in the cause. |
| `INVALID_TOOLSET` | `--toolsets` names a toolset that does not exist. | Use one of the toolsets listed in the cause. |
| `FILE_NOT_FOUND` | A path passed to a CLI flag does not exist. | Verify the path and re-run. |
| `BATCH_INVALID_LINE` | A line in the batch JSONL file is malformed. | Fix the named line and re-run `ethos batch`. |
| `EVAL_INVALID_LINE` | A line in the eval JSONL file is malformed. | Fix the named line and re-run `ethos eval run`. |
| `TOOL_REJECTED` | A `before_tool_call` hook blocked the tool. | Adjust the hook config or the tool call. |
| `TOOL_EXECUTION_FAILED` | A tool returned `{ ok: false }`. | Treat the printed cause as the tool's diagnostic. |
| `SUBAGENT_TASK_DUPLICATED` | A delegated task duplicated across the child prompt. | Bug — file an issue with the parent personality and prompt. |
| `JOB_NOT_FOUND` | Cron job id does not exist. | `ethos cron list` and copy the exact id. |
| `JOB_DUPLICATE` | New cron job uses a taken id. | Pick a different id or remove the existing job. |
| `JOB_LOCK_FAILED` | Another cron command holds the lock. | Wait and re-run; kill stuck `ethos cron` processes. |
| `CRON_INVALID` | Cron expression failed validation. | Use a valid 5-field expression (see `crontab.guru`). |
| `CRON_PERSONALITY_MISSING` | The personality named on a cron job no longer exists. | Update the job to a current personality id. |
| `CRON_RUN_FAILED` | A cron job's turn ended in an error event. | `ethos cron list`, then check the job's personality and prompt. |
| `CRON_TARGET_NOT_ALLOWED` | A cron job asked to deliver into a chat that is not an approved target for that bot and personality. | Pick a target from the picker; add the chat to `channel_filter.<platform>` or message the bot once so the chat is known. |
| `RECIPE_NOT_FOUND` | No recipe with that id is shipped in the curated catalog. | Call `recipes.list` (Library → Recipes) and use an id from it. |
| `RECIPE_INVALID` | A shipped recipe bundle failed its own schema. | Report it — the catalog is first-party, so this is a packaging bug. |
| `RECIPE_STALE` | You previewed one version of a recipe and installed against a newer one. | Re-open the recipe, read what changed, and install again. |
| `RECIPE_BLOCKED` | A recipe install was refused because a prerequisite is unmet or a required field is empty. | Work through the preflight list — each row names the exact action — then install again. |
| `RECIPE_CHANNEL_SETUP_FAILED` | A recipe's inline channel setup could not complete: the bot token was refused, the platform was unreachable, or the chat you picked has not actually messaged that bot. | Re-check the token with @BotFather, then send your bot a message and press "Check for your message" again. Nothing was created. |
| `MCP_TRANSPORT_INVALID` | An MCP server entry is missing `command` (stdio) or `url` (sse). | Edit the MCP server entry in `~/.ethos/config.yaml`. |
| `MCP_SERVER_NOT_FOUND` | The named MCP server is not attached to that personality. | Attach the server first, then set its token. |
| `SECRETS_UNAVAILABLE` | The server has no secrets resolver wired. | Start the server with secrets configured. |
| `REGISTRY_FETCH_FAILED` | `ethos upgrade` could not reach `registry.npmjs.org`. | Check network. Install manually: `npm i -g @ethosagent/cli@latest`. |
| `NETWORK_ERROR` | A non-registry network call failed. | Re-run. Check your connection. |
| `SKILL_INSTALL_FAILED` | `ethos skills install` did not complete. | Re-run; verify the source slug. |
| `SKILL_NOT_FOUND` | Skill id is not under `~/.ethos/skills/`. | Refresh the Skills tab; the file may have been deleted. |
| `SKILL_EXISTS` | A new skill collides with an existing file. | Pick a different id, or open and edit the existing skill. |
| `SKILL_READONLY` | System skills cannot be edited or deleted. | Duplicate into `~/.ethos/skills/`, then edit the copy. |
| `MISSING_SKILL` | A name passed to `-s` is not a plain filename under `~/.ethos/skills/`. | Use a bare skill name; confirm `<name>.md` exists. |
| `PERSONALITY_EXISTS` | Personality id is already taken. | Pick a different id. |
| `PERSONALITY_READ_ONLY` | Built-in personalities cannot be modified directly. | Duplicate, then edit the copy. |
| `PLUGIN_CONTRACT_INCOMPATIBLE` | Plugin declares an unsupported `pluginContractMajor`. | Upgrade the plugin or CLI per the migration guide. |
| `PLUGIN_INSTALL_FAILED` | The install needs a recorded capability grant and stdin is not a TTY. | Install interactively, or pass `--yes` to record the grant. |
| `TEAM_MANIFEST_INVALID` | `team.yaml` failed schema validation. | Fix the named field and re-run `ethos team start`. |
| `IMPORT_BLOCKED` | A restore was refused: an archive entry escapes the data dir or is not a regular file, the archive failed its manifest checksum, or a database it would replace is open in another process. | Read the printed cause. For a checksum failure, use a different archive. For an in-use database, stop `ethos chat` / `serve` / `gateway` / the desktop app and retry. See [Back up and restore](using/how-to/back-up-and-restore.md). |
| `IMPORT_NEWER_SCHEMA` | A SQLite store on disk, or a backup archive, was written by a newer Ethos than the one reading it. | Upgrade Ethos to a build that understands it, then retry. |
| `MEMORY_CONFLICT` | A memory entry changed on disk between your read and your write. | Re-read the entry and retry the write. |
| `UNAUTHORIZED` | A web API request lacks valid auth. | Sign in again from the web UI. |
| `FORBIDDEN` | Authenticated, but the caller may not perform this action. | Use an account with the required role. |
| `NOT_FOUND` | A web API resource id does not resolve. | Refresh the list and re-select. |
| `NOT_CONFIGURED` | The server was started without a piece the route needs (LLM, storage, memory). | Restart the server with that component configured. |
| `SESSION_NOT_FOUND` | The session id passed to the web API does not exist. | Refresh the session list. |
| `WORKDIR_NOT_CONFIGURED` | The personality has no declared `fs_reach.workdir`, so Documents has no root to browse or write to. | Set `fs_reach.workdir` in the personality's `config.yaml`. |
| `DOCUMENT_EXISTS` | A Documents upload targeted a path that already has a file, and `overwrite` was not set. | Pick a different filename, or retry with overwrite enabled. |
| `PAYLOAD_TOO_LARGE` | An upload body exceeded the route's size cap (100MB for a Documents upload). | Upload a smaller file. |
| `INTERNAL` | An unexpected error escaped to the surface. | Re-run. If repeated, file an issue with the printed `details`. |

## Getting help {#getting-help}

When filing a bug, include `node --version`, `pnpm --version`, your OS, the full three-line error block, the relevant slice of `~/.ethos/logs/errors.jsonl`, and steps to reproduce. Open an issue at [github.com/ethosagent/ethos/issues](https://github.com/ethosagent/ethos/issues) or a discussion at [github.com/ethosagent/ethos/discussions](https://github.com/ethosagent/ethos/discussions).

## See also {#see-also}

- [Glossary](getting-started/glossary.md) — every domain term in one place.
- [CLI reference](using/reference/cli.md) — every subcommand and flag.
- [Changelog](changelog.md) — what changed in each release.
