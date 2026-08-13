---
title: "Discord adapter"
description: "Operate Ethos on Discord: bot token, intents, guild and DM routing, mention-only mode, allowlist, rate limits, multi-server, error catalog."
kind: how-to
audience: shared
slug: platform-discord
time: "15 min"
updated: 2026-06-09
---

## Task

Run the Ethos [gateway](../getting-started/glossary.md#gateway) against a Discord bot in a way that survives real traffic: connect with the right intents, route guild channels and DMs to per-channel [sessions](../getting-started/glossary.md#session), default to mention-only mode, restrict who can talk to the bot, stay under Discord's rate limit, and recognise the failure modes when they arrive.

## Result

- A Discord bot uses `Guilds`, `GuildMessages`, `MessageContent`, and `DirectMessages` intents and replies only to `@mentions` and DMs by default.
- Channels and DMs each get their own session keyed `discord:<channel-id>` / `discord:<user-id>`. Thread routing collapses to the parent channel today — see [What's shipped vs in flight](#whats-shipped-vs-in-flight).
- Allowlisted senders reach the agent; the gateway emits audit events when others are blocked or context-stripped.
- Outbound text is split into 2,000-character chunks, deduped over a 30-second window, and edited in place when the agent streams.
- A second guild's bot runs from a sibling `~/.ethos/` without interfering with the first.

## What's shipped vs in flight

The Discord adapter lags Slack and Telegram on several gateway-contract features. The matrix below is the operational truth; the full parity roadmap lives at [`plan/completed/discord-parity.md`](https://github.com/ethosagent/ethos/blob/main/plan/completed/discord-parity.md).

**Shipped today**

- Token validation via `users/@me` (`extensions/platform-discord/src/validate.ts`).
- `Guilds` / `GuildMessages` / `MessageContent` / `DirectMessages` intent setup.
- Mention gate in guild channels (`mentionOnly: true` is the constructor default; pass `mentionOnly: false` to opt every message in — rarely what you want).
- DM routing.
- Outbound chunking to Discord's 2,000-char cap with edit-in-place streaming.
- Clarify questions surface as buttons + modals, with the handler split across two modules — `extensions/platform-discord/src/clarify-blocks.ts` (component builders) and `extensions/platform-discord/src/clarify-interactions.ts` (button + modal callback handlers).
- Outbound dedup via the shared `MessageDedupCache` (30s TTL).
- Plugin commands registered via `registerSlashCommand()` are registered as Discord application commands at startup. They appear in the Discord command picker alongside built-in commands.

**Tracked on the parity plan, not yet shipped**

| Feature | What Slack and Telegram have | What Discord does today |
|---|---|---|
| `botKey` on `InboundMessage` | Stamped by the adapter; gateway routes by `${platform}:${botKey}:${chatId}`. | Not populated. Multi-bot Discord deployments collapse to one lane. See [Run multiple bots](../using/how-to/run-multiple-bots.md). |
| Thread routing | Slack uses `thread_ts`; Telegram uses forum topics. Each gets a distinct `threadId`. | Discord threads are flattened into the parent channel; replies land in the parent, not the thread. |
| Inbound files / images | Slack and Telegram cache attachments and surface them as `InboundAttachment[]`. | Not implemented — vision and code-review personalities can't receive Discord attachments. |
| Receipt reaction | Slack sets 👀 on inbound and clears it on first response; Telegram does the same with 👀. | Not implemented — users have no visual ack until the first streamed chunk lands. |
| Channel modes | Slack supports `mention_only` / `thread_follow` / `all` per channel with persisted overrides. | Single static `mentionOnly` flag at adapter-construction time. |
| Persistent store | Slack persists thread participation and per-channel mode overrides under `~/.ethos/slack/<botKey>/`. | No persistence — gateway restart loses every thread-follow decision. |
| Approval surface | Slack renders the `before_ticket_complete` hook as an approval card. | Not implemented — Discord users can't participate in `kanban_complete` approvals. |

The parity plan is shipping in nine independent moves; expect this matrix to shrink rather than grow. If you are operating a Discord-only deployment and one of the gaps blocks you, that's the gap to file against next.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- A Discord application and bot token from `https://discord.com/developers/applications`.
- The **Message Content Intent** enabled in the Developer Portal under **Bot → Privileged Gateway Intents** (required for the adapter to see message text).
- The bot invited to the target guild with `bot` and `applications.commands` scopes and at minimum `Send Messages`, `Read Message History`, `View Channels` permissions.

## Source

- `extensions/platform-discord/src/index.ts` — `DiscordAdapter` (`discord.js` v14 gateway client, intents, mention gate, chunking, edit-in-place).
- `extensions/platform-discord/src/validate.ts` — `users/@me`-based token validation called by setup.
- `extensions/gateway/src/index.ts` — routing, slash commands, dedup, allowlist enforcement.
- `packages/safety/channel/src/channel-filter.ts` — sender allowlist, mention gate, DM policy.
- `apps/ethos/src/commands/gateway.ts` — adapter wiring (`new DiscordAdapter({ token: config.discordToken })`).

## Steps

### 1. Wire the token

```yaml
# ~/.ethos/config.yaml
discordToken: "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.Yy....your-bot-token-here"
```

`ethos gateway setup` validates the token by calling `https://discord.com/api/users/@me` with `Authorization: Bot <token>` and writes the value for you.

### 2. Start the gateway

```bash
ethos gateway start
```

Expected boot lines include `✓ Discord online`. For production with the web dashboard alongside, use `ethos run-all` under PM2 — see [Deploy in production](../using/how-to/deploy-in-production.md). For just the Discord gateway by itself under `launchd` / `systemd` / `pm2`, see [Run Ethos as a daemon](../using/how-to/run-as-daemon.md).

### 3. Confirm intents

`DiscordAdapter` constructs the client with these intents (see `extensions/platform-discord/src/index.ts`):

| Intent | Why |
|---|---|
| `Guilds` | Receive guild metadata so channel ids resolve. |
| `GuildMessages` | Receive `MessageCreate` events in server channels. |
| `MessageContent` | Read the actual text of messages. **Privileged** — must be enabled in the Developer Portal. |
| `DirectMessages` | Receive DMs sent to the bot. |

`Partials.Channel` and `Partials.Message` are also requested so DMs work without a cache prefetch.

If `✓ Discord online` prints but the bot ignores every mention, **Message Content Intent is off in the Developer Portal**. Toggle it on, restart the gateway.

### 4. Understand routing

`messageHandler` produces an `InboundMessage` per `MessageCreate`. The gateway keys per `(platform, chatId)`:

| Source | `chatId` | `isDm` | `isGroupMention` | Effective session key |
|---|---|---|---|---|
| Server channel, bot is `@mentioned` | channel id | `false` | `true` | `discord:<channel-id>` |
| Server thread, bot is `@mentioned` | parent channel id | `false` | `true` | `discord:<channel-id>` (collapses with the parent channel — `threadId` routing is on the [parity plan](#whats-shipped-vs-in-flight)) |
| Server channel, no mention | channel id | `false` | `false` | dropped when `mentionOnly: true` (the default) |
| DM | DM channel id | `true` | `false` | `discord:<channel-id>` |

The adapter strips the `<@botId>` prefix before passing text to the agent, so `@Ethos summarise the channel` arrives as `summarise the channel`.

The `mentionOnly` flag is set at adapter-construction time in `apps/ethos/src/commands/gateway.ts` and defaults to `true`. To respond to every message a server channel produces, construct the adapter with `mentionOnly: false`. This is rarely what you want — Discord rate limits scale per channel, and Ethos has no per-[personality](../getting-started/glossary.md#personality) cost cap that limits guild-wide replies. There is no per-channel override today; that's the `channel modes` row on the [parity matrix](#whats-shipped-vs-in-flight).

### 5. Restrict who can talk to the bot

Configure under `channelFilter.discord` (`packages/safety/channel/src/channel-filter.ts`):

```yaml
channelFilter:
  discord:
    ownerUserId: "234567890123456789"     # Discord snowflake — always allowed
    recipientAllowlist:
      - "345678901234567890"              # extra user snowflakes
      - "456789012345678901"              # or whole channel snowflakes
    dmPolicy: pairing                     # pairing | allowlist | queue | reject | silent-drop
    contextVisibility: allowlist          # strip quoted text from non-allowlisted senders
```

Field meanings:

- `ownerUserId` — bypasses every gate, including the mention gate inside guilds.
- `recipientAllowlist` — user and channel snowflakes that are also allowed.
- `dmPolicy` — what happens when a non-allowlisted user DMs the bot. `pairing` (default) replies with a one-time code; `allowlist` silently drops; the rest match the [Telegram adapter](telegram.md).
- `contextVisibility: allowlist` — strips replied-to content from non-allowlisted senders before the agent sees it.

From inside `ethos chat`:

```
/communications
/allow 7H3K-9XQ2
/deny discord 234567890123456789
```

### 6. Required bot permissions

Invite the bot with these permissions (combined as the integer in the OAuth URL builder):

| Permission | Why |
|---|---|
| `View Channels` | Required to receive any event in a channel. |
| `Send Messages` | Required for replies. |
| `Send Messages in Threads` | Replies in threads when the source message was in a thread. |
| `Read Message History` | Lets the bot inspect the message it is replying to. |
| `Embed Links` | Discord auto-embeds links the agent emits. |
| `Add Reactions` | Currently unused but reserved by `canReact = true` on the adapter. |
| `Use Application Commands` | Required for plugin slash commands registered as Discord application commands. |

Skip `Administrator`. The gateway has no need for moderation or member-management permissions; granting them widens the blast radius for nothing.

### 7. Drive multi-server deployments

Discord allows one gateway connection per bot token. To run several bots from one host:

- **One bot across many guilds (`Guilds` intent supports any number) with one gateway.** This is the path Discord supports natively. The same `MessageDedupCache` (30s TTL, keyed by `(sessionId, sha256(content))`) covers every guild and DM the bot serves.

- **Two or more Discord bots — run them under separate `~/.ethos/` roots, not in one process.**

```bash
HOME=/srv/ethos-guild-a ethos gateway start &
HOME=/srv/ethos-guild-b ethos gateway start &
```

Each `HOME` gets its own `config.yaml`, SQLite store, logs, and pairing database. The bots stay isolated; sessions never cross.

The multi-bot-in-one-process pattern that [Telegram and Slack support](../using/how-to/run-multiple-bots.md) does not work for Discord yet — the adapter doesn't stamp `botKey` on inbound messages (see the [parity matrix](#whats-shipped-vs-in-flight)). Two Discord bots in one Ethos process today collapse onto a single lane key and route to whichever loop was constructed first. Until that ships, separate `HOME` roots are the only safe way to run multiple Discord bots from one host.

## Verify

**Token works.**

```bash
curl -s -H "Authorization: Bot $DISCORD_TOKEN" https://discord.com/api/users/@me | jq .username
```

Returns the bot's username. `401` means the token is revoked or wrong; regenerate it in the Developer Portal.

**Gateway sees Discord.**

Foreground-start the gateway and confirm `✓ Discord online`. The adapter's `health()` reports `ok: true` only after `client.ws.status === 0` (i.e. `Ready`).

**Mention round-trips in a guild.**

Post `@Ethos ping` in a channel the bot can see. Reply arrives in the same channel. A non-mentioned `ping` produces no reply when `mentionOnly: true`.

**DM round-trips.**

DM the bot `ping`. Reply arrives within a few seconds — provided the DM passes the allowlist or pairing flow.

**Allowlist enforcement.**

Have a non-allowlisted account `@mention` the bot in a guild. With the default config, the message is silently dropped and `ethos audit | tail` shows `channel.allowlist.blocked` or `channel.mention_gate`.

**Dedup is active.**

Send the same prompt twice within 30 seconds. The bot answers once if generated text is identical.

## Troubleshoot

**`✓ Discord online` prints but the bot ignores every message.**
**Message Content Intent** is off in the Developer Portal. Open the application, **Bot** → **Privileged Gateway Intents**, enable it, restart the gateway.

**Bot is online but never sees messages in one channel.**
Channel permissions override role permissions. Check **Edit Channel** → **Permissions** → the bot's role has `View Channel` and `Read Message History`. The `Guilds` intent is global; per-channel ACLs are not.

**Bot replies appear out of order or are dropped.**
A long agent turn is being interrupted by a fresh message in the same channel. `SessionLane` serialises turns per `(platform, chatId)`; the second message queues behind the first. The user sees the second reply land only after the first finishes. Tell users to wait or run `/stop` to abort the current turn.

**HTTP 429 / Discord rate-limit warnings.**
`discord.js` handles per-route rate limits internally. Sustained 429s mean a personality is auto-replying or the same bot is responding from two processes. Check `ethos errors` and the running gateway count.

**Replies arrive split into multiple messages.**
Expected. Discord caps outbound text at 2,000 characters; `chunkText` splits at newlines (>60% of the limit). Streamed edits re-flow with `reflowChunks` — first chunks are edited, extras are appended, trailing chunks are deleted.

**Bot was kicked from the server, gateway keeps logging fetch failures.**
`channels.fetch(chatId)` will start returning 404. The adapter logs the delivery failure and the lane stays alive for other chats. Re-invite or wait. If the chat id is the wrong type altogether (e.g. a category), `'send' in channel` is false and the adapter returns `Channel not found or not sendable`.

**A message sent twice on purpose was answered only once.**
The outbound `MessageDedupCache` suppresses identical `(sessionId, content)` within 30 seconds. Change one character, wait 30 seconds, or set `ETHOS_DEDUP_LEGACY=1` to disable.

**Pairing code expired.**
Codes have a TTL in `packages/safety/channel/src/pairing-store.ts`. If the DM author waited too long, they need to DM again — a new code is issued. Owners can `/communications approve-all` to approve every pending sender.

**Bot does not appear in `member.roles` or replies to a role mention.**
Role mentions are not the same as user mentions; the adapter only checks `message.mentions.has(client.user)`. Mention the bot directly (`@Ethos`) rather than a role the bot has.

## Errors you may see

| Code | Surface | Cause | Fix |
|---|---|---|---|
| `channel.allowlist.blocked` | gateway audit | Non-allowlisted sender in a guild, or DM under `dmPolicy: silent-drop`. | Add the snowflake to `recipientAllowlist` or trigger `/allow <code>`. |
| `channel.mention_gate` | gateway audit | Allowlisted sender posted in a guild without `@mentioning` the bot. | Mention the bot or reply to one of its messages. |
| `channel.pairing.sent` | gateway audit | First DM from a non-allowlisted user; pairing code emitted. | Owner runs `/allow <code>` to approve. |
| `channel.context_stripped` | gateway audit | Quoted content from a non-allowlisted user was removed before the turn. | Expected when `contextVisibility: allowlist`. |
| `channel.prior_context_stripped` | gateway audit | Channel-backfill lines from non-allowlisted authors were removed; `details.dropped` is `true` when nothing survived. | Expected when `contextVisibility: allowlist`. Add the author's snowflake to `recipientAllowlist` to keep their lines. |
| `Channel not found or not sendable` | delivery result | Bot was kicked, channel deleted, or `chatId` is not a text channel. | Re-invite or update routing. |

## See also

- [Telegram adapter](telegram.md) — same gateway surface, different ingress.
- [Slack adapter](slack.md) — socket mode, bot scopes, signing secret.
- [Run multiple bots from one Ethos process](../using/how-to/run-multiple-bots.md) — multi-bot wiring on Telegram and Slack; Discord caveats called out.
- [Run Ethos as a daemon](../using/how-to/run-as-daemon.md) — `launchd`, `systemd`, `pm2`.
- [Glossary](../getting-started/glossary.md) — [`gateway`](../getting-started/glossary.md#gateway), [`session`](../getting-started/glossary.md#session), [`audience boundary`](../getting-started/glossary.md#audience-boundary).
