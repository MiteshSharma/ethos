<p align="center">
  <img src="docs/static/img/logo.svg" alt="Ethos" width="80" height="80" />
</p>

# Ethos

[![CI](https://github.com/ethosagent/ethos/actions/workflows/ci.yml/badge.svg)](https://github.com/ethosagent/ethos/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ethosagent/cli.svg)](https://www.npmjs.com/package/@ethosagent/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org/)

Most AIs try to be good at everything. Ethos gives you a team — each one really good at just one thing.

> **Ethos builds AI agents that have an identity — not a prompt.**

You wouldn't hire one person to be your engineer and your researcher. Why pretend an AI can? Build your own personality with Ethos.

Five ship by default — pick one, or build your own:

- **engineer** — writes working code; tests what ships; refuses to pad.
- **researcher** — finds primary sources; flags uncertainty; shows the reasoning.
- **reviewer** — finds real problems; separates blocking from suggestion; does not soften.
- **coach** — asks one question at a time; helps you think, not for you.
- **operator** — dry-runs before destructive action; confirms; documents what happened.

Each runs across CLI, Telegram, Discord, Slack, and Email — same identity, same memory, same boundary, every surface. Teams are the other half: named personalities that coordinate through *visible artifacts* — a kanban board, a shared topic file, an audit trail — not behind one chatbot voice. The user can see who decided what.

## Quick install

### Standard install (Node 24+, Linux / macOS / WSL2)

```bash
npm i -g @ethosagent/cli
ethos setup           # provider + API key + personality selection (interactive)
ethos chat            # interactive REPL — talk to your agent
```

`ethos setup` writes `~/.ethos/config.yaml` and stores credentials in `~/.ethos/secrets/<ref>` with `chmod 0600`.

### Production install (always-on box: VPS, mini PC, Raspberry Pi 4+, Mac mini)

```bash
npm i -g @ethosagent/cli pm2
ethos setup
curl -O https://ethosagent.ai/ecosystem.config.js
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

`ethos run-all` spawns the gateway (all configured bot adapters + cron) and the web dashboard under one supervisor. PM2 keeps it alive across reboots and restarts on crash. Sizing, log rotation, upgrade flow, and troubleshooting: [Deploy in production →](https://ethosagent.ai/docs/using/how-to/deploy-in-production).

### Windows note

Native Windows is not a primary target. Use WSL2 (Ubuntu 22.04 or 24.04). Node 24+ inside the WSL distro; `~/.ethos/` lives in the Linux home, not the Windows mount.

## Installing the desktop app on macOS

Since the app is unsigned and unnotarized, macOS will block it on first open:

> "Ethos" cannot be opened because Apple cannot verify it is free from malware.

**Option A — right-click method (easier):**
1. Open the `.dmg` and drag Ethos to Applications
2. Right-click `Ethos.app` in your Applications folder
3. Click **Open**
4. Click **Open** again in the dialog that appears
5. The app opens. This only needs to be done once.

**Option B — terminal (if Option A doesn't work on macOS 15+):**
```sh
xattr -dr com.apple.quarantine /Applications/Ethos.app
```

## Getting started

```bash
ethos setup                       # first-time config — provider, keys, default personality
ethos chat                        # interactive REPL against the default personality
ethos chat --personality engineer # one-off with a specific personality

ethos personality list            # five built-ins + anything you've added
ethos personality show engineer   # character sheet: identity, tools, skills, model, fs_reach
ethos personality create my-team  # scaffold ~/.ethos/personalities/my-team/

ethos gateway                     # run all configured bot adapters (Telegram + Slack + ...)
ethos run-all                     # supervisor: gateway + web dashboard, one command

ethos sessions list               # browse past conversations
ethos sessions show <id>          # full transcript + tool calls

ethos memory show                 # MEMORY.md + USER.md for the active personality
ethos memory add "We use ESM, never CJS"   # durable note — survives sessions

ethos secrets list                # which credentials are configured (refs only, never values)
ethos secrets set providers/anthropic/apiKey   # set or rotate — chmod 0600 enforced

ethos cron add daily-digest "0 8 * * *" "summarize what you learned yesterday"
ethos skills install steipete/slack   # any clawhub skill, no fork required
ethos claw migrate --dry-run      # one-step from an existing OpenClaw install

ethos doctor                      # boot-time sanity check — config, keys, perms, providers
```

Full subcommand reference: [CLI reference →](https://ethosagent.ai/docs/using/reference/cli).

## CLI vs chat surfaces

The same actions are available on every surface. Pick the one the conversation lives on; sessions and memory follow the personality, not the channel.

| You want to | On the CLI | In Telegram / Slack / Discord / Email |
|---|---|---|
| Talk to the active personality | `ethos chat` | DM the bot, or `@ethos-bot` in a channel / group |
| Switch personality mid-conversation | `/personality reviewer` | `/personality reviewer` (if the bot's binding allows it) |
| Start a fresh session | `/new` | `/new` |
| See what the active personality is | `/personality` | `/personality` (or `/ethos personality` on Slack) |
| Inspect the full character sheet | `ethos personality show <id>` | `/ethos personality rich` (Slack) |
| Check what tools/skills are loaded | `ethos personality show <id>` | `/ethos skills` |
| Run a quick lookup against memory | `ethos memory show` | `/ethos memory show` |
| Append a durable note | `ethos memory add "..."` | `/ethos memory add ...` |
| List recent sessions | `ethos sessions list` | (CLI-only today) |
| Bring up the production stack | `ethos run-all` | (operator-only command) |

Bots are bound to a personality at config time. The default binding locks `/personality` switching off so external users can't reroute the bot — flip `allowSlashSwitch: true` if you want them to.

## Documentation

| Page | What it covers |
|---|---|
| [What is Ethos?](https://ethosagent.ai/docs/getting-started/what-is-ethos) | The 90-second mental model: why personality is structural, not prose. |
| [Why Ethos?](https://ethosagent.ai/docs/getting-started/why-ethos) | Honest comparison vs. LangChain, CrewAI, OpenClaw, Hermes — when each fits, when each doesn't. |
| [Architecture in 90 seconds](https://ethosagent.ai/docs/getting-started/architecture-90-seconds) | The 12-step `AgentLoop.run()` cycle, the four extension points, what's frozen vs. plug-in. |
| [Glossary](https://ethosagent.ai/docs/getting-started/glossary) | Every domain term in one place: personality, skill, tool, hook, session, memory scope, audience boundary. |
| [Using Ethos — Quickstart](https://ethosagent.ai/docs/using/quickstart) | Install the CLI, configure one provider, and get your first streamed reply. |
| [Run Ethos in Docker](https://ethosagent.ai/docs/using/how-to/run-in-docker) | One API key, one `docker compose up`, a talking web UI on `localhost:3000`. |
| [Building on Ethos — Quickstart](https://ethosagent.ai/docs/building/quickstart) | Write a tool, add a provider, build a channel adapter, publish a plugin. Ten minutes. |
| [Built-in personalities](https://ethosagent.ai/docs/using/explanation/built-in-personalities) | What each of the five does, when to pick which, how to compose your own. |
| [Memory model](https://ethosagent.ai/docs/using/explanation/memory-model) | `MEMORY.md` vs `USER.md`, per-personality vs. global scope, team memory. |
| [Configure providers](https://ethosagent.ai/docs/using/how-to/configure-providers) | Anthropic, OpenAI, OpenRouter, Ollama, local LLMs. |
| [Use Ethos as an MCP server](https://ethosagent.ai/docs/using/how-to/use-as-mcp-server) | Expose personalities to Claude Desktop, Cursor, and other MCP clients. |
| [Deploy on EC2](https://ethosagent.ai/docs/using/how-to/deploy-on-ec2) | A full production walkthrough including IAM, secrets, log rotation, backup. |
| [Tool capability framework](https://ethosagent.ai/docs/building/explanation/why-capabilities) | The declarative contract every tool implements: network, secrets, storage, fs_reach, process. |

## Migrating from OpenClaw or Hermes

`ethos claw migrate` carries memory, skills, platform tokens, and provider keys from an existing OpenClaw or Hermes install into the Ethos layout. Dry-run first:

```bash
ethos claw migrate --dry-run     # preview the plan; touches nothing
ethos claw migrate               # apply
```

What moves cleanly:

- `MEMORY.md` and `USER.md` → the new personality's memory scope, identical semantics.
- `SOUL.md` (OpenClaw) → a `migrated` personality with `SOUL.md` derived from it; built-in matches resolve automatically (`engineer.md` lands on the built-in `engineer`, etc.).
- Platform tokens (Telegram bot tokens, Slack app credentials, Discord tokens) → the new `SecretsResolver` with `chmod 0600`, referenced from `config.yaml` as `${secrets:slack/<bot>/botToken}`.
- Provider API keys → `~/.ethos/secrets/providers/<provider>/apiKey`.
- Skills directory → unchanged path semantics; OpenClaw-compat parses `SKILL.md` frontmatter, env substitutions, and OS gates, so existing clawhub skills install and run without modification.

Idempotent — safe to re-run. What does not move (and why is documented in the migration guide):

- Anything that was inline plaintext in `config.yaml` migrates to the secrets resolver; the config file gets rewritten to use `${secrets:...}` refs.
- Personality boundary settings (`fs_reach`, `safety.network.allow`) are *added* on migration with safe defaults; review them before the first bot run.

Full migration reference: [Migrate from OpenClaw →](https://ethosagent.ai/docs/using/how-to/migrate-from-openclaw).

You can also stay on your existing setup and install Ethos-native skills *into* OpenClaw or Hermes — every Ethos skill is `SKILL.md`-shaped and runs unmodified. The migration command is for operators who want the full personality-is-architecture model.

## Contributing

Three documents are mandatory reading before any non-trivial change:

| Doc | When |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Codebase guide — architecture, conventions, gotchas, learnings. Read before writing code. |
| [`DESIGN.md`](./DESIGN.md) | Visual system — tokens, typography, motion, per-surface mapping. Read before any UI work (web, TUI, VS Code, email templates). |
| [`.agents/skills/docs/SKILL.md`](./.agents/skills/docs/SKILL.md) | Docs system — page kinds, front-matter contract, voice rules, anti-patterns. Read before writing or editing any documentation. |
| [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) | The checklist your PR will be evaluated against. |

Local setup:

```bash
git clone https://github.com/ethosagent/ethos
cd ethos
make prepare    # pnpm install + git hooks
make check      # typecheck + lint + test (mirror of CI)
make dev        # run the CLI from source
```

Repo layout:

```text
packages/    @ethosagent/{types, core, plugin-sdk, plugin-contract, ...}
extensions/  llm-*, session-*, memory-*, platform-*, tools-*, gateway, ...
apps/        ethos (CLI), tui, vscode-extension, web, web-api
docs/        Docusaurus site — content/, plugins/, scripts/
plan/        Architecture notes, phase plans, completed plans
```

The CLI binary entry is [`apps/ethos/src/index.ts`](apps/ethos/src/index.ts). Every extension point is a typed interface in [`packages/types/src/index.ts`](packages/types/src/index.ts), injected into `AgentLoop` at construction. Core never imports concrete implementations.

Open an issue before non-trivial changes — alignment is cheaper than rework. Look for `good-first-issue` to find a starter task. Plugin authors: the [plugin SDK quickstart](https://ethosagent.ai/docs/building/quickstart) shows how to publish a tool, hook, channel adapter, or memory provider as a standalone npm package.

## Community

- **Issues:** [github.com/ethosagent/ethos/issues](https://github.com/ethosagent/ethos/issues) — bug reports, feature requests, questions
- **Docs site:** [ethosagent.ai/docs](https://ethosagent.ai/docs)
- **Plugin examples:** [`examples/plugins/`](./examples/plugins/) — `hello`, `personality`, `safety-adapter` (use as templates)
- **OpenClaw skill catalog:** any [clawhub](https://github.com/anthropics/skills) skill installs unchanged via `ethos skills install <slug>`
- **MCP clients:** Ethos is consumable from Claude Desktop, Cursor, and other MCP hosts — see [Use Ethos as an MCP server →](https://ethosagent.ai/docs/using/how-to/use-as-mcp-server)

## License

[MIT](./LICENSE)
