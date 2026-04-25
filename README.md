# Ethos

**The agent framework where personality is architecture.**

Ethos is a TypeScript framework for building AI agents where a *personality* — an `ETHOS.md` identity file, a skills directory, a toolset, and a config — is a structural component, not a system prompt string. Swap personalities to change tone, tool access, memory scope, and model routing in one command.

---

## What's built

The CLI is working end-to-end against a real LLM.

| Package | What it does |
|---|---|
| `@ethosagent/types` | Zero-dep interface contracts — every component implements these |
| `@ethosagent/core` | `AgentLoop`, `ToolRegistry`, `HookRegistry`, `PluginRegistry`, in-memory defaults |
| `@ethosagent/llm-anthropic` | `AnthropicProvider` with prompt caching, extended thinking, `AuthRotatingProvider` |
| `@ethosagent/llm-openai-compat` | `OpenAICompatProvider` for OpenRouter / Ollama / Gemini (with schema normalization) |
| `@ethosagent/session-sqlite` | WAL-mode SQLite session store with FTS5 full-text search |
| `@ethosagent/memory-markdown` | Reads `~/.ethos/MEMORY.md` + `USER.md` on prefetch, applies updates on sync |
| `@ethosagent/personalities` | Loads built-in + user personalities from disk with mtime hot-reload |
| `@ethosagent/cli` | `ethos setup`, `ethos chat`, `ethos personality`, `ethos memory` commands |

**51 tests passing. Zero TypeScript errors.**

---

## Getting started

**Prerequisites:** [nvm](https://github.com/nvm-sh/nvm)

```bash
# One-time machine setup (nvm, Node 24, pnpm)
make setup

# Install workspace dependencies
make prepare

# First run — launches setup wizard, then opens chat
make dev
```

### First-run wizard

`ethos setup` asks for your LLM provider, model, API key, and default personality, then writes `~/.ethos/config.yaml` and scaffolds the directory:

```
~/.ethos/
├── config.yaml       ← provider, model, api key, personality
├── MEMORY.md         ← rolling context (what's been happening)
├── USER.md           ← who you are (role, preferences, expertise)
├── sessions.db       ← SQLite session history (WAL + FTS5)
└── personalities/    ← drop custom personalities here
```

### Chat

```bash
make dev        # start interactive chat

# Inside the chat:
/personality list       # list available personalities
/personality engineer   # switch to engineer
/memory                 # show current memory
/usage                  # token and cost stats
/new                    # start a fresh session
/help                   # all commands
```

Sessions persist across restarts. The session key is scoped to your working directory, so different projects get separate conversation histories.

---

## Configuration

`~/.ethos/config.yaml`:

```yaml
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-...
personality: researcher
```

Supported providers: `anthropic`, `openai-compat` (OpenRouter, Ollama, Gemini, any OpenAI-compatible endpoint).

---

## Built-in personalities

Five personalities ship out of the box. Each has an `ETHOS.md` identity, a curated toolset, and a memory scope.

| Personality | Identity | Toolset | Memory |
|---|---|---|---|
| `researcher` | Methodical, citation-focused, uncertainty-aware | web search + file read + memory | global |
| `engineer` | Terse, code-first, direct | terminal + file + web + code execution | global |
| `reviewer` | Critical, structured, evidence-based | file read only | per-personality |
| `coach` | Warm, questioning, growth-focused | web + memory | global |
| `operator` | Cautious, confirms before acting, dry-run first | terminal + file + code (no web) | per-personality |

Switch with `/personality <id>` in chat or `ethos personality set <id>` from the shell.

Add your own by dropping a directory into `~/.ethos/personalities/<id>/`:

```
~/.ethos/personalities/strategist/
├── ETHOS.md        ← who the agent is
├── config.yaml     ← name, model, memoryScope
└── toolset.yaml    ← list of allowed tools
```

---

## Monorepo structure

```
ethos/
├── packages/
│   ├── types/              # @ethosagent/types    — zero-dep interface contracts
│   └── core/               # @ethosagent/core     — AgentLoop + registries
│
├── extensions/
│   ├── llm-anthropic/      # @ethosagent/llm-anthropic
│   ├── llm-openai-compat/  # @ethosagent/llm-openai-compat
│   ├── session-sqlite/     # @ethosagent/session-sqlite
│   ├── memory-markdown/    # @ethosagent/memory-markdown
│   └── personalities/      # @ethosagent/personalities  (+ 5 built-in personality bundles)
│
├── apps/
│   └── ethos/              # @ethosagent/cli  — the ethos command
│
└── plan/                   # Architecture notes and 20-phase roadmap
```

**Tooling:** pnpm workspaces · TypeScript 6 · tsx (dev) · tsup (prod) · vitest · Biome · Node 24

---

## Architecture

The core abstraction is **`AgentLoop`** — a 13-step `AsyncGenerator<AgentEvent>` that takes a user message and streams typed events back. Every component is an interface defined in `@ethosagent/types` and injected at construction time.

```
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

Extension points: `LLMProvider`, `SessionStore`, `MemoryProvider`, `ToolRegistry`, `HookRegistry`, `PlatformAdapter`, `ContextInjector`, `PersonalityRegistry`.

---

## Development

| Command | Description |
|---|---|
| `make setup` | Install nvm, Node 24, pnpm, and gstack |
| `make prepare` | Install all workspace dependencies |
| `make dev` | Start ethos in interactive chat mode |
| `make test` | Run the test suite |
| `make typecheck` | Type-check the full workspace |
| `make lint` | Run Biome linter |
| `make format` | Auto-format with Biome |
| `make check` | typecheck + lint + test (full CI pass) |
| `make clean` | Remove `node_modules` and `dist` output |

---

## License

MIT
