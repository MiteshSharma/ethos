# @ethosagent/platform-discord

Discord `PlatformAdapter` — connects an Ethos agent to Discord channels and DMs over the Gateway WebSocket.

## Why this exists

Ethos talks to many surfaces (CLI, Telegram, Slack, email, Discord) through a single `PlatformAdapter` contract. This package adapts `discord.js` v14 into that contract so the same `AgentLoop` can serve Discord users without knowing anything Discord-specific. Mention-only behavior in servers prevents the bot from responding to every message in busy channels.

## What it provides

- `DiscordAdapter` — implements `PlatformAdapter` from `@ethosagent/types`.
- `DiscordAdapterConfig` — `{ token, mentionOnly? }`.
- `chunkText(text, maxLength)` — exported helper that splits long replies on newline boundaries (preferring the last newline above 60% of the limit), exposed for tests.

## How it works

Connection model is the standard Discord Gateway WebSocket via `discord.js` `Client.login()` (`src/index.ts:111`). The adapter declares the four intents it needs — `Guilds`, `GuildMessages`, `MessageContent` (a privileged intent that must be enabled in the developer portal), and `DirectMessages` — plus `Channel` and `Message` partials so DM events fire correctly (`src/index.ts:63-71`).

The session lane is keyed by Discord channel ID (`chatId: message.channelId`, `src/index.ts:97`). Gateway then derives `discord:<channelId>` as the lane key, so every channel and every DM gets its own conversation history. The bot's own `<@id>` mention is stripped from the inbound text before it reaches the agent (`src/index.ts:91-93`). In guild channels the adapter ignores messages that don't @mention the bot unless `mentionOnly: false` is set.

Outbound text is split with `chunkText` into 2000-char chunks (Discord's per-message ceiling) and sent sequentially via `channel.send` (`src/index.ts:133-140`). Typing indicator and `editMessage` go through the same channel-fetch path. `health()` reports WebSocket status and ping.

## Configuration

Constructor config:

| Field | Required | Notes |
|---|---|---|
| `token` | yes | Bot token from the Discord developer portal. |
| `mentionOnly` | no | Defaults to `true`. When `false`, the bot replies to every message it can see in every guild channel. |

The `MessageContent` privileged intent must be enabled for the bot in the developer portal — without it, `message.content` will be empty in guild channels.

## Gotchas

- `send()` returns the **first** chunk's `messageId` (the primary anchor for the response). The adapter remembers the full chunk-id list in a bounded ledger (`chunkMap`, capped at 1024 entries with FIFO eviction), and `editMessage()` re-flows the new text across those chunks: edits in place where chunk count is unchanged, appends new messages when the new text grows, and deletes trailing chunks when it shrinks.
- The `discord.js` channel union includes types without `send`/`messages`/`sendTyping` (e.g. `PartialGroupDM`); the adapter narrows with `'send' in channel` checks and casts to `any` for the actual call (`src/index.ts:138`).
- `MessageContent` is privileged — bots over the verification threshold need approval to keep it.
- Guild messages without an @mention are silently dropped when `mentionOnly` is true; the inbound never reaches Gateway.
- `messageId` and `replyToId` are both set to the inbound message id, so Gateway's dedup window can drop duplicate Gateway reconnects.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `DiscordAdapter`, `chunkText`, config types. |
| `src/__tests__/` | Unit tests for chunking and inbound mapping. |
| `package.json` | Workspace package, depends on `discord.js` ^14.16. |
