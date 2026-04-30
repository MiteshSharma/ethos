# Ethos

[![CI](https://github.com/MiteshSharma/ethos/actions/workflows/ci.yml/badge.svg)](https://github.com/MiteshSharma/ethos/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ethosagent/cli.svg)](https://www.npmjs.com/package/@ethosagent/cli)
[![npm downloads](https://img.shields.io/npm/dm/@ethosagent/cli.svg)](https://www.npmjs.com/package/@ethosagent/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node 24+](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

**Run an AI agent in your terminal, on Telegram, on Slack, or as a scheduled job. Switch personalities to swap tone, tools, and memory in one command.**

Ethos is a TypeScript framework where a *personality* — an `ETHOS.md` identity, a skills directory, an allowed toolset, and a config — is a structural component, not a system prompt string. Same prompt, different personality, different behavior. Every component (LLM provider, session store, memory, tools, hooks, channel adapters) is an interface in `@ethosagent/types` and injected at construction time, so contributors can replace any layer without touching core.

📖 [Docs](https://ethosagent.ai) · [Project guidelines](./CLAUDE.md)

```bash
# Install (recommended)
curl -fsSL https://ethosagent.ai/install.sh | bash

# Or via npm — Node 24+
npm i -g @ethosagent/cli && ethos setup

# Or from source (contributors)
git clone https://github.com/MiteshSharma/ethos && cd ethos && make setup
```

---

## What you can do with it

**Ask a research question, get a cited answer.**

```text
$ ethos chat
You: what changed in Postgres 17's logical replication?
researcher: Postgres 17 added two improvements to logical replication: …
            [1] postgresql.org/docs/17/logical-replication-row-filters
            [2] aws.amazon.com/blogs/database/...
```

**Switch personality and watch the same prompt behave differently.**

```text
You: clean up the build artifacts in this folder

operator:  I'll list what I'd remove first. Found 47 files in `dist/` and 12 in
           `coverage/`. Run `rm -rf dist/ coverage/` to delete them — confirm? (y/N)

engineer:  ⏵ terminal rm -rf dist/ coverage/
           → done.
```

**Schedule it — let it work while you sleep.**

```bash
$ ethos cron create "every weekday at 9am" \
    --personality researcher \
    --task "summarize my unread Slack DMs and email me the digest"
```

Same agent, three modes: terminal, daemonless cron, plus opt-in channels (Telegram, Slack, Discord, WhatsApp, Email).

---

## Try it locally (≈ 2 minutes)

You'll need Node 24+ (the installer takes care of it) and an Anthropic, OpenRouter, Ollama, or Gemini API key.

```bash
# 1. Install
curl -fsSL https://ethosagent.ai/install.sh | bash

# 2. Configure
ethos setup
#   provider: anthropic
#   model:    claude-opus-4-7
#   api key:  sk-ant-...
#   personality: researcher

# 3. Run
ethos chat
```

Inside chat:

```text
/personality list       list available personalities
/personality engineer   switch personality (changes tools, tone, model)
/memory                 show what the agent remembers about you
/usage                  show tokens spent and estimated cost
/verbose                show per-turn timing — where did those 5 seconds go?
/new                    start a fresh session
/help                   all commands
```

Sessions persist across restarts. The session key is scoped to your working directory (`cli:<cwd-basename>`), so different projects get separate conversation histories.

---

## Personalities — the central abstraction

Five personalities ship out of the box. Each has its own `ETHOS.md`, allowed toolset, and memory scope.

| Personality | Identity | Toolset | Memory |
|---|---|---|---|
| `researcher` | Methodical, citation-focused, uncertainty-aware | web search + file read + memory | global |
| `engineer` | Terse, code-first, direct | terminal + file + web + code execution | global |
| `reviewer` | Critical, structured, evidence-based | file read only | per-personality |
| `coach` | Warm, questioning, growth-focused | web + memory | global |
| `operator` | Cautious, confirms before acting, dry-run first | terminal + file + code (no web) | per-personality |

Add your own by dropping a directory into `~/.ethos/personalities/<id>/`:

```text
~/.ethos/personalities/strategist/
├── ETHOS.md        ← who the agent is (first-person identity)
├── config.yaml     ← name, model, memoryScope
└── toolset.yaml    ← list of allowed tools
```

The personality directory is mtime-cached and hot-reloads on edit. The personality schema is intentionally small and frozen — see [Design doctrine](#design-doctrine) before proposing additions.

---

## Safety & isolation — what each personality can actually reach

Other agent frameworks treat "personality" as a system prompt. In Ethos, **each personality is its own least-privilege bubble**. Switching personality changes what's reachable, not just how the agent talks.

| Boundary | Mechanism | Default |
|---|---|---|
| **Filesystem** | `fs_reach.read` / `fs_reach.write` — absolute path-prefix allowlists. `read_file` / `write_file` route through `ScopedStorage` and reject paths outside the list. | A personality can only read/write its own dir + skills + cwd. Reaching another personality's `MEMORY.md` returns a boundary error. |
| **MCP servers** | `mcp_servers` allowlist on `config.yaml`. MCP tools are filtered per-personality — server names not in the list are invisible. | Default-deny. A globally configured MCP server is invisible until you `ethos personality mcp <id> --attach <name>`. |
| **Plugins** | `plugins` allowlist. Installed plugins are inert until at least one personality lists them. | Default-deny. `ethos personality plugins <id> --attach <plugin-id>` to activate. |
| **Skills** | Universal scanner discovers from every ecosystem; per-personality filter (capability mode default) keeps only skills whose `required_tools` are a subset of this personality's toolset. | A deploy skill that needs `terminal` is automatically rejected by personalities that don't have `terminal`. No manual scoping. |
| **Tool access** | `toolset.yaml` exact-match allowlist. | Empty list = no tools. |

The threat model: **a benign LLM occasionally led astray, not a hostile attacker with shell access.** This is defense-in-depth — clean structural rejection by personality, enforced at the framework layer, not advisory.

---

## Skills — bring your existing library, scoped per role

The universal skill scanner discovers skills from your existing ecosystem libraries — **no porting required**:

```text
~/.ethos/skills/         → loaded as-is (your Ethos-native skills)
~/.claude/skills/        → discovered, agentskills.io dialect
~/.openclaw/skills/      → discovered, OpenClaw dialect
~/.opencode/skills/      → discovered
~/.hermes/skills/        → discovered, Hermes dialect
.ethos/skills/           → project-local skills (per-cwd)
```

The global pool is then **filtered per personality**. By default, a skill flows to a personality only if its `required_tools` match the personality's `toolset` — meaning a deploy skill never reaches your researcher, even though both can see the same global library.

You can override the filter mode in `config.yaml`:

```yaml
skills:
  global_ingest:
    mode: capability   # default — required_tools must subset personality.toolset
    # mode: explicit   # default-deny: only names in `allow:` flow in
    # mode: tags       # match by skill tags
    # mode: none       # disable global ingest; only per-personality skills/ folder
```

**Strategic claim:** every skill from every framework, but each role only sees what's appropriate to it. No other framework gives you universal compat AND structural per-personality scoping. ([Plan: extension_plan.md](./plan/extension_plan.md))

---

## Surfaces

The CLI is the supported install. Channels and integrations are opt-in — if you only want `ethos chat`, you never need a daemon running.

| Surface | Setup | Use it for |
|---|---|---|
| **Telegram** | add `telegramToken`, run `ethos gateway start` | Chat with the agent from your phone |
| **Discord** | add `discordToken`, run `ethos gateway start` | Personal or team bot |
| **Slack** | add `slackBotToken` + `slackAppToken`, run `ethos gateway start` | Workspace-wide agent |
| **WhatsApp** | run `ethos gateway start` and scan QR | Same agent, in WhatsApp |
| **Email** | add IMAP/SMTP creds | Reply by email; scheduled inbox digests |
| **Cron** | `ethos cron create "<schedule>" --task "..."` | Scheduled jobs that share memory and skills |
| **VS Code (ACP)** | install the Ethos extension | Sidebar chat with full agent inside the editor |
| **MCP** | add a server to `~/.ethos/mcp.json` + `ethos personality mcp <id> --attach <name>` | Auto-register any MCP server's tools, scoped per personality |
| **Skills** | `ethos skills install <slug>` for [clawhub](https://clawhub.ai); otherwise auto-discovered | Community catalogs (clawhub, agentskills.io standard) plus auto-scan of `~/.claude/skills/`, `~/.openclaw/skills/`, `~/.opencode/skills/`, `~/.hermes/skills/` |

---

## Configuration

`~/.ethos/config.yaml` — `ethos setup` writes a working version on first run; edit directly to add channels.

```yaml
provider: anthropic              # anthropic | openrouter | ollama | gemini
model:    claude-opus-4-7
apiKey:   sk-ant-...
personality: researcher

# Optional — different model per personality
modelRouting:
  researcher: anthropic/claude-opus-4-7
  engineer:   moonshotai/kimi-k2.6

# Optional — opt into channels
telegramToken: 123456:ABC-...
slackBotToken: xoxb-...
```

Full reference: [docs/configuration](https://ethosagent.ai/configuration).

---

## Migrating from OpenClaw

<details>
<summary>One-command migration from <code>~/.openclaw/</code> to <code>~/.ethos/</code></summary>

```bash
ethos claw migrate --dry-run   # preview the plan
ethos claw migrate             # apply (idempotent)
```

Memory, skills, platform tokens, and API keys copy in place. Your `SOUL.md` becomes a migrated personality; existing OpenClaw skills run unmodified through the compat layer.

```bash
ethos skills install steipete/slack    # any clawhub slug works
ethos skills install github:owner/repo # any GitHub source
```

Flags: `--preset user-data` (skip personality), `--overwrite`, `-y` (skip confirmation).

</details>

---

## Embed ethos in your own app

`@ethosagent/core` and `@ethosagent/types` are published separately so you can use the `AgentLoop` directly without the CLI.

```bash
npm install @ethosagent/core @ethosagent/types @ethosagent/llm-anthropic @ethosagent/session-sqlite
```

```typescript
import { AgentLoop } from '@ethosagent/core';
import { AnthropicProvider } from '@ethosagent/llm-anthropic';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';

const loop = new AgentLoop({
  llm: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  sessionStore: new SQLiteSessionStore('./sessions.db'),
  // memoryProvider, personalityRegistry, toolRegistry — see docs
});

for await (const event of loop.run({ sessionKey: 'my-app:123', text: 'hello' })) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
}
```

Plugin authors should depend on `@ethosagent/types` + `@ethosagent/plugin-sdk` only — those are the stable contract surface (see [Design doctrine](#design-doctrine)).

---

# Contributing

The rest of this README is for people who want to work on ethos. Read [CLAUDE.md](./CLAUDE.md) too — it's the long-form companion that captures the gotchas and conventions discovered during development.

## Set up for development

```bash
git clone https://github.com/MiteshSharma/ethos
cd ethos

make setup       # installs nvm, Node 24, pnpm, gstack
make prepare     # pnpm install across workspaces
make check       # typecheck + lint + test (run this before every PR)
make dev         # start the agent locally
```

Path aliases in `tsconfig.json` point all `@ethosagent/*` imports to `./src/` directly — no build step in dev. `tsx` handles extensionless TypeScript imports; `tsup` bundles for production.

| Command | What it does |
|---|---|
| `make setup` | First-time machine setup (nvm, Node 24, pnpm) |
| `make prepare` | Install all workspace dependencies |
| `make dev` | Run the CLI from source with `tsx` |
| `make check` | Full CI pass — typecheck + lint + vitest |
| `make test` | `vitest run` |
| `make typecheck` | `tsc --noEmit` across workspaces |
| `make lint` | `biome check .` |
| `make format` | `biome check --write .` |
| `make clean` | Remove `node_modules` and `dist` |

## Architecture

The core abstraction is **`AgentLoop`** — a 12-step `AsyncGenerator<AgentEvent>` that takes a user message and streams typed events back. Every component is an interface defined in `@ethosagent/types` and injected at construction time.

```text
~/.ethos/config.yaml
        │
        ▼
    wiring.ts                    assembles all components
    ├── LLMProvider              AnthropicProvider | OpenAICompatProvider
    ├── SessionStore             SQLiteSessionStore (WAL + FTS5)
    ├── MemoryProvider           MarkdownFileMemoryProvider
    └── PersonalityRegistry      FilePersonalityRegistry (mtime hot-reload)
        │
        ▼
    AgentLoop.run(text)          AsyncGenerator<AgentEvent>
    ├── session_start hooks
    ├── MemoryProvider.prefetch()    → system context
    ├── ContextInjector[]            → system prompt assembly
    ├── before_prompt_build hooks
    ├── LLMProvider.complete()       → stream chunks
    │   ├── text_delta events
    │   ├── tool_use_start/delta/end
    │   └── usage event
    ├── ToolRegistry.executeParallel()
    │   ├── before_tool_call hooks   (arg override / rejection)
    │   ├── parallel execution with budget splitting
    │   └── after_tool_call hooks
    ├── MemoryProvider.sync()
    └── agent_done hooks
```

**Extension points** (any of these can be replaced without touching core):

`LLMProvider` · `SessionStore` · `MemoryProvider` · `ToolRegistry` · `HookRegistry` · `PlatformAdapter` · `ContextInjector` · `PersonalityRegistry`

## Monorepo layout

```text
ethos/
├── packages/
│   ├── types/                  @ethosagent/types               zero-dep interface contracts
│   ├── core/                   @ethosagent/core                AgentLoop + registries + defaults
│   ├── plugin-sdk/             @ethosagent/plugin-sdk          tool/memory/adapter helpers + testing utils
│   └── plugin-contract/        @ethosagent/plugin-contract     marketplace validation schema
│
├── extensions/
│   ├── llm-anthropic/          AnthropicProvider, prompt caching, AuthRotatingProvider
│   ├── llm-openai-compat/      OpenAICompatProvider for OpenRouter / Ollama / Gemini
│   ├── session-sqlite/         WAL + FTS5 session store
│   ├── memory-markdown/        MEMORY.md / USER.md provider
│   ├── memory-vector/          SQLite vector memory
│   ├── personalities/          5 built-in personalities + FilePersonalityRegistry
│   ├── skills/                 SkillsInjector + clawhub compat layer
│   ├── gateway/                Lane-based concurrency + dedup cache
│   ├── platform-{telegram,discord,slack,whatsapp,email}/
│   ├── tools-{file,terminal,web,memory,browser,code,cron,delegation,mcp}/
│   ├── acp-server/             JSON-RPC over stdio + HTTP/WS
│   ├── agent-mesh/             ACP-native peer mesh
│   ├── batch-runner/           Atropos JSONL batch runs
│   ├── eval-harness/           Scored eval runner
│   ├── skill-evolver/          Self-generating skills
│   └── claw-migrate/           OpenClaw → Ethos migration
│
├── apps/
│   ├── ethos/                  @ethosagent/cli                 the binary
    ├── tui/                    Terminal UI
    └── vscode-extension/       VS Code sidebar

```

**Tooling:** pnpm workspaces · TypeScript 6 (strict) · tsx (dev) · tsup (prod) · vitest 4 · Biome 2 · Node 24

## How to extend ethos

| Adding a... | Where it goes | Reference |
|---|---|---|
| **LLM provider** | new `extensions/llm-<name>/` implementing `LLMProvider` | [CLAUDE.md → Adding a new LLM provider](./CLAUDE.md#adding-a-new-llm-provider) |
| **Tool** | implement `Tool<TArgs>`; group by `toolset`; declare `maxResultChars` | [CLAUDE.md → Adding a new tool](./CLAUDE.md#adding-a-new-tool) |
| **Personality** | drop a directory in `~/.ethos/personalities/<id>/` or `extensions/personalities/data/` | [CLAUDE.md → Adding a personality](./CLAUDE.md#adding-a-personality) |
| **Channel adapter** | new `extensions/platform-<name>/` implementing `PlatformAdapter` | study `platform-telegram` and `platform-discord` |
| **Plugin (npm)** | depend on `@ethosagent/plugin-sdk`; ship `index.ts` exporting your factory |  |
| **Hook** | call `hookRegistry.register{Void,Modifying,Claiming}(eventName, handler)` — pick the model that fits | [CLAUDE.md → Hook registry](./CLAUDE.md#hook-registry) |

## Testing & quality gates

`make check` is the gate. It runs:

- **`tsc --noEmit`** across all workspaces. Strict mode is on. `noNonNullAssertion` is enforced — no `array[n]!` or `map.get(key)!`.
- **`biome check .`** — single quotes, 2-space indent, 100-char line width. Auto-fix with `make format`.
- **`vitest run`** — unit + integration tests. Add a test for every contract change. Integration tests against SQLite must hit a real database, not mocks.

A few non-obvious testing rules captured the hard way (full list in [CLAUDE.md → Learnings](./CLAUDE.md#learnings-from-building-this-codebase)):

- SQLite `STRICT` tables enforce column types — pass properly typed values to `.run()`.
- Same-timestamp inserts need `rowid` tie-breaking; `getMessages` returns the *newest* N, not the oldest.
- Every `tool_use` block in an Anthropic message needs a matching `tool_result` in the next user message — including for hook-rejected tools.
- OpenAI tool-call streaming is index-keyed, not ID-keyed — build a `Map<number, …>` keyed by index.

## Design doctrine

Read these *before* opening a non-trivial PR. They're the rules that decide whether changes get merged.

1. **Simplicity first.** Minimum code that solves the problem. No abstractions for single-use code. No "configurability" that wasn't requested. If you write 200 lines and it could be 50, rewrite it.
2. **Surgical changes.** Touch only what the task requires. Don't refactor adjacent code, comments, or formatting. Match existing style even if you'd do it differently.
3. **Interface contracts first.** All extension points live in `@ethosagent/types`. Core never imports concrete implementations. `@ethosagent/types` has zero runtime deps — keep it that way.
4. **Personality schema is frozen.** Adding a top-level field to `PersonalityConfig` requires a CHANGELOG entry justifying why it isn't a skill, a tool, or a memory section.
5. **Plugin contract version gate.** Any field rename, removal, or required-field addition in `@ethosagent/plugin-contract` is a major bump. Loaders reject incompatible majors.
6. **No daemon dependence.** No top-level feature requires the gateway to be running. Cron, skills, memory, evals, delegation must work CLI-first.
7. **Tool progress is internal by default.** `tool_progress` events default to `audience: 'internal'` — UI surfaces ignore them. User-visible progress is opt-in per event.
8. **Subagent task lives in the first user message.** Never the system prompt. Never both.

The full long-form list is in [CLAUDE.md](./CLAUDE.md) — including SQLite gotchas, Anthropic SDK quirks, OpenAI streaming patterns, and why we use `tsx` instead of `--experimental-strip-types`.

## Contribution workflow

1. Open an issue first for non-trivial changes — alignment is cheaper than rework.
2. Branch from `main`, keep changes surgical, run `make check` before pushing.
3. Add tests for every contract change; the test should fail without your change.
4. Reference the related work or section in CLAUDE.md in your PR description.
5. PRs touching `PersonalityConfig`, `@ethosagent/plugin-contract`, or `@ethosagent/types` need explicit review against the design doctrine above.

A `CONTRIBUTING.md` with the long-form version of the workflow is on the way. Until then, this section + [CLAUDE.md](./CLAUDE.md) is the source of truth.

## License

[MIT](./LICENSE)
