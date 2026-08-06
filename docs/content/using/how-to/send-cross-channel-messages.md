---
title: Send cross-channel messages
description: "Set up the engineer personality to post from Telegram to Slack (and vice versa) via the send_message tool. End-to-end walkthrough."
kind: how-to
audience: user
slug: send-cross-channel-messages
time: "10 min"
updated: 2026-05-17
---

## Task

Configure Ethos so a personality talking to you in Telegram can post a message into a Slack channel — and vice versa — via the [`send_message`](../../building/reference/messaging-tools.md) tool.

## Result

When you DM your Telegram bot:

> *Send "build green ✓" to slack channel C0123ABC*

…the agent calls `send_message`, the gateway routes through the Slack adapter, and your Slack channel shows the message from your Slack bot user.

## Prereqs

- `ethos gateway` working end-to-end on at least one channel (Telegram **or** Slack already replying to messages).
- Both adapters configured in `~/.ethos/config.yaml` — see [Multi-bot Telegram](run-multi-bot-telegram.md) and the [Slack platform guide](../../platforms/slack.md).
- A personality bound to your Telegram bot (e.g. `engineer`) that you can edit.

## Steps

### 1. Add `send_message` to the personality toolset

`send_message` is **not** in any bundled personality's default toolset — operators opt in explicitly. Edit `~/.ethos/personalities/<id>/toolset.yaml` (or the bundled personality file under `extensions/personalities/data/<id>/toolset.yaml` for a framework-default change):

```yaml
- terminal
- read_file
# ... existing tools ...
- send_message
```

The bundled `engineer` already has it.

### 2. Get the target Slack channel ID

`send_message`'s `target` field takes the **channel ID** (e.g. `C0123ABC`), not the channel name (`#engineers`). Two ways to find it:

- **Channel URL.** Open the channel in Slack web/desktop. URL ends in `/C0123ABC`.
- **Right-click → Copy link.** The link contains the ID.

If you want the agent to DM a Slack user instead, the user ID format is `U0123ABC` (visible under **Profile → ⋮ → Copy member ID**).

### 3. Invite your Slack bot to the channel

The bot can't post to a channel it's not a member of. From the destination channel in Slack:

```
/invite @YourBotName
```

If the bot is missing `chat:write` scope you'll get an error here — see [`use-as-mcp-server`](use-as-mcp-server.md) or [`receive-files-via-slack`](receive-files-via-slack.md) for the OAuth scope setup.

### 4. Write the allowlist

Create or edit `~/.ethos/messaging.json`:

```json
{
  "engineer": ["slack:C0123ABC"]
}
```

Replace `engineer` with whichever personality you wired in step 1, and `C0123ABC` with the channel ID from step 2.

For testing, the universal wildcard works:

```json
{
  "engineer": ["*"]
}
```

— allows the personality to send to any platform/target. Lock down to specific entries before production.

### 5. Restart the gateway

`messaging.json` is read once at boot. After every edit:

```bash
# Stop the running gateway with Ctrl-C, then:
ethos gateway
```

The boot banner prints one line per active adapter — confirm both `telegram` and `slack` are listed.

### 6. Test from Telegram

DM your Telegram bot:

```
Use the send_message tool to post "hello kevin" to slack channel C0123ABC.
```

Explicit phrasing helps — the model occasionally hesitates with softer prompts ("can you send …"). The "use the send_message tool" prefix removes ambiguity.

## Verify

Three surfaces confirm success simultaneously:

- **Gateway stdout** prints `tool_start: send_message` followed by `tool_end: send_message (Xms) ok`.
- **Telegram reply** from the engineer narrates the action — *"Posted to slack:C0123ABC."*
- **Slack channel** shows a new message from the bot user with the body you specified.

If only one or two of the three appear, the discrepancy points at the failure layer (see Troubleshoot).

## Examples

### Slack → Telegram {#example-slack-to-telegram}

Same setup in reverse. The engineer personality has `send_message` in its toolset; the allowlist includes a Telegram target:

```json
{
  "engineer": ["slack:C0123ABC", "telegram:-1001234567890"]
}
```

@mention the bot in Slack:

> *@Kevin send "deploy starting" to telegram chat -1001234567890*

Tool call routes through the Telegram adapter — your Telegram chat shows the message.

### Cron-triggered fan-out {#example-cron-fanout}

Set up a [cron job](configure-providers.md) that fires a personality with this prompt:

```
Post "standup in 5 minutes" to slack:C0STANDUP and to telegram:-1001234567890.
```

Allowlist must contain both targets. The agent calls `send_message` twice — outbound dedup is per-target, so the same body to two different targets both go through.

### Multi-bot routing {#example-multi-bot}

If your `~/.ethos/config.yaml` has multiple Slack apps (`slack.apps.0.*`, `slack.apps.1.*`), the gateway uses the **first** adapter for each platform when send_message dispatches. Different Slack workspaces aren't selectable today — track [`MessagingSendFn`'s `botKey`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-messaging/src/index.ts) parameter for the in-flight extension.

## Troubleshoot

**"Gateway not active — send_message requires gateway mode"** — You're running `ethos chat`, not `ethos gateway`. The tool only routes through the Gateway's adapter registry. Switch.

**"No adapter registered for platform 'slack'"** — Slack isn't configured. Check `~/.ethos/config.yaml` has at least one `slack.apps.0.*` block, gateway boot didn't error, and `slack.apps.0.botToken` / `appToken` / `signingSecret` resolve through `${secrets:...}` correctly.

**"Target 'slack:C0123ABC' is not in the personality's allowed messaging targets. Allowed: none"** — `messaging.json` doesn't list this target for this personality. Add it, or use `"*"` for testing. Don't forget the gateway restart.

**Engineer narrates a polite refusal without calling the tool** — The LLM is hallucinating. Prompt explicitly: *"Use the send_message tool to ..."*. If it still refuses, ask: *"What tools do you have available?"* — the reply should list `send_message`. If absent, the toolset.yaml edit didn't propagate; verify the file and restart the gateway.

**"Adapter send failed: not_in_channel"** — Slack rejected because the bot isn't in the channel. From the channel in Slack: `/invite @YourBotName`.

**Send works but the message is dropped silently within 30s** — Outbound dedup. The same `(platform, target, body)` sent twice within 30 seconds is suppressed. Vary the body or wait past the TTL.

**Engineer says "I don't have permission to send messages" even after the toolset has send_message** — The tool description used to say *"The personality must have messaging.send capability"*, which caused this exact refusal. The description was updated; if you see this on an older build, restart the gateway after pulling.

## See also

- [`send_message` tool reference](../../building/reference/messaging-tools.md) — schema, routing, dedup semantics.
- [`messaging.json` reference](../reference/messaging-json.md) — the allowlist file's full format.
- [Multi-bot Telegram](run-multi-bot-telegram.md) — running multiple Telegram bots per gateway.
- [Receive files via Slack](receive-files-via-slack.md) — Slack bot OAuth scopes and channel membership.
