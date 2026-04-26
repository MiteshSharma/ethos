---
sidebar_position: 5
title: Slack
---

# Slack Platform

The Slack adapter connects your Ethos agent to a Slack workspace using the Bolt SDK. It handles app mentions, DMs, slash commands, and message shortcuts with per-channel session isolation.

## Installation

The Slack adapter ships with the Ethos CLI. If you've already installed `@ethosagent/cli`, you don't need to install anything else — just enable it in your config.

## Setup

### 1. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
3. Under **Event Subscriptions**, enable and add:
   - `app_mention`
   - `message.im`
4. Install the app to your workspace and copy the **Bot User OAuth Token**
5. Copy the **Signing Secret** from **Basic Information**

### 2. Configure

```yaml
adapters:
  - slack

slack:
  token: "xoxb-YOUR-BOT-TOKEN"
  signingSecret: "YOUR_SIGNING_SECRET"
  appToken: "xapp-YOUR-APP-TOKEN"    # required for Socket Mode
  socketMode: true                    # recommended: no public URL needed
```

**Socket Mode** (recommended) — uses a WebSocket connection, so no public URL or TLS is required. Get an app-level token under **Basic Information** → **App-Level Tokens** with `connections:write` scope.

**HTTP mode** — requires a public URL for the event subscription endpoint:

```yaml
slack:
  token: "xoxb-..."
  signingSecret: "..."
  port: 3000
  path: "/slack/events"
```

## Triggering the bot

The bot responds to:

1. **@mentions** in any channel it's in: `@YourBot explain this error`
2. **Direct messages**: message the bot directly
3. **Slash commands** (optional, register in Slack app settings):
   - `/ask <message>`
   - `/new` — fresh session
   - `/personality <id>`

## Access control

```yaml
slack:
  token: "..."
  signingSecret: "..."
  allowedUserIds:
    - "U1234567890"    # Slack user ID
  allowedChannelIds:
    - "C1234567890"    # channel ID
```

## Threads

By default, the bot replies in-thread when the incoming message is already in a thread, and starts a new thread otherwise. Control this:

```yaml
slack:
  token: "..."
  signingSecret: "..."
  alwaysThread: true    # always reply in thread
  alwaysThread: false   # always reply in channel
```

## Block Kit responses

For structured output, the adapter can format responses using Slack Block Kit. This is off by default:

```yaml
slack:
  token: "..."
  signingSecret: "..."
  useBlocks: true
```

When enabled, Markdown headings become Block Kit section dividers, and code blocks become monospace sections.

## Sessions

| Context | Session key |
|---|---|
| Channel | `slack:<channel-id>` |
| Thread | `slack:<thread-ts>` |
| DM | `slack:<user-id>` |

## Workflow integration

The Slack adapter exposes a webhook endpoint for Slack Workflow Builder:

```
POST /slack/workflow
{"text": "...", "userId": "...", "channelId": "..."}
```

This lets you trigger the agent from automated Slack workflows without a bot mention.

## Deployment

See the [Deploy a Telegram Agent](../guides/deploy-telegram-agent) guide for the PM2 deployment pattern — it applies to Slack too. In Socket Mode, no reverse proxy or domain is required.
