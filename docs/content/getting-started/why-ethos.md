---
title: Why Ethos?
description: How Ethos compares to LangChain, CrewAI, and AutoGen — personality as architecture, TypeScript-first, and full component swap-ability.
sidebar_position: 3
---

# Why Ethos?

Ethos makes different tradeoffs than other agent frameworks. Here's an honest comparison.

## Feature comparison

| Feature | Ethos | LangChain | CrewAI | AutoGen |
|---|:---:|:---:|:---:|:---:|
| Personality as structure (not a prompt string) | ✅ | ❌ | ❌ | ❌ |
| Swap LLM provider without code changes | ✅ | ~ | ~ | ~ |
| TypeScript-first interface contracts | ✅ | ❌ | ❌ | ❌ |
| Multi-platform shared sessions | ✅ | ❌ | ❌ | ❌ |
| Memory scope per personality | ✅ | ❌ | ❌ | ❌ |
| Tool access per personality | ✅ | ~ | ~ | ❌ |
| Zero-dependency interface package | ✅ | ❌ | ❌ | ❌ |
| Session persistence across restarts | ✅ | ~ | ~ | ~ |

✅ = full support · ~ = partial · ❌ = not supported

## The key differences

### 1. Personality is a structural component

In LangChain, CrewAI, and AutoGen, "personality" means setting a system prompt string. Changing it changes how the model responds — but nothing else in the system changes.

In Ethos, a personality is a directory of files. Swapping it changes:
- The system prompt (via `ETHOS.md`)
- The tool access (via `toolset.yaml`)
- The memory scope (via `memoryScope` in `config.yaml`)
- The model being used (via `model` in `config.yaml`)

All four change atomically. You can't accidentally run the engineer personality's tools with the reviewer's restricted toolset.

### 2. TypeScript-first, interface-driven

Every extension point in Ethos is a typed interface in `@ethosagent/types`:

```typescript
interface LLMProvider {
  complete(messages: Message[], options: CompletionOptions): AsyncIterable<CompletionChunk>
}

interface SessionStore {
  getMessages(sessionId: string, options?: { limit?: number }): Promise<Message[]>
  addMessage(sessionId: string, message: Message): Promise<void>
}
```

These interfaces have **zero dependencies**. Any package can implement them. Core never imports concrete implementations.

Python frameworks pass dicts and strings. TypeScript catches mistakes at compile time, not at runtime when the agent is mid-task.

### 3. Swap everything

| Component | Interface | Default | Alternatives |
|---|---|---|---|
| LLM | `LLMProvider` | Anthropic, OpenAI-compat | Any HTTP-based LLM |
| Sessions | `SessionStore` | SQLite (WAL+FTS5) | Redis, Postgres, in-memory |
| Memory | `MemoryProvider` | Markdown files | Any storage |
| Platform | `PlatformAdapter` | CLI | Telegram, Discord, Slack |
| Personalities | `PersonalityRegistry` | File system | Remote registry |

LangChain has swap-ability in theory; in practice, changing the underlying LLM requires touching provider-specific abstractions throughout. In Ethos, `LLMProvider` is one interface with one method.

### 4. Multi-platform, shared sessions

The same agent — same personality, same memory, same session history — runs across CLI, Telegram, Discord, and Slack. A user can start a conversation on Telegram and continue it on CLI. The session key determines continuity, not the platform.

Other frameworks are designed for single-platform deployment. Adding a second platform typically requires duplicating configuration and state management.

## When Ethos isn't the right choice

**Use LangChain if:** You're building complex multi-step pipelines with many chained operations, or you need the large ecosystem of pre-built integrations.

**Use CrewAI if:** You're building multi-agent systems where several agents collaborate on a task.

**Use AutoGen if:** You need sophisticated multi-agent conversation patterns or code execution sandboxes.

**Use Ethos if:** You're building an interactive agent that a real user talks to, you care about TypeScript correctness, you want to run on multiple platforms, or personality and memory isolation matter to your use case.
