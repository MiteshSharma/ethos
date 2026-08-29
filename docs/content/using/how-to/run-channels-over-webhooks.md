---
title: "Receive Slack and Telegram events over webhooks"
description: "Move a Slack app to the HTTP Events API and a Telegram bot to webhook delivery, including the manual Slack Request URL step no code can automate."
kind: how-to
audience: user
slug: run-channels-over-webhooks
time: "20 min"
updated: 2026-08-28
---

## Task

Move a Slack app off Socket Mode and a Telegram bot off long-polling, so both platforms **push** inbound events to an HTTP endpoint your [gateway](../../getting-started/glossary.md#gateway) (the runtime layer that routes platform messages to the right agent loop) hosts.

## Result

- A single `node:http` listener answers `/telegram/webhook/<bot-key>` and `/slack/events/<bot-key>` for every bot configured in webhook or HTTP mode.
- Telegram registration is automatic — Ethos calls `setWebhook()` at startup.
- Slack registration is **manual** — you paste the Request URL into the Slack app dashboard yourself, and the verification challenge is answered for you.
- Bots you do not switch keep long-polling and Socket Mode, unchanged.

## Why you would do this

A process holding a Socket Mode WebSocket or a Telegram `getUpdates` long-poll can never be idle: the connection *is* the delivery mechanism, so pausing the process or scaling it to zero drops messages on the floor. Webhook delivery inverts that — the platform holds the message and posts it to a host that only needs to be reachable, not connected.

If the host cannot receive inbound connections at all — a laptop behind NAT, a dev box on a coffee-shop network — this does not apply to you. Stay on long-poll and Socket Mode.

## Prereqs

- A gateway that already works on the platform you are switching. Get [Telegram](../../platforms/telegram.md) or [Slack](../../platforms/slack.md) running on the default transport first; a webhook migration is a bad place to debug a scope or a token.
- A public hostname with a TLS certificate, and a reverse proxy in front of the gateway. Both platforms refuse plain `http://` endpoints.
- The `bot-key` of each bot you are switching (see step 2).

## Steps

### 1. Put a TLS-terminating proxy in front

The listener is plain `node:http` by design, and binds `127.0.0.1` by default. It performs no TLS and no authentication of its own — each platform verifies itself against its own per-bot secret one frame deeper (grammy compares the secret token, Bolt checks the HMAC signature). Terminating TLS is your job.

| Environment variable | Default | Effect |
|---|---|---|
| `ETHOS_PLATFORM_WEBHOOK_PORT` | `3006` | Port the platform listener binds. |
| `ETHOS_SERVE_HOST` | `127.0.0.1` | Bind address, shared with the gateway's other listeners. A non-loopback value logs a plaintext-HTTP warning. |

This is one more listener alongside the ones the gateway process already binds — `3002` health, `3003` the generic `config.webhooks` server, `3005` SIP. `3004` belongs to `ethos run-all`'s health endpoint, and `run-all` spawns the gateway, which is why the platform listener sits at `3006`.

With Caddy:

```
bots.example.com {
  reverse_proxy 127.0.0.1:3006
}
```

Leave the paths untouched — do not strip a prefix. Slack's receiver matches its endpoint list exactly, and a rewritten path 404s silently.

### 2. Find each bot's key

The route segment is the bot's `botKey`: the `id` you set in config, or the first 24 characters of `sha256` over the bot token when you did not.

```bash
grep -E '^(telegram\.bots|slack\.apps)\.[0-9]+\.id:' ~/.ethos/config.yaml
```

```
telegram.bots.0.id: researcher-bot
slack.apps.0.id: eng-slack
```

Empty output means no bot sets one — add an `id` line per bot before going further. A derived key is stable, but it is also 24 hex characters you will be pasting into a Slack dashboard by hand.

Set it once. Changing a bot's `id` after it goes live orphans its session history and invalidates the URL you registered.

### 3. Switch a Telegram bot to webhook mode

```yaml
telegram.bots.0.useWebhook: true
telegram.bots.0.webhookUrl: "https://bots.example.com/telegram/webhook/researcher-bot"
telegram.bots.0.webhookSecretToken: "${secrets:telegram/bots/researcher-bot/webhookSecretToken}"
```

Three things about that block:

- **`webhookUrl` is the full public URL, path included.** The listener routes on `/telegram/webhook/<bot-key>` because a Telegram `Update` payload carries no field saying which bot it belongs to — the path is the only thing that selects the right bot, and therefore the right secret, before anything is parsed. A URL that omits the path reaches no handler.
- **`webhookSecretToken` is required, not optional.** Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token` and grammy compares it before the update is processed. The adapter throws at startup when `useWebhook` is set without it, and throws again without `webhookUrl`.
- **It is a credential.** The secret externalizer treats it exactly like the bot token, so write it as a `${secrets:<ref>}` reference; a plaintext value here fails the config load the same way a plaintext token does.

No dashboard step follows. Ethos calls `setWebhook(webhookUrl, { secret_token })` when the adapter starts, and `deleteWebhook()` when it stops.

### 4. Switch a Slack app to HTTP mode

```yaml
slack.apps.0.mode.socket: false
slack.apps.0.mode.http: true
```

- **`mode.socket` and `mode.http` are mutually exclusive.** They are two transports for the same inbound event stream, not a hybrid — the adapter throws `mode.socket and mode.http are mutually exclusive` if both are `true`. Setting `mode.http` alone is not enough; `mode.socket` defaults to `true`, so you must turn it off explicitly.
- **`appToken` is only needed for Socket Mode.** In HTTP mode it is unused, and the config layer no longer requires it. In Socket Mode it is required, and the adapter throws without it.
- **`signingSecret` is where it finally does something.** Under Socket Mode it is carried but never exercised — a socket connection is authenticated by the app token and receives no HTTP requests to verify. Under `mode.http` it is the HMAC key every inbound request is checked against, and the adapter throws without it.

The route defaults to `/slack/events/<bot-key>`. Override just the segment with `webhookPath`:

```yaml
slack.apps.0.webhookPath: eng
# → /slack/events/eng
```

Restart the gateway before the next step. Slack sends its verification challenge the moment you save the URL, and the listener has to be up to answer it.

### 5. Set the Slack Request URL by hand

**Slack has no `setWebhook()` equivalent.** Nothing in Ethos can register this URL; it is a step in Slack's own dashboard and it is the one part of this page that is not config.

1. Open [api.slack.com/apps](https://api.slack.com/apps) and select your app.
2. Go to **Settings → Socket Mode** and turn **Enable Socket Mode** off. Slack hides the Request URL field while Socket Mode is on.
3. Go to **Features → Event Subscriptions** and turn **Enable Events** on.
4. Put your full public URL in **Request URL**:

   ```
   https://bots.example.com/slack/events/eng-slack
   ```

5. Slack immediately POSTs a `url_verification` challenge to that URL. Bolt's `HTTPReceiver` answers it on its own — you do nothing. The field turns to **Verified ✓** within a second or two.
6. Confirm the events under **Subscribe to bot events** survived the transport switch — `app_mention`, `message.im`, and whichever else your deployment uses. Save.

If the field does not verify, work the list in [Troubleshoot](#troubleshoot) below rather than retrying the save.

## Verify

Ask the router for a route that exists. Only `POST` is routed, so a `GET` against a live route is a 404 from the router itself — which is still proof the listener is up and reachable:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://bots.example.com/slack/events/eng-slack
```

```
404
```

A connection refused or a 502 means the proxy or the listener is down, not that the path is wrong.

Then send real traffic:

- **Telegram** — message the bot. `getWebhookInfo` from the Bot API should show your URL and a `pending_update_count` of `0`.
- **Slack** — `@mention` the bot in a channel it is in. The reply arrives exactly as it did on Socket Mode; nothing downstream of the transport changed.

## What does not change

Long-poll and Socket Mode remain first-class, permanent defaults. This is additive, never a migration:

- Every key on this page defaults to today's behaviour. `useWebhook` defaults to `false`; `mode.socket` defaults to `true`.
- A bot you do not touch keeps its transport. Webhook-mode and poll-mode bots run side by side in one process.
- **WhatsApp and Discord cannot do this at all.** Neither platform offers an inbound webhook path for a bot's message stream — that is a constraint of the platforms, not a gap in Ethos. Do not go looking for the config key.

## `dropPendingUpdates` and poll-mode bots

One footgun sits next door to this feature, and it applies only to Telegram bots that stay on **poll** mode.

```yaml
telegram.bots.0.dropPendingUpdates: false
```

Default `true`, which is exactly what the gateway did before this key existed. grammy calls `deleteWebhook({ drop_pending_updates })` on every `bot.start()`, so with the default, every restart — crash, deploy, supervisor respawn — silently discards whatever Telegram queued while the process was down.

Set it `false` on any poll-mode bot in a deployment that sleeps and wakes, so a restart after a sleep window does not wipe the backlog accumulated during it.

It does nothing in webhook mode: `bot.start()` is never called for a webhook-mode bot, so there is no `deleteWebhook` call to carry the flag.

## Troubleshoot

- **Slack shows `Your URL didn't respond with the value of the challenge parameter`.** Most often the gateway was not running when you saved. Restart it and press **Retry**. Otherwise: the proxy is stripping the path prefix (the receiver matches its endpoint exactly), or the URL segment does not match the bot's `webhookPath`/`id`.
- **The URL verifies but no events arrive.** Check **Subscribe to bot events** is populated and the app was reinstalled to the workspace after the event list changed. Also confirm `mode.socket: false` — an app still connected over Socket Mode receives its events there.
- **`Slack adapter: mode.socket and mode.http are mutually exclusive` at startup.** You set `mode.http: true` and left `mode.socket` at its `true` default. Set it `false` explicitly.
- **`Slack adapter: signingSecret is required when mode.http is enabled`.** The signing secret is on the app's **Basic Information** page.
- **`Slack adapter: appToken is required when mode.socket is enabled (the default)`.** You removed the app token without turning `mode.socket` off.
- **`TelegramAdapter: useWebhook requires webhookUrl to be set`** or **`… requires webhookSecretToken for request verification`.** Both are required together; the adapter refuses to start on either alone.
- **Telegram's `getWebhookInfo` reports `last_error_message: Wrong response from the webhook: 404 Not Found`.** The path in `webhookUrl` does not match `/telegram/webhook/<bot-key>` for a bot actually in webhook mode.
- **`⚠ port 3006 in use — Telegram and Slack webhook deliveries will not be received.`** Something else holds the port. Set `ETHOS_PLATFORM_WEBHOOK_PORT`.
- **`bound to non-loopback host … over plaintext HTTP`.** You rebound `ETHOS_SERVE_HOST` off loopback without a proxy. Platform signatures and message bodies are crossing the network in cleartext. Put the proxy back, or bind to `127.0.0.1`.

## See also

- [`config.yaml` reference: `telegram.bots.*`](../reference/config-yaml.md#telegram-bots) — every Telegram key with its default
- [`config.yaml` reference: `slack.apps.*`](../reference/config-yaml.md#slack-apps) — every Slack key with its default
- [Slack adapter](../../platforms/slack.md) — scopes, routing, and the Socket Mode setup this page moves away from
- [Deploy Ethos in production](deploy-in-production.md) — reverse proxy, TLS, and process supervision
- [Run multiple bots from one Ethos process](run-multiple-bots.md) — where `botKey` comes from and what it keys
