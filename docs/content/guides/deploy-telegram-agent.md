---
sidebar_position: 1
title: Deploy a Telegram Agent
---

# Deploy a Telegram Agent

This guide walks you through running an Ethos agent as a Telegram bot — from creating the bot token to keeping it alive on a VPS.

## Prerequisites

- Ethos CLI installed and working (`pnpm dev` runs the chat)
- A server or VPS (Ubuntu 22.04+, 512MB RAM minimum)
- Node 24 on the server

## 1. Create a Telegram bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** — you'll need it in step 3

## 2. Install the Telegram extension

```bash
pnpm add @ethosagent/telegram
```

Or if you're using the monorepo:

```bash
pnpm --filter @ethosagent/cli add @ethosagent/telegram
```

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
pnpm dev --adapter telegram
```

Open Telegram, find your bot, and send `/start`. You should see a response.

## 5. Choose a personality

To run your Telegram bot with a specific personality:

```yaml
personality: researcher   # or engineer, coach, etc.
```

Or set it per-session with `/personality researcher` in the chat.

## 6. Deploy to a VPS

### Install dependencies

```bash
# On the server
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm pm2
```

### Copy your config

```bash
scp ~/.ethos/config.yaml user@yourserver:~/.ethos/config.yaml
```

Set your API keys as environment variables in `~/.ethos/config.yaml` or as system env vars.

### Start with PM2

```bash
# Clone the repo on the server
git clone https://github.com/MiteshSharma/ethos.git
cd ethos
pnpm install

# Start the Telegram adapter
pm2 start "pnpm dev --adapter telegram" --name ethos-telegram
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
