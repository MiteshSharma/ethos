---
title: Project Structure
description: Ethos monorepo layout — packages, extensions, apps, and how they relate to each other.
sidebar_position: 4
---

# Project Structure

Ethos is a pnpm monorepo. Here's what lives where and why.

## Directory layout

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
│   └── personalities/      # @ethosagent/personalities (+ 5 built-in bundles)
│
├── apps/
│   └── ethos/              # @ethosagent/cli  — the ethos command
│
└── docs/                   # this documentation site
```

## Package roles

### `@ethosagent/types`

Zero dependencies. Contains every interface in the system: `LLMProvider`, `Tool`, `SessionStore`, `MemoryProvider`, `PersonalityRegistry`, `HookRegistry`, `PlatformAdapter`, `ContextInjector`, `Plugin`.

Every other package depends on `@ethosagent/types`. No package depends on another package's concrete implementations — only on interfaces from types.

### `@ethosagent/core`

Contains `AgentLoop`, `ToolRegistry`, `HookRegistry`, `PluginRegistry`, and in-memory default implementations. Depends only on `@ethosagent/types`.

### Extensions

Concrete implementations of the interfaces. Each extension is an independent package:

| Package | Implements |
|---|---|
| `@ethosagent/llm-anthropic` | `LLMProvider` — Anthropic API with prompt caching and extended thinking |
| `@ethosagent/llm-openai-compat` | `LLMProvider` — OpenAI-compatible API (OpenRouter, Ollama, Gemini) |
| `@ethosagent/session-sqlite` | `SessionStore` — WAL-mode SQLite with FTS5 full-text search |
| `@ethosagent/memory-markdown` | `MemoryProvider` — reads `~/.ethos/MEMORY.md` and `USER.md` |
| `@ethosagent/personalities` | `PersonalityRegistry` — file-based loader with mtime hot-reload |

### `@ethosagent/cli`

The `ethos` command. Reads `~/.ethos/config.yaml`, wires all components together in `wiring.ts`, and exposes the readline REPL via `ethos chat`.

## Dependency conventions

### `workspace:*` deps

Internal packages reference each other with `workspace:*`:

```json title="extensions/llm-anthropic/package.json"
{
  "dependencies": {
    "@ethosagent/types": "workspace:*"
  }
}
```

pnpm replaces `workspace:*` with the real version number on publish.

### Path aliases

Root `tsconfig.json` maps every `@ethosagent/*` import to the package's `src/` directory:

```json title="tsconfig.json"
{
  "paths": {
    "@ethosagent/types": ["./packages/types/src"],
    "@ethosagent/core": ["./packages/core/src"],
    "@ethosagent/llm-anthropic": ["./extensions/llm-anthropic/src"]
  }
}
```

This means `import { AgentLoop } from '@ethosagent/core'` resolves directly to source — no build step needed in dev.

### Exports point to source in dev

```json title="packages/core/package.json"
{
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "production": "./dist/index.js"
    }
  }
}
```

Node 24 + tsx resolves `./src/index.ts` directly. The `production` condition is used only when building with tsup.
