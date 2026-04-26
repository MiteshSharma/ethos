---
sidebar_position: 2
title: CLI
---

# CLI Platform

The CLI is the default Ethos platform — an interactive terminal chat that persists sessions, streams responses, and supports slash commands.

## Starting the CLI

```bash
ethos chat
```

The CLI auto-runs setup on first launch if `~/.ethos/config.yaml` is missing.

## Session persistence

Sessions are stored in `~/.ethos/sessions.db` (SQLite). When you restart, the conversation history is restored automatically.

The session key is `cli:<cwd-basename>`. Different working directories get separate sessions:

```bash
cd ~/projects/alpha   # session: cli:alpha
ethos

cd ~/projects/beta    # session: cli:beta
ethos
```

## Slash commands

| Command | Description |
|---|---|
| `/new` | Start a fresh session (appends timestamp to session key) |
| `/personality <id>` | Switch personality for the current session |
| `/usage` | Show token usage and estimated cost for this session |
| `/tools` | List available tools for the current personality |
| `/memory` | Show current session memory |
| `/help` | Show all available commands |

## Streaming output

The CLI streams text as it's generated. Tool calls are shown inline:

```
> research quantum computing breakthroughs

⟳ search_web("quantum computing breakthroughs 2025")...  ✓ 230ms

Quantum computing saw several significant developments in 2025:

1. **Error correction milestone** — Google's Willow chip demonstrated...
```

Tool execution shows the tool name, duration, and success/failure status.

## Multi-line input

Press `\` + Enter to continue on the next line without submitting:

```
> Write a haiku about \
  distributed systems \
  and eventual consistency
```

Or use `Ctrl+J` (depends on your terminal).

## Piping input

The CLI reads from stdin when piped:

```bash
echo "Summarize this file:" | cat - README.md | ethos
cat request.txt | ethos --personality researcher
```

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Required for Anthropic provider |
| `OPENAI_API_KEY` | Required for OpenAI-compatible provider |
| `ETHOS_CONFIG` | Override config file path (default: `~/.ethos/config.yaml`) |
| `ETHOS_SESSION` | Override session key |

## Config path

The default config file is `~/.ethos/config.yaml`. Override with:

```bash
ETHOS_CONFIG=/path/to/config.yaml ethos
# or
ethos --config /path/to/config.yaml
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+C` | Interrupt current response |
| `Ctrl+D` | Exit (sends EOF) |
| `↑` / `↓` | Navigate history |
| `Tab` | Autocomplete slash commands |
