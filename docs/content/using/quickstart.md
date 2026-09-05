---
title: "Quickstart"
description: "Install the Ethos CLI, configure one provider, and send your first message — no YAML to hand-edit before first success."
kind: tutorial
audience: user
slug: quickstart
time: "5 min"
updated: 2026-07-17
---

Install the CLI, paste one API key, send one message. No config files to hand-edit before the first reply.

## Goal

A working `ethos chat` session with one streamed response on screen. No personality customisation, no hand-edited YAML, no platform setup — those come in the next tutorials.

By the end you have:

- `ethos` on `PATH` and `ethos --version` printing a real number.
- `~/.ethos/config.yaml` written by the setup wizard with one provider, one model, one API key, one default personality.
- A streamed reply on screen from your provider, confirming the install reaches the network and the API key works.

## Prereqs

- macOS, Linux, or Windows 10/11. On Windows, the native installer works without WSL — see [Install on Windows](./how-to/install-on-windows.md) for the dedicated guide. The steps below show the macOS/Linux path.
- An API key from one of: Anthropic, OpenRouter, Ollama (running locally), or Gemini. The wizard accepts any of them; the rest of these docs assume Anthropic for the examples but every step works the same elsewhere.
- Node 24 or newer. The recommended install script handles this for you — skip ahead if you already have Node.

## 1. Install

The recommended path is one command:

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash
```

The script does three things:

- Installs Node 24 via `nvm` if it is not already on `PATH`. Existing Node 24+ installs are left alone.
- Runs `npm install -g @ethosagent/cli`.
- Prints the path where `ethos` was installed.

If you prefer to skip the installer and use your own Node toolchain, the equivalent is two commands:

```bash
# Confirm Node 24+
node --version
# Install the CLI globally
npm install -g @ethosagent/cli
```

Either way, you should now be able to print the version:

```bash
ethos --version
```

Expected output (the exact number changes per release):

```
@ethosagent/cli 0.5.0
```

If `ethos: command not found`, your `PATH` does not include the global `npm` bin directory. `npm config get prefix` prints the prefix; add `<prefix>/bin` to your shell's rc file (`~/.zshrc`, `~/.bashrc`), open a new shell, and try again.

**On Windows**, use the PowerShell one-liner instead of the `curl` command above — see [Install on Windows](./how-to/install-on-windows.md).

If you installed through `nvm`, the binary lives under `~/.nvm/versions/node/v24.x.x/bin/`. That path is on `PATH` only inside shells that source `nvm.sh` — service managers like `launchd` and `systemd` do not, which matters in the Telegram tutorial later.

## 2. Configure one provider

Run the first-time setup. It writes `~/.ethos/config.yaml` for you.

```bash
ethos setup
```

The wizard walks you through four prompts. Pick defaults except where you have an opinion.

- **Provider** — `anthropic` (default), `openrouter`, `ollama`, or `gemini`. OpenRouter aggregates many models behind one API key; Ollama runs models locally with no API key; Gemini is Google's API.
- **Model** — `claude-sonnet-5` is the default for Anthropic. Other providers default to their headline model. You can change this later by editing `~/.ethos/config.yaml` or running `ethos setup model`.
- **API key** — paste it. The wizard stores it in `~/.ethos/config.yaml` with file mode `0600` (owner read/write only).
- **Personality** — accept `researcher` for now. The next tutorial covers switching to the other built-ins (`engineer`, `reviewer`) and writing your own.

> **Tip:** For secure key storage, use `ethos secrets set ANTHROPIC_API_KEY <value>` instead of pasting into config.yaml. The key is then referenced as `${secrets:ANTHROPIC_API_KEY}` in config. See [secrets reference](./reference/config-yaml.md) for details.

When setup finishes, the wizard offers to launch chat. Say yes.

If you skipped the prompt (or you closed the shell), launch chat manually:

```bash
ethos chat
```

You should see a header like this:

```
ethos  claude-sonnet-5 · Researcher · /help
```

The header lists the active model, the active [personality](../getting-started/glossary.md#personality), and a reminder to type `/help` for slash commands.

The setup wizard never returns to a missing-config state once it has written the file. If something went wrong (the key was rejected, the wrong model id was picked), edit `~/.ethos/config.yaml` directly or re-run the wizard — it reads the existing file as defaults.

## 3. Verify the install works

Before sending a real prompt, confirm the agent can reach its provider. Type a short message:

```
You > say hello
```

You should see a streamed response from the model within a couple of seconds, ending with a new prompt. The response prints one chunk at a time — that is the `text_delta` event surface, streamed from the provider through `AgentLoop` to the terminal.

If the response never starts:

- **`auth` or `401` error** — your API key is wrong. Re-run `ethos setup` and paste it again. If the key looks correct, confirm it has not been revoked on the provider's dashboard.
- **`ECONNREFUSED` or `getaddrinfo` error** — your network blocks the provider host, or (for Ollama) the local server is not running. `curl https://api.anthropic.com` or `curl http://localhost:11434` confirms the path.
- **`No config found`** — you skipped `ethos setup`. Run it. The chat command refuses to start without `~/.ethos/config.yaml`.
- **Hangs with no error and no output** — the provider is rate-limiting you, or the model id is wrong for the provider you picked. `ethos doctor` prints a diagnostic; the model id is in `~/.ethos/config.yaml` under `model:`.

A working "say hello" is the install verification. Now send a real message.

You can also send a one-shot query without entering the REPL — useful for scripting or sanity checks:

```bash
ethos chat -q "say hello"
```

The same response streams to stdout; the process exits when the reply is done. The `--query` and `--query=<text>` long forms behave identically. Either form is detected as a top-level alias, so `ethos -q "..."` works too.

## 4. Send your first real message

Type a real question — pick something specific enough to make the response interesting:

```
You > what is the capital of france and what is one famous building there?
```

Three things happen, all visible on screen:

1. A `thinking` spinner counts seconds while the model thinks. The spinner is rendered from the time between turn start and the first `text_delta`.
2. Streamed text appears under `ethos >`, one token group at a time.
3. The prompt returns to `You >` when the [turn](../getting-started/glossary.md#turn) is done. A turn is one message in, one streamed response out.

The conversation is captured in a [session](../getting-started/glossary.md#session) keyed to this working directory — the session key is `cli:<basename-of-cwd>`. The session lives in `~/.ethos/sessions.db` (SQLite with WAL and FTS5). Close the chat, reopen it from the same directory, and the agent remembers what you asked. Different working directories get different sessions; the agent does not see across them.

To pick up where you left off explicitly, use `ethos chat --continue` (or `-c`) to resume the most recent session, or `--resume <id>` to jump to a specific conversation by ID or title. See the [CLI reference](./reference/cli.md#ethos-chat) for the full flag list.

Two things to notice as you watch the reply stream:

- The first chunk arrives within 1–2 seconds. Subsequent chunks should land sub-second. If the gap between chunks is longer than that, the provider is rate-limiting or the model is slow.
- The CLI renders text deltas inline. Tool calls (when the personality uses them) print a `⟳ tool_name` chip that flips to `✓ tool_name <duration>ms` when the tool returns. The next tutorial walks through one explicitly.

## 5. See what just happened

While still in chat, type:

```
/usage
```

You should see something like:

```
Tokens  : 184 in · 96 out
Cost    : $0.00214
```

These are real numbers from the provider. The cost is an estimate based on the model's published rates — close enough to budget against. The provider's own dashboard is the source of truth for billing.

Type `/help` to scan the rest of the slash commands. The headline ones (each gets a section in [Slash commands reference](./reference/slash-commands.md)):

```
/new          start a fresh session in this directory
/personality  show, list, or switch personality
/memory       print MEMORY.md and USER.md
/usage        tokens and cost stats
/budget       session spend against the personality's cap
/exit         quit
```

Quit when you are done:

```
/exit
```

The session you just had is preserved on disk. Run `ethos chat` again from the same directory and the agent recalls it.

## 6. Where things live

A working install creates exactly one directory: `~/.ethos/`. After this tutorial, it contains:

```
~/.ethos/
├── config.yaml       provider, model, api key, default personality
├── sessions.db       SQLite store of every conversation
├── logs/             structured logs (errors.jsonl, gateway.out.log, etc.)
└── personalities/    your custom personalities (empty after this tutorial)
```

Two files you may want to back up: `config.yaml` (cheap to recreate, but contains the API key) and `sessions.db` (every conversation you have had). Memory files (`MEMORY.md`, `USER.md`) land here as well once a personality writes to them — the next tutorial covers that layer.

For a graphical view, run `ethos serve` — the web dashboard lets you manage personalities, memory, skills, cron jobs, sessions, and MCP servers from the browser. See [Use the web dashboard](./how-to/use-web-dashboard.md).

Everything else (`mcp.json`, `communications.json`, `keys.json`, `skills/`) is created by features you have not yet used.

## What you learned

- The CLI installs through one command and stores config at `~/.ethos/config.yaml`.
- `ethos chat` opens a streaming REPL bound to one provider and one personality.
- Sessions persist across restarts, keyed by working directory.
- `/usage` reports tokens and estimated cost for the current session.

## Beyond the CLI

The CLI is one of several ways to interact with Ethos. `ethos serve` starts a local [web dashboard](./how-to/use-web-dashboard.md) for managing personalities, memory, skills, cron jobs, and sessions from the browser. An [Electron desktop app](../platforms/desktop.md) wraps the same dashboard as a native application. To skip the local install entirely, [Run Ethos in Docker](./how-to/run-in-docker.md) brings up a talking web UI with one API key and one `docker compose up`. For messaging, channel adapters bring [Telegram](../platforms/telegram.md), [Slack](../platforms/slack.md), [Discord](../platforms/discord.md), and Email into the same agent — the [first Telegram deploy tutorial](./tutorials/first-deploy-telegram.md) walks through the setup, starting from `ethos setup messaging` or `ethos gateway setup`. The quickstart focuses on the CLI because it is the fastest path to a working session; the other surfaces build on top of the same config and sessions.

## Next step

You have a working agent. The next tutorial walks you through the turn cycle conceptually while you do it: send three messages, watch tool calls render, check usage, exit and reopen to verify session persistence, switch personality.

- [Build your first agent](./tutorials/first-agent.md) — three messages, two personalities, ten minutes.
- [Run Ethos in Docker](./how-to/run-in-docker.md) — one API key, one `docker compose up`, a web UI you can talk to.
- [Install on Windows](./how-to/install-on-windows.md) — native Windows install via PowerShell, no WSL or admin rights needed.
- [Install on Windows (WSL2)](./how-to/install-on-windows-wsl2.md) — WSL2 path for the dashboard terminal pane and a full POSIX environment.
- [Deploy in production](./how-to/deploy-in-production.md) — bots and dashboard running on a mini PC or VPS, surviving reboots, in three commands.
- [Use skills](./how-to/use-skills.md) — discover and install skills from Claude Code, OpenClaw, Hermes, and other sources.
- [config.yaml reference](./reference/config-yaml.md) — every field the file accepts, if you want to read ahead.
- [Glossary](../getting-started/glossary.md) — every domain term in one place.
