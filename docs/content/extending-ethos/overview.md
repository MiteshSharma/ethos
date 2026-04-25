---
sidebar_position: 1
title: Overview
---

# Extending Ethos

Ethos is designed to be extended, not forked. Every major subsystem is typed as an interface in `@ethosagent/types` and injected at construction time — which means you can swap any component without touching the core.

## Extension points

| What you want | Interface to implement | Where it's injected |
|---|---|---|
| New LLM provider | `LLMProvider` | `AgentLoopConfig.llmProvider` |
| New tool | `Tool<TArgs>` | `ToolRegistry.register()` |
| New platform adapter | `PlatformAdapter` | gateway routing layer |
| Custom memory provider | `MemoryProvider` | `AgentLoopConfig.memoryProvider` |
| Plugin bundle | `Plugin` | `PluginRegistry.load()` |

## The rule: interfaces in `@ethosagent/types`

`@ethosagent/types` has zero runtime dependencies. Everything in it is a TypeScript interface, type alias, or const enum. No imports from `@ethosagent/core` or anywhere else.

This means any package — even a third-party npm package — can implement an Ethos interface without pulling in the whole framework. Your custom LLM provider only needs `@ethosagent/types` as a dependency.

## Injection, not inheritance

`AgentLoop` takes everything it needs as constructor arguments via `AgentLoopConfig`. It doesn't reach for globals, doesn't use singletons, and doesn't have static registries.

```typescript
const loop = new AgentLoop({
  llmProvider: myProvider,     // your LLM
  toolRegistry: myTools,       // your tools
  memoryProvider: myMemory,    // your memory
  sessionStore: myStore,       // your sessions
  personality: myPersonality,  // your identity
});
```

Swap any one component without touching the others.

## Extension packages

Official extension packages live in `extensions/`:

| Package | Provides |
|---|---|
| `@ethosagent/llm-anthropic` | Claude models via Anthropic SDK |
| `@ethosagent/llm-openai-compat` | OpenAI-compatible endpoints (OpenRouter, Ollama, Gemini) |
| `@ethosagent/session-sqlite` | Persistent sessions via SQLite (WAL + FTS5) |
| `@ethosagent/memory-markdown` | Markdown file memory (MEMORY.md + USER.md) |
| `@ethosagent/personalities` | File-based personality registry with hot-reload |

You can use any of these, replace any of them, or add your own alongside.

## Plugin system

Plugins bundle tools + hooks + personality contributions into a single npm package. A plugin declares what it provides, and `PluginRegistry` wires it into the running agent.

See the [Plugin SDK](./plugin-sdk) guide for the full API.

## What's next

- [Adding an LLM Provider](./adding-an-llm-provider)
- [Adding Tools](./adding-tools)
- [Adding a Platform Adapter](./adding-a-platform-adapter)
- [Custom Memory Providers](./custom-memory-providers)
- [Plugin SDK](./plugin-sdk)
