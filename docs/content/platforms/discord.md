---
sidebar_position: 4
title: Discord
---

# Discord Platform

The Discord adapter runs your Ethos agent as a Discord bot using the Discord.js gateway. It handles slash commands, message events, DMs, and server channels with per-channel session isolation.

## Installation

The Discord adapter ships with the Ethos CLI. If you've already installed `@ethosagent/cli`, you don't need to install anything else — just enable it in your config.

## Setup

### 1. Create a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** → **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2** → **URL Generator** → select `bot` + `applications.commands`
6. Copy the invite URL and add the bot to your server

### 2. Configure

```yaml
adapters:
  - discord

discord:
  token: "YOUR_BOT_TOKEN"
  clientId: "YOUR_APPLICATION_ID"
  guildId: "YOUR_SERVER_ID"     # optional: register commands to one server (instant)
                                 # omit to register globally (up to 1hr propagation)
```

## Slash commands

The adapter registers these application commands:

| Command | Description |
|---|---|
| `/ask <message>` | Send a message to the agent |
| `/new` | Start a fresh session in this channel |
| `/personality <id>` | Switch personality |
| `/usage` | Show token usage |
| `/help` | Show available commands |

## Message events

The bot also responds to direct mentions:

```
@YourBot what is the meaning of life?
```

And to DMs without requiring a mention.

## Access control

Restrict to specific roles or channels:

```yaml
discord:
  token: "..."
  clientId: "..."
  allowedRoleIds:
    - "1234567890123456789"   # role ID
  allowedChannelIds:
    - "9876543210987654321"   # channel ID
```

## Streaming responses

Discord doesn't support true streaming, but the adapter simulates it by editing messages as text accumulates. The bot shows a "thinking..." indicator while generating.

## Threads

For long responses, the adapter can automatically create a thread:

```yaml
discord:
  token: "..."
  clientId: "..."
  useThreads: true            # create a thread for each conversation
  threadAutoArchive: 60       # archive after 60 minutes of inactivity
```

## Sessions

| Context | Session key |
|---|---|
| Server channel | `discord:<channel-id>` |
| Thread | `discord:<thread-id>` |
| DM | `discord:<user-id>` |

## Permissions required

The bot needs these Discord permissions:

- `Send Messages`
- `Read Message History`
- `Add Reactions` (for thinking indicator)
- `Embed Links` (for formatted responses)
- `Create Public Threads` (if `useThreads: true`)
- `Use Application Commands`

## Deployment

Deploy the same way as any Ethos adapter — see the [Deploy a Telegram Agent](../guides/deploy-telegram-agent) guide for the PM2 pattern (it applies to Discord too).
