---
sidebar_position: 10
title: CLI Reference
---

# CLI Reference

Complete reference for the `ethos` command-line interface.

## Usage

```bash
ethos [options]
pnpm dev [options]
```

## Options

| Flag | Description | Default |
|---|---|---|
| `--adapter <name>` | Platform adapter to use (`cli`, `telegram`, `discord`, `slack`) | `cli` |
| `--personality <id>` | Start with this personality active | From config |
| `--config <path>` | Config file path | `~/.ethos/config.yaml` |
| `--session <key>` | Override the session key | `cli:<cwd-basename>` |
| `--no-memory` | Disable memory loading and saving | `false` |
| `--debug` | Show debug output (hook events, token counts) | `false` |

## Slash commands (in chat)

These commands are typed directly in the interactive prompt.

### Session management

| Command | Description |
|---|---|
| `/new` | Start a new session (appends `:timestamp` to session key) |
| `/clear` | Clear the current session history (cannot be undone) |

### Personality

| Command | Description |
|---|---|
| `/personality` | Show active personality |
| `/personality <id>` | Switch to a different personality |
| `/personalities` | List all available personalities |

### Information

| Command | Description |
|---|---|
| `/usage` | Show token usage and estimated cost for this session |
| `/tools` | List all tools available to the current personality |
| `/model` | Show the active model |
| `/memory` | Show current MEMORY.md and USER.md content |
| `/status` | Show session key, personality, model, and tool count |

### Control

| Command | Description |
|---|---|
| `/help` | Show available slash commands |
| `Ctrl+C` | Interrupt the current response |
| `Ctrl+D` | Exit the CLI |

## `~/.ethos/config.yaml`

The main configuration file. Created automatically on first run.

```yaml
# LLM provider
provider: anthropic           # anthropic | openai-compat
model: claude-sonnet-4-6      # model ID for the provider

# Default personality (optional)
personality: engineer

# Active adapters
adapters:
  - cli

# Platform-specific config (see Platforms docs)
telegram:
  token: "..."

discord:
  token: "..."
  clientId: "..."

slack:
  token: "..."
  signingSecret: "..."

# Plugins to load
plugins:
  - "@myorg/ethos-plugin-weather"
```

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | API key for Anthropic provider |
| `OPENAI_API_KEY` | API key for OpenAI-compatible provider |
| `OPENROUTER_API_KEY` | API key for OpenRouter |
| `ETHOS_CONFIG` | Override config file path |
| `ETHOS_SESSION` | Override session key |
| `ETHOS_DEBUG` | Enable debug output (same as `--debug`) |

## Personality files

Personalities live in `~/.ethos/personalities/<id>/`:

```
<id>/
├── ETHOS.md        identity document
├── config.yaml     name, model, memoryScope
└── toolset.yaml    allowed tool names
```

`config.yaml` fields:

| Key | Type | Description |
|---|---|---|
| `name` | string | Display name |
| `description` | string | One-line summary |
| `model` | string | Override the default model for this personality |
| `memoryScope` | `global` \| `per-personality` | Memory isolation mode |

`toolset.yaml` format:

```yaml
tools:
  - search_web
  - read_file
  - write_file
  - run_shell
```

## Memory files

| File | Description |
|---|---|
| `~/.ethos/MEMORY.md` | Rolling project context — updated each session |
| `~/.ethos/USER.md` | Who you are — persistent, rarely changes |

## Session storage

Sessions are stored in `~/.ethos/sessions.db` (SQLite, WAL mode).

To inspect sessions directly:

```bash
sqlite3 ~/.ethos/sessions.db
sqlite> .tables
sqlite> SELECT session_id, COUNT(*) FROM messages GROUP BY session_id;
```

To export a session:

```bash
sqlite3 ~/.ethos/sessions.db \
  "SELECT role, content FROM messages WHERE session_id = 'cli:myproject' ORDER BY timestamp"
```
