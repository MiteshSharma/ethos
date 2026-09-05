---
title: "Telegram adapter"
description: "Operate Ethos on Telegram: token, routing to chats and groups, mention gate, allowlist and pairing, rate limits, multi-workspace, and the error catalog."
kind: how-to
audience: shared
slug: platform-telegram
time: "15 min"
updated: 2026-09-05
---

## Task

Run the Ethos [gateway](../getting-started/glossary.md#gateway) against a Telegram bot in a way that survives real traffic: route private chats and group mentions to the right [session](../getting-started/glossary.md#session), restrict who can DM, stay under Telegram's send rate, run a second bot from the same host, and recognise the failure modes when they arrive.

For zero-to-first-message, follow [Deploy your first Telegram agent](../using/tutorials/first-deploy-telegram.md) — this how-to picks up where the tutorial ends.

## Result

- A Telegram bot routes inbound updates through `TelegramAdapter` → `Gateway` → `AgentLoop`.
- Private chats, replies, and `@mentions` in groups land in the correct session; everything else is dropped.
- Only allowlisted senders reach the agent; new DMs trigger the pairing-code flow.
- Outbound text is split into 4,096-character chunks, deduped over a 30-second window, and edited in place when the agent streams.
- A second bot runs from a sibling `~/.ethos/` without interfering with the first.

## Prereqs

- `ethos chat` works locally with a configured LLM provider.
- A bot token from `@BotFather` (the `/newbot` flow).
- BotFather's **Group Privacy** setting decided for the bot. It governs what Telegram delivers to a bot in a group and cannot be overridden from `~/.ethos/config.yaml` — see [Platform prerequisites for group messages](#3b-platform-prerequisites-for-group-messages).
- The token saved to `telegramToken` in `~/.ethos/config.yaml` (run `ethos gateway setup` or hand-edit).
- The host can reach `api.telegram.org` over HTTPS.

## Source

- `extensions/platform-telegram/src/index.ts` — `TelegramAdapter` (long-polling via `grammy`, chunking, edit-in-place).
- `extensions/platform-telegram/src/validate.ts` — `getMe`-based token validation called by setup.
- `extensions/gateway/src/index.ts` — routing, slash commands, dedup, allowlist enforcement.
- `packages/safety/channel/src/channel-filter.ts` — sender allowlist, mention gate, DM policy.
- `apps/ethos/src/commands/gateway.ts` — adapter wiring (`new TelegramAdapter({ token, dropPendingUpdates: true })`).

## Steps

### 1. Wire the token

```yaml
# ~/.ethos/config.yaml
telegramToken: "123456789:ABCdefGhIJklmNopQRstuVwxYZ"
```

`ethos gateway setup` validates the token against `https://api.telegram.org/bot<TOKEN>/getMe` and writes the value for you. The portion before the colon is the numeric bot id; everything after is the secret — treat it like a password.

### 1a. Run multiple bots from one process

The `telegramToken` scalar wires one bot. To run two or more bots from the same gateway process, replace it with the `telegram.bots` list:

```yaml
# ~/.ethos/config.yaml

telegram.bots.0.token: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
telegram.bots.0.id: researcher-bot
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher

telegram.bots.1.token: "654321:XYZabcDeFgHijKlMnOpqRsTuV"
telegram.bots.1.id: coder-bot
telegram.bots.1.bind.type: personality
telegram.bots.1.bind.name: engineer
```

Each entry in `telegram.bots` creates one `TelegramAdapter` and one `AgentLoop`. The `id` field is a stable key for session lane names and log output — set it once and do not change it.

The old scalar shape still works and is not going away in the current major version. When both `telegramToken` and `telegram.bots` are present, `telegram.bots` takes precedence and the scalar is ignored with a deprecation warning.

For a full walkthrough, see [Run multiple Telegram bots from one process](../using/how-to/run-multi-bot-telegram.md).

### 2. Start the gateway

```bash
ethos gateway start
```

Expected boot lines:

```
ethos gateway  starting...
✓ Telegram online (412ms)
Listening for messages. Press Ctrl+C to stop.
```

For production with the web dashboard alongside, use `ethos run-all` under PM2 — see [Deploy in production](../using/how-to/deploy-in-production.md). For just the Telegram gateway by itself under `launchd` / `systemd` / `pm2`, see [Run Ethos as a daemon](../using/how-to/run-as-daemon.md).

### 3. Understand routing

`TelegramAdapter.start()` registers a `bot.on('message')` listener and forwards every text or caption as an `InboundMessage`. The gateway keys each session per `(platform, botKey, chatId)`. `botKey` is the `id` field from config (or its sha256-derived default).

In **single-bot** mode (legacy `telegramToken` scalar), the session key omits the bot segment:

| Chat type | `chatId` | `isDm` | `isGroupMention` | Effective session key |
|---|---|---|---|---|
| Private chat | user id | `true` | `false` | `telegram:<user-id>` |
| Group (bot is `@mentioned`) | negative group id | `false` | `true` | `telegram:<group-id>` |
| Group (reply to bot) | negative group id | `false` | `false` | `telegram:<group-id>` |
| Group (random chatter) | negative group id | `false` | `false` | dropped by the mention gate |

The last row assumes Telegram delivered the message at all. With BotFather's Group Privacy on — the default for every new bot — it does not: unaddressed group posts never reach the adapter, so the mention gate never sees them. [Platform prerequisites for group messages](#3b-platform-prerequisites-for-group-messages) covers the difference and how to check which side of it a bot is on.

In **multi-bot** mode (`telegram.bots` list), the session key includes the `botKey` segment — `telegram:<botKey>:<chatId>` — so each bot maintains fully isolated histories even when the same Telegram user id appears in both bots' chats.

The session key forks when `/new` or `/personality <id>` runs in the chat — both append `:${Date.now()}` so the agent loses prior context cleanly. The previous session's outbound dedup keys are cleared at the same boundary.

Group chats share one session across every member. To give each user their own thread, deploy two bots and `/start` them privately.

### 3a. Plugin commands

Plugin commands registered via `registerSlashCommand()` appear in Telegram's command menu. The gateway calls `registerCommands()` at startup, which pushes the command list to the Telegram Bot API via `setMyCommands`. Command names are sanitized to Telegram's constraints: lowercase, underscores only, max 32 characters.

Commands are dispatched via the gateway's text-matching pipeline — the same path as built-in `/` commands. See [Register plugin slash commands](../building/how-to/register-plugin-commands.md) for the full walkthrough.

### 3b. Platform prerequisites for group messages

Telegram decides what a bot in a group is allowed to see, and it decides it in BotFather. No Ethos setting overrides it.

Every bot is created with **Group Privacy on**. Telegram then delivers only the group messages that mention the bot by `@username`, reply to one of its messages, or are commands. Ordinary chatter between other members never leaves Telegram's servers, so no amount of gateway configuration can reach it.

That default matches the routing in [step 3](#3-understand-routing): Ethos answers Telegram groups on mention or reply, and privacy on is the narrower, safer setting for a bot that only ever answers when spoken to. Turn it off only when the bot has a reason to read messages addressed to nobody — the bot then receives every message in every group it belongs to, which is a real privacy decision to take deliberately rather than as setup boilerplate.

**Check which side a bot is on.** Ask Telegram rather than BotFather's menus:

```bash
curl -s "https://api.telegram.org/bot<your-bot-token>/getMe"
```

```json
{"ok":true,"result":{"id":123456789,"is_bot":true,"first_name":"My Strategist Bot","username":"my_strategist_bot","can_join_groups":true,"can_read_all_group_messages":false,"supports_inline_queries":false}}
```

`can_read_all_group_messages` is the answer, and it is inverted from the BotFather wording: `false` means privacy mode is **on** and the bot sees only what is addressed to it. `true` means privacy mode is off and the bot reads the whole group.

**Turn privacy mode off.**

1. Open `@BotFather` and send `/setprivacy`.
2. Pick the bot.
3. Choose **Disable**.
4. Remove the bot from every group it already belongs to, then add it back.

Step 4 is the one that gets missed. Telegram fixes a bot's privacy setting per group at the moment the bot joins, so a bot already sitting in a group keeps the setting it joined under. `getMe` will report `can_read_all_group_messages: true` while that group still behaves as though privacy were on — the setting is right and the group is stale. Re-adding the bot is what reconciles them.

**Set what the bot does with what it hears.** Privacy mode decides what Telegram delivers; `telegram.bots.<i>.defaultChannelMode` decides what the bot does with it. Turning privacy mode off alone changes nothing about replies — the default mode is still `mention_only`, so unaddressed messages arrive and are dropped.

```yaml
# ~/.ethos/config.yaml
telegram.bots.0.defaultChannelMode: observe
```

Five values, and they apply to every group the bot is in:

| Mode | Replies to | Records |
|---|---|---|
| `mention_only` (default) | messages containing the bot's `@username` | those messages |
| `thread_follow` | mentions, plus every message in a forum topic the bot has posted in | those messages |
| `all` | every message in the chat | every message |
| `regex_match` | mentions only, in practice — see below | those messages |
| `observe` | nothing, not even an explicit `@mention` | every message |

DMs are answered under every mode. `regex_match` matches a per-chat stored pattern, and there is no way to store one on Telegram yet, so as a global default it behaves as `mention_only`. Restart the gateway after editing the key — config is read at startup.

A bot left on `observe` while privacy mode is still on records nothing, and says so at boot: `Telegram privacy mode is ON for @<username> — chats set to observe will record nothing.` Fix it with the BotFather sequence above, re-add included.

**There is no per-chat command on Telegram.** Slack's `/ethos channel-mode` has no Telegram equivalent, so this key is the only way to set a mode today and it cannot be narrowed to one group. Field details are in [`telegram.bots.*`](../using/reference/config-yaml.md#telegram-bots).

### 4. Restrict who can talk to the bot

Default behaviour is **deny by default in groups, pairing flow in DMs.** Configure under `channelFilter.telegram` (`packages/safety/channel/src/channel-filter.ts`):

```yaml
channelFilter:
  telegram:
    enable: false                   # optional escape hatch — bypass the filter, keep the config
    ownerUserId: "1234567"          # numeric Telegram user id — always allowed
    recipientAllowlist:
      - "9876543"
      - "-1001234567890"            # whole group; negative ids
    dmPolicy: pairing               # pairing | allowlist | queue | reject | silent-drop
    contextVisibility: allowlist    # strip quoted text from non-allowlisted senders
```

Field meanings:

- `enable` — explicit on/off switch for the whole filter on this platform. Omitted (the default) or `true` keeps the filter on. `false` bypasses every gate — allowlist, `dmPolicy`, mention gating, context visibility — so you can disable the filter without deleting the rest of the block.
- `ownerUserId` — bypasses every gate, including the group mention gate. Required for `/allow`, `/deny`, `/communications` to take effect.
- `recipientAllowlist` — extra allowed user ids and group ids. Globs are accepted for the email adapter only.
- `dmPolicy` — what happens when a non-allowlisted user DMs the bot. `pairing` (default) replies with a one-time code; `allowlist` silently drops; `queue` parks the message for owner review; `reject` replies "not authorised"; `silent-drop` is the noisiest legacy mode.
- `contextVisibility` — `allowlist` strips quoted or threaded content from non-allowlisted senders before the agent sees it (defence against context smuggling).

From inside `ethos chat`:

```
/communications              # list pending pairing codes and approved senders
/allow 7H3K-9XQ2             # approve a sender by pairing code
/deny telegram 1234567       # revoke an approved sender
```

The gateway emits an audit event for every approve, deny, and context strip; `ethos audit` surfaces them.

### 5. Drive multi-workspace deployments

Telegram allows one long-polling consumer per token. To run several bots from one host:

- Run several gateways with separate `~/.ethos/` directories:

```bash
HOME=/srv/ethos-workspace-a ethos gateway start &
HOME=/srv/ethos-workspace-b ethos gateway start &
```

Each `HOME` gets its own `config.yaml`, SQLite store, logs, and pairing database. The bots stay isolated; sessions never cross.

- Or run one gateway with several platform adapters by attaching Discord and Slack tokens in the same `config.yaml`. The gateway processes every adapter against the same `MessageDedupCache` (30s TTL, keyed by `(sessionId, sha256(content))`) — duplicate outbound text on the same session is suppressed regardless of which adapter emitted it.

A single gateway cannot proxy two Telegram bots from the same token. Use distinct tokens or distinct `HOME` roots.

## Verify

Run each check in order; stop at the first failure and fix.

**Bot is up.**

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_TOKEN/getMe" | jq .ok
```

Returns `true`. A `false` or HTTP error means the token is invalid or revoked.

**Gateway sees the bot.**

Foreground-start the gateway and confirm `✓ Telegram online (Nms)`. Latency above 1500 ms means a network or DNS issue, not a Telegram outage.

**Private DM round-trips.**

DM the bot `ping`. Reply arrives within a few seconds. Check `~/.ethos/logs/gateway.out.log` if not.

**Group mention round-trips.**

Add the bot to a group, post `@yourbotname ping`. Reply appears in the same chat. A non-mentioned `ping` produces no reply — that is the mention gate doing its job.

**Allowlist enforcement.**

DM from a non-allowlisted account. With `dmPolicy: pairing`, the bot replies with a pairing code only — no agent turn fires. `ethos audit | tail` shows `channel.allowlist.blocked` (in groups) or `channel.pairing.sent`.

**Dedup is active.**

Send the same prompt twice within 30 seconds in the same chat. The second message gets an answer (inbound dedup keys on `messageId`, not content); the bot's reply is sent once if the generated text is identical.

## Troubleshoot

**`✓ Telegram online` never prints.**
The token is wrong or the host cannot reach `api.telegram.org`. Test `curl https://api.telegram.org/bot$TOKEN/getMe`. Regenerate with `/token` in BotFather if needed.

**Bot replies once, then nothing.**
Two consumers share the token. Telegram long-polling allows exactly one; the second hijacks updates intermittently. Kill the duplicate process or webhook. Look for stale `tmux` sessions, leftover `pm2` workers, or a parallel daemon.

**The bot is in the group but sees nothing except mentions.**
BotFather's Group Privacy is on for that group. Run `curl -s "https://api.telegram.org/bot$TOKEN/getMe"` and read `can_read_all_group_messages`: `false` means privacy mode is on. If it already reports `true`, the setting was changed after the bot joined — remove the bot from the group and add it back. See [Platform prerequisites for group messages](#3b-platform-prerequisites-for-group-messages).

**HTTP 429 from `sendMessage`.**
Telegram rate-limits at roughly 30 messages per second per bot and one message per second per chat. Streaming spikes are normal — the adapter edits in place rather than sending fresh chunks. Sustained 429s mean two bots share a token or a personality is replying to itself. Check `ethos errors` for `channel.pairing.sent` floods.

**HTTP 401 / 403 from `sendMessage`.**
The user blocked the bot, or the bot was kicked from the group. The gateway logs the error and the lane stays alive for other chats. Re-invite the bot or wait for the user.

**Markdown parse errors.**
Telegram's Markdown is strict (unmatched `_` or `*` rejects the whole message). The adapter retries as plain text on parse errors — see the `String(err).includes('parse')` fallback in `extensions/platform-telegram/src/index.ts`. If you still see truncated output, the personality is emitting Markdown the adapter cannot escape; switch the message to `parseMode: 'html'` from a [hook](../getting-started/glossary.md#hook).

**Replies arrive split into multiple messages.**
Expected. Telegram caps outbound text at 4,096 characters; `chunkText` splits at newlines (>60% of the limit) or spaces. Streamed edits re-flow with `reflowChunks` — first chunks are edited, extras are appended, trailing chunks are deleted.

**A message sent twice on purpose was answered only once.**
The outbound `MessageDedupCache` suppresses identical `(sessionId, content)` within 30 seconds. Change one character, wait 30 seconds, or set `ETHOS_DEDUP_LEGACY=1` to disable (one-release escape hatch — see `extensions/gateway/src/dedup.ts`).

**Pairing code expired.**
Codes live for the configured TTL in `pairing-store.ts`. If the user waited too long, ask them to DM again — a new code is issued. Owners can also `/communications approve-all` to approve every pending sender at once.

**Bot crashes the gateway on startup.**
A bad token rejects from `bot.start()` and used to kill the whole gateway. `extensions/platform-telegram/src/index.ts` catches the rejection now and logs `[telegram] bot polling stopped: <detail>`; other adapters keep running. If you see no log line and the process dies, file an issue — that is a regression.

**Two bots both reply to one user.**
Both bots share a `recipientAllowlist` entry and both are members of the same group. Either restrict the allowlists per bot or run them under separate `HOME` roots so they cannot see each other's pairing database.

## Errors you may see

| Code | Surface | Cause | Fix |
|---|---|---|---|
| `channel.allowlist.blocked` | gateway audit | Non-allowlisted sender in a group, or DM under `dmPolicy: silent-drop`. | Add the user id to `recipientAllowlist` or trigger `/allow <code>`. |
| `channel.mention_gate` | gateway audit | Allowlisted sender posted in a group without `@mentioning` the bot. | Mention the bot or reply to one of its messages. |
| `channel.pairing.sent` | gateway audit | First DM from a non-allowlisted user; pairing code emitted. | Owner runs `/allow <code>` to approve. |
| `channel.context_stripped` | gateway audit | Quoted content from a non-allowlisted user was removed before the turn. | Expected when `contextVisibility: allowlist`. |
| `telegram: bot polling stopped` | stderr | Token invalid, network drop, or another consumer claimed the long-poll. | Fix the token or kill the duplicate consumer. |

## See also

- [Deploy your first Telegram agent](../using/tutorials/first-deploy-telegram.md) — narrative tutorial covering BotFather, daemons, and the pairing flow end-to-end.
- [Run multiple Telegram bots from one process](../using/how-to/run-multi-bot-telegram.md) — full walkthrough of the `telegram.bots` list shape and per-bot personality binding.
- [Connect a Telegram bot to a team](../using/how-to/connect-telegram-to-team.md) — bind a bot to a team coordinator and auto-start the team supervisor.
- [Discord adapter](discord.md), [Slack adapter](slack.md) — the other channel adapters share the same gateway boundary.
- [Channel capability matrix](capability-matrix.md) — what every adapter supports for typing, streaming edits, media, and threads.
- [Run Ethos as a daemon](../using/how-to/run-as-daemon.md) — `launchd`, `systemd`, `pm2`.
- [Glossary](../getting-started/glossary.md) — [`gateway`](../getting-started/glossary.md#gateway), [`session`](../getting-started/glossary.md#session), [`audience boundary`](../getting-started/glossary.md#audience-boundary).
