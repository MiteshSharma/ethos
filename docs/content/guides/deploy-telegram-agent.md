---
sidebar_position: 1
title: Deploy a Telegram Agent
---

# Deploy a Telegram Agent

This guide walks you through running an Ethos agent as a Telegram bot — from creating the bot token to keeping it alive on a VPS.

## Prerequisites

- Ethos CLI installed and working (`ethos chat` runs locally)
- A server or VPS (Ubuntu 22.04+, 512MB RAM minimum)
- Node 24 on the server

## 1. Create a Telegram bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** — you'll need it in step 3

## 2. Enable the Telegram adapter

The Telegram adapter ships with `@ethosagent/cli` — no extra package install needed. You enable it by adding `telegram` to your config in step 3.

## 3. Configure `~/.ethos/config.yaml`

```yaml
provider: anthropic
model: claude-opus-4-7-20251101

adapters:
  - telegram

telegram:
  token: "YOUR_BOT_TOKEN_HERE"
  allowedUserIds:            # optional: restrict to specific users
    - 123456789
```

## 4. Test locally

```bash
ethos --adapter telegram
```

Open Telegram, find your bot, and send `/start`. You should see a response.

## 5. Choose a personality

To run your Telegram bot with a specific personality:

```yaml
personality: researcher   # or engineer, coach, etc.
```

Or set it per-session with `/personality researcher` in the chat.

## 6. Deploy to a VPS

### Install Ethos on the server

The fastest path is the same one-liner you used locally — it installs Node 24 (via nvm) and the CLI:

```bash
# On the server
curl -fsSL https://ethosagent.ai/install.sh | bash
npm install -g pm2
```

If you'd rather install Node manually:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g @ethosagent/cli pm2
```

### Copy your config

```bash
scp ~/.ethos/config.yaml user@yourserver:~/.ethos/config.yaml
```

Set your API keys as environment variables in `~/.ethos/config.yaml` or as system env vars.

### Start with PM2

```bash
pm2 start "ethos --adapter telegram" --name ethos-telegram
pm2 save
pm2 startup
```

PM2 restarts the bot automatically on crash and on server reboot.

### View logs

```bash
pm2 logs ethos-telegram
pm2 monit
```

## 7. Restrict access

By default, any Telegram user can message your bot. To restrict it:

**Option A: Allow list in config**

```yaml
telegram:
  token: "..."
  allowedUserIds:
    - 123456789   # your Telegram user ID
    - 987654321
```

Find your user ID by messaging `@userinfobot`.

**Option B: Private group only**

Create a Telegram group, add your bot, and restrict `allowedChatIds`:

```yaml
telegram:
  token: "..."
  allowedChatIds:
    - -1001234567890   # group chat ID (negative number)
```

## Troubleshooting

**Bot doesn't respond** — Check PM2 logs. The most common cause is an invalid bot token or missing `ANTHROPIC_API_KEY` env var.

**Responses are slow** — The Telegram adapter uses long-polling by default. For lower latency, switch to webhooks (requires a domain with TLS):

```yaml
telegram:
  token: "..."
  webhook:
    url: "https://yourdomain.com/telegram-webhook"
    port: 8443
```

**Rate limits** — Telegram allows 30 messages/second per bot. The adapter handles this automatically with an internal queue.
