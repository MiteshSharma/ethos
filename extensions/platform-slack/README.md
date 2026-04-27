# @ethosagent/platform-slack

Slack `PlatformAdapter` — runs in Socket Mode so Ethos can serve Slack workspaces with no public URL.

## Why this exists

Slack's standard event delivery requires a public webhook, which is awkward for self-hosted agents. Socket Mode reverses the connection — the bot dials out to Slack — so Ethos can run on a laptop or behind NAT. This package wraps `@slack/bolt` in the `PlatformAdapter` contract so the same `AgentLoop` feeds DMs, channel mentions, and threaded conversations.

## What it provides

- `SlackAdapter` — implements `PlatformAdapter` from `@ethosagent/types`.
- `SlackAdapterConfig` — `{ botToken, appToken, signingSecret }`.
- `chunkText(text, maxLength)` — newline-preferring splitter, default 3000 chars.

## How it works

Connection is `@slack/bolt`'s Socket Mode WebSocket (`src/index.ts:64`) — no inbound HTTP, no public URL. `App.start()` opens the socket; `App.stop()` closes it.

Two event handlers feed the inbound stream. `app.message` catches DMs and standard messages, filtering out subtypes like edits and bot messages (`src/index.ts:75-98`). `app.event('app_mention')` catches channel mentions and strips the `<@USERID>` token from the text (`src/index.ts:101-117`). Both paths set `chatId` to the Slack channel id and `messageId`/`replyToId` to the message `ts`. Gateway derives the session lane as `slack:<channel>`, so each channel — and each DM — has its own history. Threads currently roll into the parent channel's lane; the adapter does not key per-`thread_ts`.

Outbound text is split into 3000-char chunks and posted via `chat.postMessage` with `mrkdwn: true` (`src/index.ts:134-148`). If `replyToId` is set, every chunk goes into that thread. `editMessage` calls `chat.update` against a single `ts`. `health()` calls `auth.test` and reports round-trip latency.

## Configuration

Constructor config:

| Field | Required | Source |
|---|---|---|
| `botToken` | yes | `xoxb-...` from OAuth & Permissions. |
| `appToken` | yes | `xapp-...` app-level token with `connections:write`. |
| `signingSecret` | yes | Basic Information → App Credentials. |

Required scopes for typical use: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `channels:history` (for messages the bot is in). Socket Mode must be enabled in app settings.

## Gotchas

- `send()` returns the **first** chunk's `ts` (the primary anchor). A bounded chunk-id ledger (`chunkMap`, 1024 entries with FIFO eviction) lets `editMessage()` re-flow the new text — editing existing chunks in place, posting extras, or calling `chat.delete` on trailing chunks the new text no longer needs.
- `canSendTyping` is `false` — Slack has no persistent typing indicator equivalent. The Gateway's typing-renew interval is a no-op for this adapter.
- Channel-message handler relies on `'channel_type' in msg` to detect DMs (`channel_type === 'im'`); subtype filter drops everything but plain user posts, so threaded replies authored by other bots are ignored.
- Threads share the parent channel's session — there is no per-thread isolation today.
- `message.replyToId` is interpreted as a `thread_ts`, so any agent reply to a threaded inbound stays in the thread.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `SlackAdapter`, `chunkText`, config types. |
| `src/__tests__/` | Unit tests. |
| `package.json` | Workspace package, depends on `@slack/bolt` ^3.21. |
