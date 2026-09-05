---
title: "Slack adapter"
description: "Operate Ethos on Slack: socket-mode app, bot and app tokens, signing secret, scopes, channel and DM routing, rate limits, multi-workspace, errors."
kind: how-to
audience: shared
slug: platform-slack
time: "15 min"
updated: 2026-09-05
---

## Task

Run the Ethos [gateway](../getting-started/glossary.md#gateway) against a Slack workspace in a way that survives real traffic: install a socket-mode app with the right scopes, route `app_mention` and DMs to per-channel [sessions](../getting-started/glossary.md#session), restrict who can talk to the bot, stay under Slack's send rate, run a second workspace's app from the same host, and recognise the failure modes when they arrive.

## Result

- A Slack app runs in **Socket Mode** — no public URL, no TLS, no event-subscription endpoint.
- The bot replies to `@mentions` in channels and to DMs; it never reaches for messages it was not addressed in.
- Channels, threads, and DMs each get their own session keyed `slack:<channel-id>` / `slack:<thread-ts>` / `slack:<channel-id>` (DMs are channels of type `im`).
- Outbound text is split into 3,000-character chunks, deduped over a 30-second window, and edited in place when the agent streams.
- A second workspace's app runs from a sibling `~/.ethos/` without interfering with the first.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- A Slack app created at `https://api.slack.com/apps` → **Create New App** → **From scratch**.
- The app installed to the target workspace; the bot user added to at least one channel.
- The bot's **Event Subscriptions** matched to the channel modes you intend to use — Slack sends an app only the events it subscribed to, and a missing subscription is silent. See [Platform prerequisites for unaddressed channel messages](#1a-platform-prerequisites-for-unaddressed-channel-messages).
- Three secrets in hand: bot token (`xoxb-…`), app-level token (`xapp-…`) with `connections:write`, and the signing secret.

## Source

- `extensions/platform-slack/src/index.ts` — `SlackAdapter` (Bolt SDK in `socketMode: true`, chunking, edit-in-place).
- `extensions/platform-slack/src/validate.ts` — `auth.test`-based bot-token validation called by setup.
- `extensions/gateway/src/index.ts` — routing, slash commands, dedup, allowlist enforcement.
- `packages/safety/channel/src/channel-filter.ts` — sender allowlist, mention gate, DM policy.
- `apps/ethos/src/commands/gateway.ts` — adapter wiring (`new SlackAdapter({ botToken, appToken, signingSecret })`).

## Steps

### 1. Create the Slack app

In `https://api.slack.com/apps`:

1. **Create New App** → **From scratch**. Pick a name and the target workspace.
2. Under **OAuth & Permissions** → **Bot Token Scopes**, add:
   - `app_mentions:read` — receive mention events.
   - `channels:history` — read messages in public channels the bot is in.
   - `groups:history` — same for private channels.
   - `im:history` — read DMs to the bot.
   - `im:read` — list DM channels.
   - `im:write` — open DM channels for outbound messages.
   - `chat:write` — post messages and edit them.
   - `users:read` — resolve user ids when audit-logging.
   - `files:read` — download user-attached files from `url_private_download`. Without it, Slack returns an HTML page in place of the file bytes; see [Receive files via Slack](../using/how-to/receive-files-via-slack.md).
   - `reactions:write` — set and clear the 👀 receipt reaction on inbound messages (best-effort; missing scope just drops the reaction).
   - `files:write` — upload a long answer as `answer.md` instead of a four-message wall (best-effort; missing scope falls back to the chunked messages). Tune with `slack.apps.<i>.longReplyThresholdChars`.
3. Under **Socket Mode** → **Enable Socket Mode**.
4. Under **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**, add the `connections:write` scope. Copy the `xapp-…` token.
5. Under **Event Subscriptions** → **Enable Events**, subscribe to bot events:
   - `app_mention` — someone `@mentions` the bot.
   - `message.im` — someone DMs the bot.
   - `message.channels` — a message is posted in a public channel the bot is in. Only needed for channel modes that read messages nobody addressed to the bot; see [Platform prerequisites for unaddressed channel messages](#1a-platform-prerequisites-for-unaddressed-channel-messages).
   - `message.groups` — the same for private channels.
6. Under **Install App**, install to the workspace. Copy the **Bot User OAuth Token** (`xoxb-…`).
7. Under **Basic Information**, copy the **Signing Secret**.

### 1a. Platform prerequisites for unaddressed channel messages

Slack delivers an app only the events that app subscribed to, and delivers nothing at all to say a subscription is missing. An app subscribed to `app_mention` and `message.im` alone hears mentions and DMs perfectly and is deaf to everything else in a channel — which is exactly right until a channel is set to a mode that reads messages nobody addressed to the bot.

Two things gate that, and both are on the Slack side:

| Requirement | Where | Covers |
|---|---|---|
| `message.channels` event subscription | **Event Subscriptions** → **Subscribe to bot events** | Messages in public channels |
| `message.groups` event subscription | same | Messages in private channels |
| `channels:history` bot scope | **OAuth & Permissions** → **Bot Token Scopes** | Reading public-channel message content |
| `groups:history` bot scope | same | Reading private-channel message content |
| Bot is a member of the channel | Invite the bot in Slack | Both — the events follow membership |

The scopes are already in [step 1](#1-create-the-slack-app); the two `message.*` subscriptions are the pair most often left off, because mentions and DMs work without them.

Slack grants a `message.*` subscription only when the matching `*:history` scope is already on the app. Adding the scope is what forces a reinstall, and reinstalling issues a new bot token — update `slackBotToken` in `~/.ethos/config.yaml` afterwards.

Read a channel's current mode from inside it:

```
/ethos channel-mode
```

```
Channel mode: mention_only
#build-updates currently uses mention_only (app default).
Set with: /ethos channel-mode all, /ethos channel-mode thread_follow, /ethos channel-mode mention_only, or /ethos channel-mode observe (records every message, never replies).
```

`/ethos channel-mode <mode>` sets it, and the setting is a per-channel override on top of the app default. Set that app-wide default with [`slack.apps.<i>.defaultChannelMode`](../using/reference/config-yaml.md#slack-apps) — the same four values, `mention_only` when the key is absent, read at gateway startup. `mention_only` is the default and needs neither subscription; `thread_follow`, `all`, and `observe` all read messages the bot was not addressed in, and all need `message.channels` (public) or `message.groups` (private) for the channel in question. `observe` additionally never replies — the bot reads the channel and says nothing in it.

Silence under `observe` covers every surface, not only replies to messages:

| Surface | Under `observe` |
|---|---|
| Messages and `@mentions` | Recorded to the transcript, never answered, no receipt reaction |
| The greeting the bot posts when you invite it | Not posted |
| Unfurling an Ethos link someone pastes | Not unfurled |
| `/ethos ask` | Refused, with a reply only the person who ran it can see |

To ask this bot something while a channel is observed, DM it or change the mode.

A stored mode this build cannot read — a typo such as `obserev`, or a mode a newer Ethos wrote into the same override file — is treated exactly like `observe`: nothing reaches the room, and nothing is recorded either. If a channel has gone quiet unexpectedly, run `/ethos channel-mode`, which prints the stored string verbatim rather than the default it is not. `/ethos help`, the App Home tab, and the `/ethos ask` refusal show the same value.

Only users on the `/ethos` allowlist can run this; see [step 5a](#5a-restrict-who-can-run-ethos-and-open-app-home).

### 2. Wire the secrets

```yaml
# ~/.ethos/config.yaml
slackBotToken: "xoxb-…"
slackAppToken: "xapp-…"
slackSigningSecret: "abc123…"
```

`ethos gateway setup` validates the bot token against `https://slack.com/api/auth.test` and writes all three fields. The gateway requires all three to be set before it loads the adapter (see `apps/ethos/src/commands/gateway.ts`).

### 3. Start the gateway

```bash
ethos gateway start
```

Expected boot lines include `⚡️ Bolt app started`. Socket Mode means no reverse proxy, no domain, no inbound port. For production with the web dashboard alongside, use `ethos run-all` under PM2 — see [Deploy in production](../using/how-to/deploy-in-production.md). For just the Slack gateway by itself under `launchd` / `systemd` / `pm2`, see [Run Ethos as a daemon](../using/how-to/run-as-daemon.md).

### 4. Understand routing

`SlackAdapter.start()` subscribes to two events (`extensions/platform-slack/src/index.ts`):

- `message` — fires for every DM the bot can see. The adapter accepts messages with `channel_type === 'im'`; everything else is ignored at this layer.
- `app_mention` — fires for `@mentions` in channels. The adapter strips the `<@UXXXXXXXX>` token before forwarding.

| Source | `chatId` | `isDm` | `isGroupMention` | Effective session key |
|---|---|---|---|---|
| Channel `@mention` | channel id `C…` | `false` | `true` | `slack:<channel-id>` |
| Thread (channel mention with `thread_ts`) | channel id | `false` | `true` | `slack:<channel-id>` (replies go to the thread) |
| DM | channel id `D…` (type `im`) | `true` | `false` | `slack:<channel-id>` |

When the inbound message has a `thread_ts` or the `replyToId` is set, the adapter passes `thread_ts` to `chat.postMessage` so the reply lands in the same thread. New top-level mentions start a new thread when the agent's reply spans multiple chunks.

The adapter skips messages with any `subtype` (bot messages, edits, joins) — Bolt surfaces those as `message` events too. Bot- and workflow-authored posts are the one exception: allowlist their `bot_id` under [`slack.apps.<i>.allowedBotIds`](../using/reference/config-yaml.md#slack-apps) and they reach the agent.

### 4a. Plugin commands

Plugin commands registered via `registerSlashCommand()` are dispatched through the gateway's text-matching pipeline — the same path as built-in `/` commands.

Unlike Telegram and Discord, Slack requires manual slash command registration in the Slack app dashboard (`api.slack.com`). The gateway logs the list of commands that need registration at startup so operators can sync them. See [Register plugin slash commands](../building/how-to/register-plugin-commands.md) for the full walkthrough.

### 5. Restrict who can talk to the bot

Configure under `channelFilter.slack` (`packages/safety/channel/src/channel-filter.ts`):

```yaml
channelFilter:
  slack:
    ownerUserId: "U01ABCDEFGH"            # Slack user id — always allowed
    recipientAllowlist:
      - "U02ABCDEFGH"                     # extra user ids
      - "C03ABCDEFGH"                     # or whole channel ids
    dmPolicy: pairing                     # pairing | allowlist | queue | reject | silent-drop
    contextVisibility: allowlist          # strip quoted text from non-allowlisted senders
```

Field meanings:

- `ownerUserId` — bypasses every gate, including the channel mention gate.
- `recipientAllowlist` — Slack user ids and channel ids that are also allowed.
- `dmPolicy` — what happens when a non-allowlisted user DMs the bot. `pairing` (default) replies with a one-time code; `allowlist` silently drops; the rest match the [Telegram adapter](telegram.md).
- `contextVisibility: allowlist` — strips quoted Slack-thread content from non-allowlisted senders before the agent sees it.

From inside `ethos chat`:

```
/communications
/allow 7H3K-9XQ2
/deny slack U02ABCDEFGH
```

### 5a. Restrict who can run `/ethos` and open App Home

`/ethos` and the App Home tab never become inbound messages, so the filter above does not see them. They get their own gate, and it is default-deny: the allowlist is `ownerUserId` + `recipientAllowlist` from the block above, optionally narrowed by [`slack.apps.<i>.allowedSlashUsers`](../using/reference/config-yaml.md#slack-apps).

```yaml
slack.apps.0.allowedSlashUsers: U01ABCDEFGH,U02ABCDEFGH
```

A user who is not on that allowlist gets an ephemeral "You are not authorized to use this command" and an App Home tab whose memory, session, kanban, and channel sections are replaced by a notice. Configure `ownerUserId` before rolling out: with no `channel_filter.slack` entry, nobody — including you — can run `/ethos memory add`, `/ethos channel-mode`, or read the bot's memory from App Home.

### 6. Drive multi-workspace deployments

A Slack app is installed per workspace. Each installation issues its own bot token. To run the same Ethos app across several workspaces:

- Run several gateways with separate `~/.ethos/` directories:

```bash
HOME=/srv/ethos-workspace-a ethos gateway start &
HOME=/srv/ethos-workspace-b ethos gateway start &
```

Each `HOME` carries its own `slackBotToken`, `slackAppToken`, `slackSigningSecret`, SQLite store, logs, and pairing database. The bots stay isolated; sessions never cross.

- Or run one gateway against one workspace and add Telegram or Discord tokens alongside. The same `MessageDedupCache` (30s TTL, keyed by `(sessionId, sha256(content))`) suppresses duplicate outbound text on the same session across every adapter.

A single Slack adapter instance binds to one bot token. Multi-tenant Slack distribution (one app, many workspaces, OAuth per workspace) is not yet wired through `apps/ethos/src/commands/gateway.ts`.

## Verify

**Token works.**

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
  https://slack.com/api/auth.test | jq .ok
```

Returns `true` along with the team name. `false` or `invalid_auth` means the bot token is wrong; reinstall the app.

**Gateway sees Slack.**

Foreground-start the gateway and confirm `⚡️ Bolt app started`. The adapter's `health()` calls `auth.test` and reports `ok` plus latency.

**Mention round-trips in a channel.**

In a channel the bot is a member of, post `@Ethos ping`. Reply arrives within a few seconds.

**DM round-trips.**

DM the bot `ping`. Reply arrives. If you set `dmPolicy: pairing`, the first DM from a non-allowlisted user gets a pairing code instead.

**Thread routing.**

Reply to one of the bot's messages inside the thread. The bot's next reply lands in the same thread (via `thread_ts`).

**Allowlist enforcement.**

Have a non-allowlisted account `@mention` the bot. With the default config, the message is silently dropped; `ethos audit | tail` shows `channel.allowlist.blocked` or `channel.mention_gate`.

**Dedup is active.**

Send the same prompt twice within 30 seconds. The bot answers once if generated text is identical.

## Troubleshoot

**`⚡️ Bolt app started` prints but the bot ignores every message.**
Either `app_mention` / `message.im` are not subscribed in **Event Subscriptions**, or Socket Mode is off. Both are required. A bot that answers mentions but nothing else is a different fault — see the channel-mode entry below.

**Bot replies in a channel it was just invited to but not in another.**
Slack scopes are per-channel for `channels:history` and `groups:history`. Invite the bot to each channel you want it active in. `app_mention` works regardless of channel membership, but reading thread history does not.

**Bot answers mentions in a channel but ignores it in `all`, `thread_follow`, or `observe` mode.**
The app is not subscribed to `message.channels` (public channel) or `message.groups` (private channel), so Slack never sends those messages. Mentions arrive over `app_mention`, which is why the channel looks half-alive. Add the subscription under **Event Subscriptions** → **Subscribe to bot events**; see [Platform prerequisites for unaddressed channel messages](#1a-platform-prerequisites-for-unaddressed-channel-messages).

**HTTP 429 / `ratelimited` from `chat.postMessage`.**
Slack's tier-3 rate limit is ~50 calls per minute per workspace. Streaming edits stay under this because `reflowChunks` edits in place. Sustained 429s mean two gateways share a bot token or a [personality](../getting-started/glossary.md#personality) is auto-replying. Check `ethos errors` and the running gateway count.

**`not_in_channel` from `chat.postMessage`.**
The bot user is not a member of the target channel. Invite the bot to the channel.

**`missing_scope` errors.**
The bot lacks a scope the gateway needs. Reinstall the app after adding the scope under **OAuth & Permissions**; reinstallation issues a new bot token, so update `slackBotToken` in `~/.ethos/config.yaml` after.

**Replies arrive split into multiple messages.**
Expected. The adapter caps outbound text at 3,000 characters per `chat.postMessage` to leave headroom under Slack's 4,000-character block limit; `chunkText` splits at newlines (>60% of the limit). Streamed edits re-flow — first chunks are edited, extras are appended, trailing chunks are deleted.

**Replies in a thread show up as top-level channel messages.**
The inbound message had no `thread_ts`. Reply to one of the bot's existing messages in the thread to seed it, or include `thread_ts` when calling the gateway directly.

**A message sent twice on purpose was answered only once.**
The outbound `MessageDedupCache` suppresses identical `(sessionId, content)` within 30 seconds. Change one character, wait 30 seconds, or set `ETHOS_DEDUP_LEGACY=1` to disable.

**Pairing code expired.**
Codes have a TTL in `packages/safety/channel/src/pairing-store.ts`. If the DM author waited too long, they need to DM again. Owners can `/communications approve-all` to approve every pending sender.

**Socket Mode reconnects every few minutes.**
Slack rotates the WebSocket; Bolt reconnects automatically. Persistent flapping points at a network or proxy issue between the host and `wss.slack.com`. The signing secret is only checked for HTTP event endpoints, so it does not cause socket disconnects.

## Errors you may see

| Code | Surface | Cause | Fix |
|---|---|---|---|
| `channel.allowlist.blocked` | gateway audit | Non-allowlisted sender in a channel, or DM under `dmPolicy: silent-drop`. | Add the user id to `recipientAllowlist` or trigger `/allow <code>`. |
| `channel.mention_gate` | gateway audit | Allowlisted sender posted in a channel without `@mentioning` the bot. | Mention the bot or reply in-thread. |
| `channel.pairing.sent` | gateway audit | First DM from a non-allowlisted user; pairing code emitted. | Owner runs `/allow <code>` to approve. |
| `channel.context_stripped` | gateway audit | Quoted thread content from a non-allowlisted user was removed before the turn. | Expected when `contextVisibility: allowlist`. |
| `channel.prior_context_stripped` | gateway audit | Thread-backfill lines from non-allowlisted authors were removed; `details.dropped` is `true` when nothing survived. | Expected when `contextVisibility: allowlist`. Add the author's user id (or a bot's `bot_id`) to `recipientAllowlist` to keep their lines. |
| `invalid_auth` | adapter health | Bot token revoked or wrong. | Reinstall the app, copy the new `xoxb-…` token. |
| `not_in_channel` | delivery result | Bot is not a member of the target channel. | Invite the bot. |
| `missing_scope` | delivery result | App lacks a Bot Token Scope. | Add the scope, reinstall, update the token. |

## See also

- [Receive Slack and Telegram events over webhooks](../using/how-to/run-channels-over-webhooks.md) — swap Socket Mode for the HTTP Events API, including the manual Request URL step.
- [Telegram adapter](telegram.md) — long-polling adapter sharing the same gateway boundary.
- [Discord adapter](discord.md) — guild and DM routing.
- [Send and receive voice notes on a channel](../using/how-to/voice-notes-on-channels.md) — Slack transcribes audio uploads and can reply with a spoken file.
- [Run Ethos as a daemon](../using/how-to/run-as-daemon.md) — `launchd`, `systemd`, `pm2`.
- [Glossary](../getting-started/glossary.md) — [`gateway`](../getting-started/glossary.md#gateway), [`session`](../getting-started/glossary.md#session), [`audience boundary`](../getting-started/glossary.md#audience-boundary).
