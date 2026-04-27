# @ethosagent/platform-telegram

Telegram `PlatformAdapter` — long-polls the Bot API via `grammy` and adapts updates into Ethos `InboundMessage`s.

## Why this exists

Telegram is the cheapest path from "agent works on my laptop" to "agent works on my phone." Long-polling needs no public URL and survives NAT and restarts. This package wraps `grammy` in the `PlatformAdapter` contract so the same `AgentLoop` can serve private chats, group mentions, and captioned media equally.

## What it provides

- `TelegramAdapter` — implements `PlatformAdapter` from `@ethosagent/types`.
- `TelegramAdapterConfig` — `{ token, dropPendingUpdates? }`.
- `chunkText(text, maxLength)` — splitter that prefers newline boundaries, then falls back to spaces, both above 60% of the limit. Default 4096 chars.

## How it works

Connection is grammy's long-polling loop launched non-blocking with `void this.bot.start({ drop_pending_updates })` (`src/index.ts:97`). On `start()`, the adapter registers a `'message'` listener that maps grammy's `Context` into an `InboundMessage`, setting `text` to either `ctx.message.text` or `ctx.message.caption` so photo/document captions also reach the agent (`src/index.ts:78`).

`chatId` is the Telegram chat id stringified (`src/index.ts:83`). Gateway derives `telegram:<chatId>` as the session lane, so each private chat and each group has its own conversation history. `isGroupMention` is set when the message text contains `@<bot username>`; the adapter does not strip the mention from the text. `messageId` is set so Gateway can dedup retries from polling reconnects.

Outbound text is split into 4096-char chunks (Telegram's hard limit) and sent in order via `bot.api.sendMessage` with `parse_mode: 'Markdown'` (or `'HTML'`) (`src/index.ts:118-123`). If a Markdown chunk fails parsing, the adapter retries that single chunk **as plain text** silently (`src/index.ts:127-129`); other errors are returned. `sendTyping` posts a `'typing'` chat action (the Gateway re-fires this on a 4-second interval since Telegram only shows it for ~5 seconds).

## Configuration

Constructor config:

| Field | Required | Notes |
|---|---|---|
| `token` | yes | Bot token from `@BotFather`. |
| `dropPendingUpdates` | no | Default `true`. When `false`, the bot processes the full backlog accumulated while it was offline. |

For the bot to receive group messages without `@mention`, disable group privacy mode in BotFather. Otherwise it only sees mentions, replies to its own messages, and commands.

## Gotchas

- Markdown parse errors silently fall back to plain text — formatting just disappears for that chunk. There is no error returned to the caller, no log, no telemetry. If you see Telegram messages mysteriously rendering as plain text, this is why.
- `send()` returns the **first** chunk's `message_id` (the primary anchor). A bounded chunk-id ledger (`chunkMap`, 1024 entries with FIFO eviction) lets `editMessage()` re-flow the new text via `editMessageText` / `sendMessage` / `deleteMessage`.
- `bot.start()` is fire-and-forget (`void`-ed) so the long-poll loop runs concurrently with the rest of `start()`. If the token is invalid, the failure surfaces inside the loop, not as a rejected promise from `start()`.
- The `@mention` token is **not** stripped from inbound text — the agent sees the raw `@bot Hello`.
- `chatId` and `messageId` are stringified `number`s; `send`/`editMessage` parse them back with `Number()`. Telegram chat ids fit safely in JS `number`.
- `canReact` is `false` and `canSendFiles` is `false` — neither is implemented yet.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `TelegramAdapter`, `chunkText`, config types. |
| `src/__tests__/` | Unit tests for chunking and inbound mapping. |
| `package.json` | Workspace package, depends on `grammy` ^1.26. |
