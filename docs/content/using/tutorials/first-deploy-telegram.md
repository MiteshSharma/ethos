---
title: "Deploy your first Telegram agent"
description: "Zero to a Telegram bot replying in production: bot token, gateway setup, channel adapter config, daemon under launchd or systemd."
kind: tutorial
audience: user
slug: first-deploy-telegram
time: "30 min"
updated: 2026-09-05
---

Your [personality](../../getting-started/glossary.md#personality) runs locally in `ethos chat`. This tutorial puts it in front of real users on Telegram. The path is: create a bot, paste its token, foreground-test the gateway, then wrap it in a service manager that survives reboots.

## Goal

By the end, you have:

- A Telegram bot created through BotFather with a token in `~/.ethos/config.yaml`.
- The Ethos [gateway](../../getting-started/glossary.md#gateway) running in the foreground and replying to messages on Telegram.
- The same gateway running as a daemon under `launchd` (macOS) or `systemd` (Linux), restarting on crash and after reboot.
- An access list so only you (and people you name) can DM the bot — using the pairing-code flow.
- A short troubleshooting cheat sheet for the daemon-vs-foreground failures you will eventually hit.

The bot answers as whatever personality you set in [Create your first personality](./first-personality.md) — or as one of the built-ins if you skipped that tutorial.

## Prereqs

- [Build your first agent](./first-agent.md) finished — `ethos chat` reaches the provider locally and replies stream in real time.
- A Telegram account.
- A box that stays online: your laptop is fine while you test; a VPS or always-on home server is the production target.
- Network egress to `api.telegram.org` and to your LLM provider. Both use plain HTTPS.

## 1. Create the bot

Telegram bots are created through a conversation with `@BotFather` inside Telegram itself.

1. Open Telegram and search for `@BotFather`. Start a chat.
2. Send `/newbot`.
3. Pick a human-readable name (`My Strategist Bot`).
4. Pick a unique username ending in `bot` (`my_strategist_bot`).
5. BotFather replies with the **HTTP API token** — a string like `123456789:ABCdefGhIJklmNopQRstuVwxYZ`. Copy it. Anyone with this token can speak as your bot, so treat it like a password.

While you are still in BotFather, two settings are worth confirming for a personal bot:

- `/setprivacy` for your bot, then **Enable**. Privacy mode means the bot only sees messages addressed to it directly or sent as a reply. This is what you want for a personal bot. If you later want the bot to read a group's ordinary chatter, disabling it here is not enough on its own — Telegram fixes the setting per group when the bot joins, so you also remove and re-add the bot to that group. [Platform prerequisites for group messages](../../platforms/telegram.md#3b-platform-prerequisites-for-group-messages) has the full sequence and the `getMe` check that confirms it took.
- `/setdescription` and `/setabouttext` are cosmetic but appear in Telegram's bot card — set them to something honest.

You can regenerate the token any time with `/token` in BotFather; the old token is invalidated immediately, so do this if you ever leak the value.

## 2. Configure the [channel adapter](../../getting-started/glossary.md#channel-adapter)

Ethos ships a Telegram adapter inside `@ethosagent/cli` — no extra install. The `ethos gateway setup` command writes the token into `~/.ethos/config.yaml` for you and validates the token against Telegram's `getMe` endpoint.

:::tip Fast path — validate and launch in one pass
If you are setting up from scratch, run `ethos setup` instead. Its messaging step validates the token the same way (`✓ Connected · @my_strategist_bot`), and when a channel validates the closing prompt offers three choices — **Start the Telegram bot now** / **Open chat instead** / **Done**. Pick the first and the wizard brings the bot up immediately:

```
Starting the Telegram bot…
✓ @my_strategist_bot is live — message it: t.me/my_strategist_bot
Ctrl+C stops the bot. Run 'ethos gateway start' to restart it.
```

That gets you a replying bot in one command. This tutorial continues past that first reply to wire the bot for production — a durable access list and a daemon that survives reboots.
:::

```bash
ethos gateway setup
```

Paste the token at the prompt. Expected output:

```
Validating token...
✓ Bot validated: @my_strategist_bot
✓ Token saved to ~/.ethos/config.yaml
```

If validation fails, the token is wrong — re-run `/newbot` or `/token` in BotFather and try again.

Open `~/.ethos/config.yaml` and verify the line landed:

```bash
grep telegramToken ~/.ethos/config.yaml
```

You should see `telegramToken: 123456789:ABC...`.

If you prefer to hand-edit, the same effect is one line:

```yaml
telegramToken: "123456789:ABCdefGhIJklmNopQRstuVwxYZ"
```

The gateway reads exactly that field on startup. Anything before `:` is the numeric bot id (informational); everything after is the secret. Do not commit this file to a public repo — `~/.ethos/config.yaml` belongs in `.gitignore` for any directory you share.

## 3. Foreground-test before daemonising

Daemons fail silently. Before wrapping the gateway in a service manager, run it in the foreground from a normal shell and prove the bot replies. This is the most important step in the tutorial — fix every error here, not after.

```bash
ethos gateway start
```

Expected boot sequence:

```
ethos gateway  starting...
Runs in the foreground. For always-on production, see https://ethosagent.ai/docs/using/how-to/run-as-daemon ...
Cron scheduler running (checks every 60s)
✓ Telegram online (412ms)
Listening for messages. Press Ctrl+C to stop.
```

Now message your bot from Telegram. Search for its username, send `Hello`. The bot should reply within a few seconds with the active personality's voice.

If it does not:

- **No `✓ Telegram online`** — the token is wrong, or the box cannot reach `api.telegram.org`. Test with `curl https://api.telegram.org/bot$YOUR_TOKEN/getMe` — a working token returns JSON with `"ok":true` and the bot's username.
- **Boot but no reply** — your provider API key is wrong. Foreground errors print to stderr; scroll up. Run `ethos chat` separately to confirm the CLI side still works.
- **`No platform configured`** — the token did not land in the config file. Re-run `ethos gateway setup`.
- **Bot replies once, then nothing** — you have two gateways running against the same token. Kill the duplicate; Telegram drops long-poll requests beyond the first.
- **Bot replies with an error tool result** — your personality's `toolset.yaml` allows a tool whose backing service is misconfigured. Switch to `researcher` (default toolset works out of the box) to confirm it is configuration and not infrastructure.

Stop the foreground process with `Ctrl+C` when the bot is replying. Telegram queues incoming messages for several hours, so a brief downtime during the daemon switch does not drop messages.

## 4. Pick which personality the bot uses

The gateway runs one personality per bot. It uses the `personality` field in `~/.ethos/config.yaml` by default — whatever you picked during `ethos setup`. To change it, either edit the file:

```yaml
personality: strategist
```

…or use the CLI:

```bash
ethos personality set strategist
```

The bot you ship is the personality you picked. If you want a different personality on Telegram than in the CLI, the cleanest path is `ethos personality duplicate strategist strategist-tg` and then set `personality: strategist-tg`. They share an id space but are otherwise independent files — you can tighten Telegram's [toolset](../../getting-started/glossary.md#tool) (no `terminal`, no `write_file`) without affecting the CLI version.

Two other places personality routing comes up:

- The personality config's `platform: telegram` field binds the personality to the Telegram ingress. The gateway uses this hint to pick the right personality when multiple are configured; for a single-bot deployment, it is informational.
- The pairing-code flow in step 5 carries the personality id on approval, so future messages from that sender route correctly.

## 5. Restrict who can DM the bot

By default, the bot replies to anyone who messages it. For a personal bot this is wrong. The gateway implements a **pairing-code** flow: a remote user sends a DM, the gateway generates a one-time code, and you accept the pairing from your CLI before that user's future messages are processed.

Start the gateway in the foreground again (`ethos gateway start`) and DM the bot from a Telegram account other than yours (or from the same account — both work). Open a separate terminal and run `ethos chat`. Inside chat:

```
/communications
```

You see a pending pairing code, something like:

```
Pending (1):
  telegram 1234567 7H3K-9XQ2  "Hello"
```

Approve the sender:

```
/allow 7H3K-9XQ2
```

The gateway emits a confirmation. The remote user's next message lands as expected.

Revoke later:

```
/deny telegram 1234567
```

The pairing list lives in `~/.ethos/communications.json`. Hand-editing is supported but discouraged — the `/allow` and `/deny` slash commands keep it consistent with the in-memory cache.

If you want to skip the pairing flow entirely (single-user bot for yourself), DM the bot from your own account and `/allow` your own pairing code once. Subsequent runs of the gateway remember the approval — the JSON file is the source of truth.

For a group chat, add the bot to a Telegram group and approve the group's chat id rather than individual senders. Group chat ids are negative numbers; you can read them out of `/communications` or by tailing the gateway log when the bot is added.

## 6. Wrap it in a daemon

Foreground works. Time to keep it running. Pick the manager that matches your platform.

### macOS — `launchd`

`launchd` ships with macOS. Unit files (plists) live in `~/Library/LaunchAgents/`. Find your `ethos` binary and your home directory first:

```bash
which ethos
echo $HOME
```

Common cases:

- Installed via the recommended script with `nvm` — `~/.nvm/versions/node/v24.x.x/bin/ethos`.
- Installed via system `npm` — `/usr/local/bin/ethos` or `/opt/homebrew/bin/ethos`.

`launchd` runs without your shell's `PATH`, so use the absolute path you printed. The same applies to `HOME` — set it explicitly.

Create `~/Library/LaunchAgents/ai.ethosagent.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ethosagent.gateway</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.nvm/versions/node/v24.0.0/bin/ethos</string>
    <string>gateway</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOU/.nvm/versions/node/v24.0.0/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOU</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/YOU</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOU/.ethos/logs/gateway.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/YOU/.ethos/logs/gateway.err.log</string>
</dict>
</plist>
```

Replace `YOU` with the output of `whoami`. Load and start:

```bash
launchctl load ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
launchctl start ai.ethosagent.gateway
```

Tail the logs to confirm it boots:

```bash
tail -f ~/.ethos/logs/gateway.out.log
```

You should see the same `✓ Telegram online` line you saw in the foreground. DM the bot to confirm.

To stop, reload after editing, or remove:

```bash
launchctl stop ai.ethosagent.gateway
launchctl unload ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
launchctl load ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
```

`RunAtLoad` plus the file's location in `~/Library/LaunchAgents/` is enough to start the gateway on login. `KeepAlive` restarts it on crash.

### Linux — `systemd` user unit

`systemd` user units live in `~/.config/systemd/user/`. They run as your login user, not root — appropriate for a personal bot. Find the binary first:

```bash
which ethos
```

Create `~/.config/systemd/user/ethos-gateway.service`:

```ini
[Unit]
Description=Ethos gateway (Telegram)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/YOU/.nvm/versions/node/v24.0.0/bin/ethos gateway start
Restart=on-failure
RestartSec=5
StandardOutput=append:%h/.ethos/logs/gateway.out.log
StandardError=append:%h/.ethos/logs/gateway.err.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Replace the `ExecStart` path with the output of `which ethos` (it must be absolute — `systemd` does not source your shell rc, so bare `ethos` does not resolve).

Enable, start, status:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ethos-gateway.service
systemctl --user status ethos-gateway
```

Watch logs live:

```bash
journalctl --user -u ethos-gateway -f
```

For a server you SSH into, user units stop when your login session ends by default. Make them persist:

```bash
sudo loginctl enable-linger $USER
```

Restart, stop, disable:

```bash
systemctl --user restart ethos-gateway
systemctl --user stop ethos-gateway
systemctl --user disable ethos-gateway
```

For more daemon options — `pm2`, Docker, plain `nohup` — see [Run Ethos as a daemon](../how-to/run-as-daemon.md). `launchd` and `systemd` are enough for one bot.

## 7. Send the first production message

From Telegram, DM your bot. You should see a reply within a few seconds. Three things are happening:

1. The Telegram adapter polls Telegram for new updates (long-polling, no webhook required).
2. The gateway routes the inbound `InboundMessage` to `AgentLoop.run()` with `sessionKey: telegram:<chatId>` and `personalityId: <your-personality>`.
3. The streamed `AgentEvent` output is reflowed into Telegram messages (one per 4,096-character chunk; later edits update the same message id rather than appending new ones).

The bot's [session](../../getting-started/glossary.md#session) is independent from your CLI session — each Telegram chat has its own session key. Your CLI conversation history is untouched, and vice versa. They do share `MEMORY.md` if (and only if) the personality's `memoryScope` is `global`.

The outbound deduplication cache is keyed by `(sessionId, sha256(content))` with a 30-second TTL. If the agent emits the same message twice in quick succession (a streaming retry, for example), Telegram only sees the first. This is automatic; adapters do not roll their own deduplication. If you ever see the bot ignore a message you sent twice on purpose, that is the same gate firing — wait 30 seconds and try again.

## 8. Operate it

A few commands worth knowing once the bot is running.

**Is it actually running?**

```bash
launchctl list | grep ai.ethosagent           # macOS
systemctl --user is-active ethos-gateway      # Linux — exits 0 if active
```

**Where are the logs?**

```bash
tail -f ~/.ethos/logs/gateway.out.log
```

Ethos writes structured logs to `~/.ethos/logs/` on top of stdout. The service manager's logs are a superset — `launchd` writes the file directly per the plist; `systemd` writes to `journalctl` and also to the file because of the `StandardOutput=append:` directive.

**Reading recent errors:**

```bash
ethos errors                    # last 50 errors with cause and action
```

The `errors` command reads `~/.ethos/logs/errors.jsonl` — every `EthosError` envelope produced by the CLI or the gateway lands there.

**Updating the bot:**

```bash
ethos upgrade
launchctl stop ai.ethosagent.gateway && launchctl start ai.ethosagent.gateway   # macOS
systemctl --user restart ethos-gateway                                          # Linux
```

Always restart after upgrade — the running daemon keeps the old binary in memory until restarted.

**Reading the bot's session history:**

Inside `ethos chat`, the bot's per-chat sessions are visible through SQLite. The TUI's `/sessions` modal lists them; from outside, the database file is `~/.ethos/sessions.db` (WAL + FTS5).

## 9. Troubleshooting the common cases

**Daemon starts but bot does not reply.** Foreground-test the same config: `ethos gateway start`. If foreground works and daemon does not, it is almost always `PATH` or `HOME`. Use absolute paths in the unit file and set `HOME` explicitly.

**`ethos: command not found` in daemon logs.** Service managers do not source your shell rc. If you installed via `nvm`, `ethos` lives under `~/.nvm/versions/node/...`. Use that absolute path in `ProgramArguments` / `ExecStart`. `which ethos` from a shell where chat works prints exactly the path you want.

**Daemon log says `Run ethos setup first`.** The daemon's `HOME` does not point at your user. `systemd` user units inherit this; `launchd` sometimes does not — set `HOME` in the plist's `EnvironmentVariables`.

**Telegram returns 429 (rate limit).** Two gateways are running against the same bot token. Check for a duplicate plist, a forgotten `tmux` session, or a still-running foreground process. One gateway per token. Telegram's rate limit is 30 messages per second per bot; you only hit this with a real conversation flood, so 429 in normal operation almost always means duplication.

**Bot replies are slow.** The first turn loads memory and starts the LLM stream — expect 1–2 seconds before the first chunk arrives. Steady-state should be sub-second per chunk. If every reply takes 10+ seconds, the model picked is slow (Opus is heavier than Sonnet) or the provider is throttling.

**Memory grows unbounded.** Long-running daemons accumulate per-session state. The session store evicts on its own retention TTLs (see `retention.messages` in [config.yaml](../reference/config-yaml.md#retention)); if RSS climbs steadily, file an issue with a heap snapshot.

**Bot crashes and `KeepAlive` / `Restart=on-failure` flaps.** Look at the error log first. Repeated boot failures usually mean a misconfiguration the service manager keeps retrying through. Disable the service, fix the config, re-enable. Hot-looping a broken config wastes CPU and floods Telegram with reconnects.

**I want webhooks instead of long-polling.** Long-polling needs no public URL and works behind any NAT. Webhooks need a domain with TLS. The current adapter only supports long-polling; this is on the roadmap.

**Two bots, one box.** Run two gateways with two `~/.ethos/` directories. Set `HOME` to a different path in each unit file. The two configs, two SQLite databases, and two log directories stay separate.

## What you learned

- A Telegram bot is two artifacts: a token from BotFather, and the gateway running with that token configured.
- The gateway is a separate process from `ethos chat` — both can run in parallel against the same SQLite store.
- The Telegram adapter polls Telegram's long-poll endpoint; no domain or TLS is required.
- The pairing-code flow (`/communications`, `/allow`, `/deny`) is the access list — one approval per sender, kept in `~/.ethos/communications.json`.
- Wrapping the gateway in `launchd` or `systemd` is what turns "running in a shell" into "running in production." Use absolute paths; set `HOME` explicitly.
- `ethos upgrade` plus a service restart is the deploy loop.
- Outbound dedup is in the gateway, not the adapter; the same `(sessionId, content)` does not get sent twice within 30 seconds.

## Next step

You have one Telegram personality replying to messages. Two natural next steps:

- [Run Ethos as a daemon](../how-to/run-as-daemon.md) — the full reference for `launchd`, `systemd`, `pm2`, plus tmux and screen for short-lived tests.
- [Deploy on Telegram](../../platforms/telegram.md) — bot mentions, group chats, rate limits, multi-workspace.
- [Configure providers](../how-to/configure-providers.md) — set up fallback chains so a single rate-limited provider does not take the bot offline.
- [Glossary](../../getting-started/glossary.md) — `channel adapter`, `gateway`, `session`, every term used here.
