---
title: Quickstart
description: Install Ethos, run the setup wizard, and start your first agent chat in under five minutes.
sidebar_position: 1
---

# Quickstart

Get Ethos running on your machine. You need [nvm](https://github.com/nvm-sh/nvm) installed.

---

## 1. Install

One-time machine setup — installs Node 24 and pnpm if they are not already present.

```bash
make setup
```

Then install workspace dependencies:

```bash
make prepare
```

---

## 2. First run

```bash
make dev
```

On the first run, `ethos setup` launches a wizard that asks for:

- **Provider** — `anthropic` or `openai-compat`
- **Model** — e.g. `claude-opus-4-7`, `gpt-4o`, `openrouter/anthropic/claude-3.5-sonnet`
- **API key** — stored only in `~/.ethos/config.yaml` on your machine
- **Default personality** — choose from the five built-ins or press Enter for `researcher`

After setup completes, the chat interface opens automatically.

---

## 3. Your config file

The wizard writes `~/.ethos/config.yaml`:

```yaml title="~/.ethos/config.yaml"
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-XXXXXXXXXXXX
personality: researcher
```

Edit this file directly at any time. Changes take effect on the next `make dev`.

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

Five personalities ship with Ethos:

| Personality | Character | Toolset |
|---|---|---|
| `researcher` | Methodical, citation-focused, uncertainty-aware | web + file + memory |
| `engineer` | Terse, code-first, direct | terminal + file + web |
| `reviewer` | Critical, structured, evidence-based | file read only |
| `coach` | Warm, questioning, growth-focused | web + memory |
| `operator` | Cautious, confirms before acting | terminal + file (no web) |

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
