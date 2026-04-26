---
sidebar_position: 3
title: Telegram
---

# Telegram Platform

The Telegram adapter runs your Ethos agent as a Telegram bot. It supports long-polling and webhooks, per-chat session isolation, streaming responses via message edits, and access control via allowlists.

## Installation

The Telegram adapter ships with the Ethos CLI. If you've already installed `@ethosagent/cli`, you don't need to install anything else — just enable it in your config.

## Configuration

Add to `~/.ethos/config.yaml`:

```yaml
adapters:
  - telegram

telegram:
  token: "YOUR_BOT_TOKEN"
```

Get a bot token from [@BotFather](https://t.me/BotFather) on Telegram.

## Access control

By default, any user can message your bot. Restrict access with an allowlist:

```yaml
telegram:
  token: "..."
  allowedUserIds:
    - 123456789      # your Telegram user ID
  allowedChatIds:
    - -1001234567890  # group chat ID (negative)
```

Find your user ID by messaging [@userinfobot](https://t.me/userinfobot).

## Commands

The adapter registers these bot commands automatically:

| Command | Description |
|---|---|
| `/start` | Start or resume your session |
| `/new` | Start a fresh conversation |
| `/personality <id>` | Switch personality |
| `/usage` | Show token usage for this session |
| `/help` | Show available commands |

## Streaming responses

The adapter streams responses by editing the in-progress message as text arrives. This gives users the "typing" experience even on slow responses.

Disable streaming (send final message only):

```yaml
telegram:
  token: "..."
  streaming: false
```

## Webhooks

Long-polling works out of the box. For lower latency and better reliability in production, use webhooks:

```yaml
telegram:
  token: "..."
  webhook:
    url: "https://yourdomain.com/telegram"
    port: 8443
    secretToken: "a-random-secret-string"
```

Webhooks require a domain with a valid TLS certificate. Telegram supports ports 443, 80, 88, and 8443.

## File uploads

When a user sends a photo or document:
- Photos are converted to base64 and passed to the LLM as vision input (requires a model that supports vision)
- Documents are downloaded and their text content is extracted

This requires no additional configuration for Claude models.

## Group chat behavior

In group chats, the bot only responds when:
1. Directly @mentioned (`@yourbotname what is...`)
2. Replying to a bot message
3. A `/command` is sent

This prevents the bot from responding to every message in active groups.

## Sessions

Each Telegram chat gets its own session:
- Private chats: session key is `telegram:<user-id>`
- Group chats: session key is `telegram:<chat-id>`

All members of a group share the same session history.

## Deployment

See the [Deploy a Telegram Agent](../guides/deploy-telegram-agent) guide for production deployment with PM2.
