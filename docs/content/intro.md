---
title: "Ethos"
description: "Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically."
kind: explanation
audience: shared
slug: /
updated: 2026-06-09
---

**[Personalities](getting-started/glossary.md#personality) aren't hats you swap in the prompt. They're enforced boundaries.** A personality in Ethos is a directory of files — `SOUL.md`, `config.yaml`, `toolset.yaml` — that the runtime treats as a structural component. Switching it changes prompt, tools, memory, and model atomically. The boundary is enforced at the [tool registry](getting-started/glossary.md#tool), not requested in the prompt.

That single decision pays off six ways:

- **Structural isolation.** The `reviewer` personality's `toolset.yaml` omits `write_file`. No prompt — yours, the model's, an injected one — can talk it into editing the diff under review. The framework refuses the call.
- **One agent, every surface.** Nine surfaces — CLI, web dashboard, desktop app, VS Code extension, and five [channel adapters](getting-started/glossary.md#channel-adapter) (Telegram, Discord, Slack, WhatsApp, email) — share the same [session](getting-started/glossary.md#session) layer. Start a conversation on Telegram, continue it on the CLI, switch personalities mid-thread — same [memory](getting-started/glossary.md#memory), same history.
- **Safe plugins.** Every [tool](getting-started/glossary.md#tool) declares what it reads, what it writes, and what network it touches. The runtime enforces those declarations per call. Granting an unfamiliar [plugin](getting-started/glossary.md#plugin) to a personality is bounded by what its toolset already allows.
- **Teams, not just agents.** A coordinator personality decomposes one request into specialist tasks; the [team](getting-started/glossary.md#team) executes them against a durable kanban board with a full audit trail. Same primitives — personality, toolset, session — composed.
- **A web dashboard and desktop app.** `ethos serve --web` launches a React SPA. Chat, sessions, personalities, skills, MCP servers, plugins, memory, teams, cron jobs, activity feed, batch/eval — managed from one place. The Electron desktop app adds a system tray, quick-chat overlay, and global shortcuts.
- **Skills that evolve.** The skill-evolver analyzes eval output, proposes rewrites for underperforming [skills](getting-started/glossary.md#skill), and drafts new skills for recurring patterns. You approve or reject from the web dashboard or desktop app.

Three personalities ship by default for everyday use. Two system personalities — personality-architect and team-architect — are available for building and managing agents. Plugins register slash commands (e.g. `/market brief`) that work across CLI, Telegram, Discord, Slack, and the web UI. Your existing Claude Code, OpenClaw, OpenCode, and Hermes skill libraries run as-is, filtered to the right specialist per personality. Zero mode (`ethos -z`) runs one-shot prompts with no readline — pipe it into scripts, CI, or cron. Inline `@ref` context (`@file`, `@url`) pulls external sources into the conversation without copy-paste.

The runtime streams end-to-end: every turn emits an `AsyncGenerator<AgentEvent>` — text deltas, tool events, usage, done — and every component is injected at construction, never reached for globally.

## What you can build

<div className="docsGrid">

<a className="docsCard" href="/docs/using/quickstart">
  <h3>Ship a Telegram bot that remembers you</h3>
  <p>Pick a personality, connect a Telegram token, deploy. Sessions persist across restarts; memory carries forward.</p>
</a>

<a className="docsCard" href="/docs/building/how-to/register-plugin-data-source">
  <h3>Build dashboards from plugin data</h3>
  <p>Plugins expose SQLite databases and declare widget templates. You compose draggable panels that query those data sources in real time.</p>
</a>

<a className="docsCard" href="/docs/using/how-to/use-zero-mode">
  <h3>Run one-shot prompts in CI pipelines</h3>
  <p><code>ethos -z "summarize this diff"</code> — zero mode, no readline, stdout-only. Pipe it into git hooks, GitHub Actions, cron.</p>
</a>

<a className="docsCard" href="/docs/using/how-to/manage-skill-evolution">
  <h3>Let the agent learn from usage</h3>
  <p>The skill-evolver watches eval results, proposes rewrites for weak skills, drafts new ones for recurring patterns. You approve from the dashboard.</p>
</a>

<a className="docsCard" href="/docs/using/how-to/use-web-dashboard">
  <h3>Manage everything from one dashboard</h3>
  <p>Web dashboard or desktop app. Chat, sessions, personalities, plugins, MCP servers, memory, teams, <a href="/docs/getting-started/glossary#mesh">mesh</a> topology, cron, batch/eval — one surface.</p>
</a>

<a className="docsCard" href="/docs/using/explanation/plugin-commands">
  <h3>Extend with slash commands</h3>
  <p>Plugins register commands like <code>/market brief</code> that work across CLI, Telegram, Discord, Slack, and the web UI.</p>
</a>

</div>

## Two doors

The rest of these docs split by what you're here to do — run Ethos, or extend it.

<div className="docsGrid">

<a className="docsCard" href="/docs/using/quickstart">
  <h3>Using Ethos →</h3>
  <p>Install the CLI, configure a provider, run your first chat, ship a Telegram bot. Five minutes to first message.</p>
</a>

<a className="docsCard" href="/docs/building/quickstart">
  <h3>Building on Ethos →</h3>
  <p>Write a tool, add an LLM provider, build a channel adapter, publish a plugin. Ten minutes to first commit.</p>
</a>

</div>

## Before you choose a door

- [What is Ethos?](getting-started/what-is-ethos.md) — 90-second mental model of personalities, sessions, and the streaming event contract.
- [Architecture in 90 seconds](getting-started/architecture-90-seconds.md) — one diagram of `AgentLoop` and every component that hangs off it.
- [Why Ethos?](getting-started/why-ethos.md) — honest comparison to LangChain, CrewAI, AutoGen, OpenClaw, and Hermes.
- [Glossary](getting-started/glossary.md) — every domain term in one place.

## For AI agents reading these docs

Other AI agents (Claude Code, Cursor, OpenClaw, Hermes) are first-class readers of Ethos's docs. Once Phase 6 of the docs rewrite lands, three agent-readable surfaces ship alongside the site: `llms.txt` (link-index), `llms-full.txt` (full content), and per-page raw markdown at `<path>.md`. The convention is documented in the [`/docs` skill, §Agent-readable surface](https://github.com/ethosagent/ethos/blob/main/.agents/skills/docs/SKILL.md#agent-readable-surface-two-file--raw-markdown).

The full Ethos type contract — `AgentEvent`, `Tool`, `LLMProvider`, `MemoryProvider`, `HookRegistry`, `SessionStore` — lives in a single zero-dependency package (`@ethosagent/types`). Every extension point is typed there. When scaffolding an integration, start with those interfaces; all concrete implementations (the CLI, channel adapters, storage backends) are downstream of them.

If you are generating Ethos configuration (personalities, `mcp.json`, `config.yaml`), the schema files live under `packages/types/src/` in the repository. The [MCP config reference](using/reference/mcp-config.md) and [personality config reference](using/reference/personality-yaml.md) are the human-readable versions of those schemas.

Session keys follow the convention `cli:<cwd-basename>` at the CLI. Different working directories get independent conversation histories. The same session key used across Telegram, CLI, and a channel adapter returns the same message history — the session store is keyed by context, not by channel.

Tool calls outside a personality's `toolset.yaml` allowlist are rejected at the framework level and return an error `tool_result` to keep the LLM message contract intact — the rejection is never silently dropped.
