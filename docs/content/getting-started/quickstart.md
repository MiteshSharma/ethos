---
title: Quickstart
description: Install Ethos, run the setup wizard, and start your first agent chat in under five minutes.
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quickstart

> Ethos runs on **macOS** and **Linux** (x64 + arm64). Windows is not supported in this release — use [WSL](https://learn.microsoft.com/windows/wsl/install) if you're on Windows.

---

## 1. Install

Three install paths. The one-liner is the recommended default.

<Tabs groupId="install-method" queryString>

<TabItem value="curl" label="One-liner (recommended)" default>

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash
```

What it does:

1. Detects your platform (macOS / Linux, x64 / arm64)
2. Checks for Node 24+ and installs it via [nvm](https://github.com/nvm-sh/nvm) if missing
3. Runs `npm install -g @ethosagent/cli`

To install and immediately run the setup wizard:

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --setup
```

Pin a specific version:

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --version 0.1.0
```

</TabItem>

<TabItem value="npm" label="npm">

If you already have Node 24+:

```bash
npm install -g @ethosagent/cli
```

Verify:

```bash
ethos --version    # @ethosagent/cli 0.1.0
```

If you don't have Node 24, the simplest path is the one-liner — it sets up nvm + Node for you. Or install Node manually from [nodejs.org](https://nodejs.org/) and re-run the npm command.

</TabItem>

<TabItem value="source" label="From source">

For contributors and source readers:

```bash
git clone https://github.com/MiteshSharma/ethos.git
cd ethos
pnpm install
pnpm dev          # tsx apps/ethos/src/index.ts
```

Requires Node 24+ and pnpm. The `pnpm dev` script runs the cli directly via `tsx` — no build step needed in development.

To work on a specific package:

```bash
pnpm --filter @ethosagent/cli build
pnpm --filter @ethosagent/core test
```

</TabItem>

</Tabs>

---

## 2. First run

```bash
ethos setup
```

The wizard asks for:

- **Provider** — `anthropic` or `openai-compat`
- **Model** — e.g. `claude-opus-4-7`, `gpt-4o`, `openrouter/anthropic/claude-3.5-sonnet`
- **API key** — stored only in `~/.ethos/config.yaml` on your machine
- **Default personality** — choose from the five built-ins or press Enter for `researcher`

### Don't have an API key yet?

Grab one from your provider — both have free tiers for evaluation:

| Provider | Get a key | Notes |
|---|---|---|
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Best fit for the default `claude-*` models |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | One key for Claude, GPT, Gemini, Llama, and more — pick `openai-compat` as the provider |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | Use `openai-compat` as the provider |

When the wizard finishes:

```bash
ethos chat        # open the REPL with the active personality
```

---

## 3. Your config file

The wizard writes `~/.ethos/config.yaml`:

```yaml title="~/.ethos/config.yaml"
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-XXXXXXXXXXXX
personality: researcher
```

Edit this file directly at any time. Changes take effect on the next `ethos chat`.

**Supported providers:**

| Value | Works with |
|---|---|
| `anthropic` | Claude models (Opus, Sonnet, Haiku) |
| `openai-compat` | OpenRouter, Ollama, Gemini, any OpenAI-compatible endpoint |

---

## 4. The `~/.ethos/` directory

```
~/.ethos/
├── config.yaml       ← provider, model, api key, personality
├── MEMORY.md         ← rolling project context (updated each session)
├── USER.md           ← who you are (role, preferences, expertise)
├── sessions.db       ← SQLite session history (WAL + FTS5)
└── personalities/    ← drop custom personalities here
```

`MEMORY.md` and `USER.md` are injected into every system prompt. Edit them directly to give the agent persistent context about you and your work.

---

## 5. Chat commands

Once inside the chat, these slash commands are available:

| Command | What it does |
|---|---|
| `/help` | Show all available commands |
| `/new` | Start a fresh session (history resets) |
| `/personality` | Show the active personality |
| `/personality list` | List all available personalities |
| `/personality <id>` | Switch to a different personality |
| `/model <name>` | Show current model |
| `/memory` | Display the contents of `MEMORY.md` and `USER.md` |
| `/usage` | Show token counts and estimated cost for this session |
| `/exit` | Quit the chat |

Sessions persist across restarts. The session key is scoped to your working directory — different directories get separate conversation histories.

---

## 6. Switching personalities

Five personalities ship with Ethos. Each has a curated toolset, a model, and a memory scope:

| Personality | Identity | Tools | Model | Memory |
|---|---|---|---|---|
| `researcher` | methodical · cites sources · flags uncertainty | 8 (web + file + memory) | `claude-opus-4-7` | `global` |
| `engineer` | terse · code-first · runs commands to verify | 10 (terminal + file + web + code) | `claude-sonnet-4-6` | `global` |
| `reviewer` | critical · evidence-based · always explains why | 3 (file + session search) | `claude-sonnet-4-6` | `per-personality` |
| `coach` | warm but direct · question-led · helps you think | 5 (web + memory + session) | `claude-opus-4-7` | `global` |
| `operator` | cautious · confirms before destructive · documents everything | 7 (terminal + file + code) | `claude-sonnet-4-6` | `per-personality` |

See [Built-in Personalities](/docs/personality/built-in-personalities) for the full toolset per personality.

Switch mid-session:

```bash
/personality engineer
```

Or set a permanent default in `~/.ethos/config.yaml`:

```yaml title="~/.ethos/config.yaml"
personality: engineer
```

---

## What's next

import DocCardList from '@theme/DocCardList';

<DocCardList items={[
  {
    type: 'link',
    href: '/docs/personality/what-is-a-personality',
    label: 'Personality',
    description: 'Understand how ETHOS.md, toolset.yaml, and config.yaml work together as a structural component.',
    docId: 'personality/what-is-a-personality',
  },
  {
    type: 'link',
    href: '/docs/tutorial/build-your-first-agent',
    label: 'Tutorial: Build your first agent',
    description: 'Walk through creating a custom personality and wiring AgentLoop in code.',
    docId: 'tutorial/build-your-first-agent',
  },
]} />
