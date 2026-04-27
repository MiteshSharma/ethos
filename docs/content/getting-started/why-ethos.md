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

---

## Design decisions

These are deliberate choices, not missing features. Each one trades a capability for a smaller surface area.

### API keys, not OAuth

Ethos stores LLM provider credentials as plain API keys in `~/.ethos/config.yaml`. There is no OAuth flow, no token-refresh thread, no per-provider login dance.

**Why:** OAuth complexity scales with provider count. Every provider has its own refresh-token semantics, scope vocabulary, and expiry behavior. Each addition is a new failure mode in the agent loop, plus a permanent maintenance load. Competing frameworks that picked OAuth ship credential-refresh bugs as a steady-state cost — tokens go stale mid-turn, plaintext credentials get embedded in config, scope mismatches surface as opaque 401s halfway through a tool call.

**The trade-off you accept:** keys live on disk in your home directory. If your machine is compromised, the keys are too. We think that's the correct trade for a tool that's already trusted with your shell, your git credentials, and your editor. If your threat model says otherwise, set keys via environment variables and don't write them to the config file.

**When this changes:** if a partner integration requires OAuth (e.g. a managed cloud version of Ethos), it gets added inside that integration — never as a default credential mode for the CLI.

### Markdown memory files, not embeddings

`~/.ethos/MEMORY.md` and `~/.ethos/USER.md` are plain text. Edit them in your editor. Grep them. Diff them. Commit them if you like.

**Why:** memory you can't read is memory you can't trust. Embedding-based retrieval has its place, but as the default mechanism it adds an embedding model, a vector store, a similarity threshold, and a debugging surface — for the privilege of giving the agent context the user can't audit. We picked legibility.

**When this changes:** if a personality genuinely needs semantic recall over a large corpus, that's what `MemoryProvider` is for — implement a vector-backed provider for that personality. The default stays markdown.
