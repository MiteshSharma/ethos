---
title: "CLI platform"
description: "The Ethos CLI surface: ethos chat, slash commands, single-shot query mode, session keying, environment variables, and the per-cwd session model."
kind: reference
audience: shared
slug: platform-cli
updated: 2026-08-14
---

The `ethos` binary is the default surface. It launches an interactive [agent](../getting-started/glossary.md#agent-loop) chat, streams [agent events](../getting-started/glossary.md#agent-event) to the terminal, persists conversation history in SQLite, and accepts slash commands for switching [personality](../getting-started/glossary.md#personality), inspecting [memory](../getting-started/glossary.md#memory-provider), and resetting state.

The CLI is also what you pipe into for scripted runs and what every other surface (channel adapters, MCP server, web UI) shares state with through `~/.ethos/`.

## Source {#source}

- `apps/ethos/src/index.ts` — top-level dispatch and `USAGE` string
- `apps/ethos/src/commands/chat.ts` — readline REPL, single-query mode, slash command handlers
- `packages/config/src/index.ts` — the `EthosConfig` shape parsed from `~/.ethos/config.yaml`
- `apps/tui/src/` — the rich TUI rendered when stdin and stdout are both TTYs

## Subcommands {#subcommands}

`ethos <subcommand>` dispatches in `apps/ethos/src/index.ts`. The full list:

| Subcommand | Purpose |
|---|---|
| `ethos chat` | Start the interactive chat (default; bare `ethos` aliases here). |
| `ethos setup` | Run the first-launch wizard (auth, model, personality, messaging, memory). |
| `ethos serve` | Serve the web UI for one [personality](../getting-started/glossary.md#personality). |
| `ethos gateway start` | Run the channel [gateway](../getting-started/glossary.md#gateway) (Telegram, Discord, Slack, email). |
| `ethos listen [doctor]` | Run a [wake satellite](../getting-started/glossary.md#wake-satellite) against `ethos serve`, or preflight one. Capture is raw PCM piped into stdin, the mic is open, and the server decides who was addressed from the transcript — see [Run a wake satellite](../using/how-to/run-a-wake-satellite.md). |
| `ethos personality [list \| set <id> \| duplicate <src> <dst>]` | Inspect or change the default personality. |
| `ethos memory [show \| add "<text>" \| clear]` | Read or edit `~/.ethos/MEMORY.md`. |
| `ethos skills` | List, install, and inspect skills. |
| `ethos plugin` | Install or uninstall plugins. |
| `ethos mcp` | Manage the MCP server bridge and per-personality MCP servers. |
| `ethos keys` | Manage the rotating API-key pool. |
| `ethos team`, `ethos mesh` | Manage multi-personality [meshes](../getting-started/glossary.md#mesh). |
| `ethos cron` | Schedule recurring agent runs. |
| `ethos batch`, `ethos eval`, `ethos evolve` | Batch runs, evals, and skill evolution. |
| `ethos logs`, `ethos tail`, `ethos errors`, `ethos trace`, `ethos audit` | Diagnostics. |
| `ethos doctor` | Configuration self-check. |
| `ethos upgrade` | In-place upgrade. |
| `ethos --version`, `ethos --help` | Identity and usage strings. |

Each subcommand reads `~/.ethos/config.yaml`. `ethos chat` runs `ethos setup` automatically if the file is missing.

## ethos chat {#chat}

The default subcommand. With a TTY on both stdin and stdout it launches the rich TUI (`@ethosagent/tui`); without a TTY it falls back to a plain readline REPL.

### Flags {#chat-flags}

| Flag | Purpose |
|---|---|
| `--verbose` | Append a per-[turn](../getting-started/glossary.md#turn) timing summary (TTFB, tool durations, token usage). |
| `--skin <name>` | Override `config.skin` for this process. Built-ins: `default`, `mono`, `paper`. |
| `-q "<prompt>"`, `--query "<prompt>"`, `--query=<prompt>` | Run a single query, print the answer, exit. The bare form `ethos -q "..."` is an alias for `ethos chat -q "..."`. |

`--verbose` and `--skin` apply only to the current process and never write to `~/.ethos/config.yaml`. Persist them with `ethos set verbose true` or by setting `skin:` in `~/.ethos/config.yaml`.

### Single-query mode {#single-query}

```
ethos -q "Summarise CHANGELOG.md"
ethos chat -q "Draft a release note for v0.42"
```

The query streams to stdout and the process exits as soon as the agent event stream emits `done` or `error`. The session key still keys on `cli:<cwd-basename>`, so a single-shot query and the next interactive `ethos chat` from the same directory see the same history.

When stdin is piped, the CLI does not splice stdin into the prompt — use `-q` with a command-substituted string instead:

```
ethos -q "$(cat request.txt)"
```

## Session keying {#session-keying}

The CLI keys [sessions](../getting-started/glossary.md#session) on the current working directory:

```
sessionKey = `cli:${basename(process.cwd())}`
```

| Working directory | Session key |
|---|---|
| `~/projects/alpha` | `cli:alpha` |
| `~/projects/beta` | `cli:beta` |
| `/tmp` | `cli:tmp` |

Different directories see independent conversation histories. The `/new` slash command appends `:${Date.now()}` to the current key to force a fresh session without changing directories.

Sessions are stored in `~/.ethos/sessions.db` (SQLite in WAL mode with FTS5). `SQLiteSessionStore.getMessages(sessionId, { limit })` returns the most recent N messages in chronological order — the LLM sees the latest context, not the oldest.

## Slash commands {#slash-commands}

Available inside `ethos chat`. Source: `apps/ethos/src/commands/chat.ts`.

| Command | Action |
|---|---|
| `/help` | Print the slash command reference. |
| `/new` (alias `/reset`) | Start a fresh session (appends a timestamp to the session key). Also resets the session budget counter. |
| `/personality` | Show the active personality. |
| `/personality list` | Print the built-in roster: `researcher`, `engineer`, `reviewer`. |
| `/personality <id>` | Switch personality for the rest of the session. User personalities live in `~/.ethos/personalities/<id>/`. |
| `/model <name>` | Show or change the model for this session. Changes take effect on the next restart; persist with `ethos set model <name>`. |
| `/memory` | Print `~/.ethos/MEMORY.md` plus `USER.md` (with a truncated marker if oversized). |
| `/usage` | Show input tokens, output tokens, and estimated cost for the session. |
| `/budget` | Show session spend against the configured cap. |
| `/budget reset` | Reset the session budget counter without starting a new session. |
| `/verbose` | Toggle per-turn timing summaries on or off for this process. |
| `/allow <code>` | Approve a pending channel sender by pairing code (used with the gateway). |
| `/deny <platform> <senderId>` | Revoke an approved channel sender. |
| `/communications` (alias `/comms`) | List approved senders and pending pairing codes. |
| `/exit` (alias `/quit`) | Exit the chat. |

Unknown commands print `Unknown command /<name> — type /help` without consuming a turn.

## Keyboard {#keyboard}

| Key | Action |
|---|---|
| `Ctrl+C` once | Abort the in-flight turn. The spinner clears and `[aborted — press Ctrl+C again to exit]` prints. |
| `Ctrl+C` twice | Exit `ethos chat`. |
| `Ctrl+D` | Send EOF; closes the REPL. |
| `Enter` | Submit the current line. |

The TUI surface ships richer bindings (history navigation, palette, panes); the readline fallback is intentionally minimal.

## Environment variables {#env-vars}

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Used by the Anthropic provider if `apiKey` is not in config. |
| `OPENAI_API_KEY` | Used by the OpenAI-compatible provider (OpenRouter, Ollama, Gemini). |
| `ETHOS_VERSION` | Override the version string at startup. The build-time `__ETHOS_VERSION__` define wins when present. |
| `ETHOS_DEDUP_LEGACY` | Set to `1` to disable outbound message dedup in the gateway. One-release escape hatch — see `extensions/gateway/src/dedup.ts`. |
| `HOME` | The CLI roots state at `${HOME}/.ethos/`. Override to run two installations side by side. |
| `NODE_ENV` | Honoured by the runtime; no Ethos-specific switching. |

`~/.ethos/` is the only state directory.

## EthosConfig fields that affect the CLI {#config-fields}

Read by `readConfig()` in `packages/config/src/index.ts`. Only the fields the CLI cares about:

| Field | Effect on the CLI |
|---|---|
| `provider` | `anthropic` or an OpenAI-compatible value. Picks the LLM wiring. |
| `model` | Default model. Shown in the chat banner; can be overridden per-personality via `modelRouting.<id>`. |
| `apiKey` | Primary provider key. `keys.json` is consulted for rotation. |
| `personality` | The active personality on launch. `/personality <id>` overrides per-session. |
| `memory` | `markdown` (default) or `vector`. Picks the memory provider. |
| `modelRouting.<id>` | Per-personality model override. Switches model when `/personality <id>` is invoked. |
| `providers.<n>.*` | Provider chain. Two or more entries enable `ChainedProvider` with cooldown-based failover. |
| `verbose` | Default value for `--verbose` / `/verbose`. |
| `skin` | Default value for `--skin`. Built-ins: `default`, `mono`, `paper`. |
| `retention.*` | TTLs the nightly prune task honours (`messages`, `traces`, `spans`, `blobs`, `archive`, `events.*`). |

Platform tokens (`telegramToken`, `discordToken`, `slackBotToken`, `slackAppToken`, `slackSigningSecret`, `email*`) are read by `ethos gateway start`, not by `ethos chat`.

## Streaming output {#streaming}

The CLI consumes the agent event stream from `AgentLoop.run()`:

- `text_delta` — appended to stdout as it arrives. The `ethos thinking <seconds>s` spinner clears on the first delta.
- `thinking_delta` — suppressed in the readline fallback (the TUI has a togglable pane).
- `tool_start` — renders a dim `⟳ <tool>` line. The spinner pauses to let the chip render.
- `tool_progress` — emitted to the terminal only when the [tool](../getting-started/glossary.md#tool) tagged the event with `audience: 'user'`. Internal progress stays in logs. See the [audience boundary](../getting-started/glossary.md#audience-boundary).
- `tool_end` — overwrites the spinner line with `✓ <tool> <ms>ms` (or `✗` on failure).
- `usage` — accumulated into the session counters surfaced by `/usage` and `/budget`.
- `error` — printed inline as `[<code>] <error>` in red.
- `done` — triggers the `--verbose` summary when active.

`_watcher` tool progress (rate limit, suspicious sequence, compounding error, token budget) renders in yellow so safety chips visually pop against ordinary tool output.

## Exit codes {#exit-codes}

| Code | Meaning |
|---|---|
| `0` | Clean exit (REPL closed, single-query finished). |
| `1` | Unrecognised subcommand, missing required argument, or thrown `EthosError`. The envelope prints to stderr and appends to `~/.ethos/logs/errors.jsonl`. |
| `2` | `ethos security audit` reserved exit for malformed usage. |

`ethos errors` reads the JSONL log; `ethos doctor` summarises the live config and provider reachability.

## See also {#see-also}

- [Telegram adapter](telegram.md) — the gateway-side counterpart for the CLI's `/allow` and `/deny` flow.
- [Discord adapter](discord.md), [Slack adapter](slack.md) — same gateway, different ingress.
- [Run Ethos as a daemon](../using/how-to/run-as-daemon.md) — `launchd`, `systemd`, and `pm2` patterns for `ethos gateway start`.
- [Configure providers](../using/how-to/configure-providers.md) — provider chain and key rotation that the CLI shares with every other surface.
- [Glossary](../getting-started/glossary.md) — [`session`](../getting-started/glossary.md#session), [`agent event`](../getting-started/glossary.md#agent-event), [`memory provider`](../getting-started/glossary.md#memory-provider), [`audience boundary`](../getting-started/glossary.md#audience-boundary).
