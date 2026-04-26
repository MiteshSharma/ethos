---
title: Welcome to Ethos
sidebar_position: 1
---

# Welcome to Ethos

**Ethos is a TypeScript framework for building AI agents that stay specialized — not generic do-everything bots.**

You pick a personality (`researcher`, `engineer`, `reviewer`, `coach`, `operator`), and the agent's tool access, memory scope, and model all change together. Five specialists ship by default. You can write your own.

Your conversations persist across restarts. The same agent runs on the CLI, Telegram, Discord, and Slack with shared session history.

## Pick your starting point

- **Just want to use it?** → [Quickstart](/docs/getting-started/quickstart) — install + first chat in five minutes.
- **Want to understand the design?** → [Why Ethos?](/docs/getting-started/why-ethos) — honest comparison with LangChain, CrewAI, AutoGen.
- **Building on top?** → [Tutorial](/docs/tutorial/build-your-first-agent) — walk through your first custom personality.
- **Extending the framework?** → [Extending Ethos](/docs/extending-ethos/overview) — add LLM providers, tools, platform adapters, plugins.

## What makes a personality structural

A personality is a directory:

```
~/.ethos/personalities/<id>/
├── ETHOS.md        ← first-person identity
├── config.yaml     ← name, model, memoryScope
└── toolset.yaml    ← allowed tool names
```

Switching personalities mid-conversation changes:

- The system prompt (via `ETHOS.md`)
- The tools the agent can call (via `toolset.yaml`)
- Whether memory is shared or isolated (via `memoryScope`)
- Which model handles the next turn (via `model`)

All four change atomically. That's what we mean by *personality is architecture, not a system prompt*.

[Read more about personalities →](/docs/personality/what-is-a-personality)
