---
title: Messaging — send_message
description: "send_message tool reference: schema, allowlist semantics, gateway routing, dedup, and the boot wiring."
kind: reference
audience: developer
slug: messaging-tools
updated: 2026-05-17
---

# Messaging — `send_message`

`send_message` is the agent-callable [tool](../../getting-started/glossary.md#tool) that posts to any configured channel adapter from inside a turn — not just the channel that triggered the turn. The structural team-shape primitive: an agent answering in Telegram can post to Slack; a cron-triggered turn can fan out to multiple platforms.

## Source {#source}

Tool factory: [`extensions/tools-messaging/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-messaging/src/index.ts) (`createMessagingTools`). Gateway routing: [`extensions/gateway/src/index.ts` `sendTo()`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts). Allowlist wiring: [`packages/wiring/src/index.ts` `loadMessagingAllowlist()`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts).

## Schema {#schema}

```ts
send_message({
  platform: 'slack' | 'telegram' | 'discord' | 'email',
  target:   string,   // platform-specific id; see below
  body:     string    // message text (markdown where the platform supports it)
})
```

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `'slack' \| 'telegram' \| 'discord' \| 'email'` | yes | Which adapter to route through. The adapter must be configured AND running at gateway boot. |
| `target` | string | yes | Recipient. See [Target format](#target-format). |
| `body` | string | yes | Message content. Plain text + markdown where the platform allows it. Slack accepts `*bold*` `_italic_` `` `code` `` (mrkdwn flavour, not GitHub markdown). |

Tool metadata: `toolset: 'messaging'`, `maxResultChars: 1024`, `capabilities: {}` (no framework-level capability gate — the allowlist below is the only gate).

## Target format {#target-format}

| Platform | `target` value | How to obtain |
|---|---|---|
| `slack` | Channel ID (`C0123ABC`) or user ID (`U0123ABC`) — **not** channel names | Right-click channel in Slack → Copy link → grab the `C…` segment. Or look at the URL: `https://app.slack.com/client/T.../C0123ABC`. |
| `telegram` | Numeric chat ID (`-100123…` for groups; user `from.id` for DMs) or `@channelname` | Inbound messages: gateway logs `chat_id` per turn. New chat: invite the bot, send a message, copy from logs. |
| `discord` | Channel ID (Discord snowflake, e.g. `1234567890123456789`) | Enable Developer Mode in Discord settings → right-click channel → **Copy ID**. |
| `email` | RFC 5322 email address | The recipient's email. |

## Allowlist {#allowlist}

The tool enforces a per-personality target allowlist. Without an explicit allowlist entry, **every send is denied** — this is intentional default-deny posture, anti-spam.

The allowlist lives in [`~/.ethos/messaging.json`](../../using/reference/messaging-json.md). Shape:

```json
{
  "engineer": ["slack:C0123ABC", "telegram:-100123"],
  "researcher": ["*"]
}
```

- Each entry is `<platform>:<target>`.
- `"*"` is the universal wildcard — allow any target on any platform. Useful for testing; not recommended for production.
- A personality absent from the file → empty allowlist → all sends denied.

Read once at gateway boot via `loadMessagingAllowlist(dataDir)`. Restart `ethos gateway` to pick up edits.

See [the messaging.json reference](../../using/reference/messaging-json.md) for the full file format, and [Send cross-channel messages](../../using/how-to/send-cross-channel-messages.md) for the operator how-to.

## Wiring {#wiring}

The tool is registered for every AgentLoop in [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts):

```ts
for (const tool of createMessagingTools({
  send: async (platform, target, body, botKey) => gatewaySendFn(platform, target, body, botKey),
  getAllowedTargets: (personalityId) => {
    if (!personalityId) return [];
    return messagingAllowlist.get(personalityId) ?? [];
  },
})) tools.register(tool);
```

The `gatewaySendFn` is a mutable that starts as a "not available" stub. When `ethos gateway` boots, [`apps/ethos/src/commands/gateway.ts`](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/commands/gateway.ts) replaces it with `gateway.sendTo(...)` for every active loop. In CLI mode (no gateway), the stub remains and the tool returns the "Gateway not active" error.

## Gateway routing {#gateway-routing}

`gateway.sendTo(platform, target, body)`:

1. Looks up the adapter for `platform` in the gateway's `adapterRegistry: Map<string, PlatformAdapter>`. Missing platform → `No adapter registered for platform "<X>"`.
2. Runs outbound dedup keyed on `outbound:<platform>:<target>` (30s TTL — same `MessageDedupCache` the inbound path uses). Same `(target, body)` within 30s → silently deduplicated, returns `ok: true` without re-sending.
3. Dispatches `adapter.send(target, { text: body })`. Adapter returns `{ ok, error? }`.

## Errors {#errors}

The tool returns `{ ok: false, code, error }`. Surface code maps:

| Cause | `code` | Example `error` |
|---|---|---|
| Missing required field | `input_invalid` | `platform, target, and body are required` |
| Target not in allowlist | `input_invalid` | `Target "slack:C..." is not in the personality's allowed messaging targets. Allowed: slack:C0123, ...` |
| No adapter registered for platform | `execution_failed` | `No adapter registered for platform "slack"` |
| Adapter rejected (e.g. Slack `not_in_channel`) | `execution_failed` | `Adapter send failed: not_in_channel` |
| Gateway not active (CLI mode) | `execution_failed` | `Gateway not active — send_message requires gateway mode` |

The agent surfaces the error string back to the user — diagnose by reading it verbatim.

## Examples {#examples}

### Telegram → Slack {#example-telegram-to-slack}

Personality: `engineer`. Allowlist has `slack:C0123ABC`. From Telegram, send the bot:

```
Send "build green ✓" to slack channel C0123ABC
```

Tool call:

```json
{
  "platform": "slack",
  "target": "C0123ABC",
  "body": "build green ✓"
}
```

### Slack → Telegram {#example-slack-to-telegram}

Bot mention in Slack with `@Kevin post "alert" to telegram chat -100123456`:

```json
{
  "platform": "telegram",
  "target": "-100123456",
  "body": "alert"
}
```

### Cron → multi-channel fan-out {#example-cron-fanout}

A cron-triggered personality can fan out:

```
For each of slack:C0123ABC and telegram:-100123, post "daily standup in 5min".
```

The agent calls `send_message` twice — once per target — and the dedup cache prevents duplicates within the 30s TTL.

## Capability rationale {#capability-rationale}

`capabilities: {}` — no framework-level gate. The reason: send_message routes through an operator-owned adapter registry + operator-owned allowlist. There's no fs / network / process surface the tool itself adds; the adapter has those already. The allowlist is the policy, not a capability declaration.

This contrasts with `text_to_speech`, which has `capabilities: {}` for the same reason (audio output via channel adapter), and `vision_analyze`, which has `fs_reach: { read: 'from-personality' }` because the tool itself opens files.

## See also {#see-also}

- [messaging.json reference](../../using/reference/messaging-json.md) — the allowlist file format.
- [Send cross-channel messages](../../using/how-to/send-cross-channel-messages.md) — operator how-to with Telegram→Slack walkthrough.
- [Channel adapter contract](../explanation/audience-boundary.md) — outbound dedup semantics.
- [Tool interface](tool-interface.md) — the `Tool<TArgs>` contract every tool implements.
