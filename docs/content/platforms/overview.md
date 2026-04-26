---
sidebar_position: 1
title: Overview
---

# Platforms

Ethos ships with platform adapters that connect your agent to messaging and communication services. Each adapter translates platform-specific events into the `IncomingMessage` format the `AgentLoop` understands, and routes `AgentEvent` output back to the platform.

## Available adapters

| Adapter | Status | Use case |
|---|---|---|
| [CLI](./cli) | Stable | Interactive terminal chat, development, scripting |
| [Telegram](./telegram) | Stable | Personal bot, team assistant, private group |
| [Discord](./discord) | Stable | Server bot, moderation assistant, community Q&A |
| [Slack](./slack) | Stable | Workspace assistant, workflow automation |

## How adapters work

All adapters implement `PlatformAdapter`:

```typescript
interface PlatformAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): () => void;
}
```

The gateway layer:
1. Receives an `IncomingMessage` from the adapter
2. Routes it to an `AgentLoop` (creating a session if needed)
3. Streams `AgentEvent` output back through the adapter's `send()`

## Sessions per platform

Each platform gets session isolation by default. The session key convention is:

| Platform | Session key |
|---|---|
| CLI | `cli:<cwd-basename>` |
| Telegram | `telegram:<chat-id>` |
| Discord | `discord:<channel-id>` |
| Slack | `slack:<channel-id>` |

Users on the same Telegram chat share a session; users on different chats don't.

## Selecting an adapter

Set in `~/.ethos/config.yaml`:

```yaml
adapters:
  - telegram

# Or run multiple simultaneously
adapters:
  - telegram
  - discord
```

Or pass at runtime:

```bash
ethos --adapter telegram
ethos --adapter discord
```

## Multi-adapter deployment

You can run multiple adapters from a single Ethos instance. The gateway routes each incoming message to the correct `AgentLoop` based on the platform and session.

This is useful for a "universal assistant" that's available on both Telegram and Discord simultaneously, with separate session histories per platform.

## Building a custom adapter

See [Adding a Platform Adapter](../extending-ethos/adding-a-platform-adapter) for the full implementation guide.
