---
sidebar_position: 5
title: Run as a Daemon
---

# Run as a Daemon

How to keep `ethos` running in the background so users can DM your agent on Telegram, Slack, Discord, WhatsApp, or email without you keeping a terminal open.

This guide focuses on `ethos gateway start` — the multi-platform message gateway — but the same techniques work for any long-running `ethos` command (`cron`, `serve`, `acp`).

---

## Quick decision

| Your situation | Use |
|---|---|
| macOS — single user, just want it to come back after reboot | **launchd** |
| Linux server / Raspberry Pi / VPS | **systemd user unit** |
| Cross-platform, want a familiar process manager | **pm2** |
| Just testing for an afternoon | **tmux / screen** |
| Production multi-tenant, want zero-downtime deploys | **PM2 cluster** or roll your own — out of scope here |

---

## What can run as a daemon?

`ethos` has four long-running commands. Everything else is one-shot.

| Command | What it serves | Long-running? |
|---|---|---|
| `ethos gateway start` | Telegram / Slack / Discord / WhatsApp / Email bots | ✅ |
| `ethos cron` | Scheduled jobs worker | ✅ |
| `ethos serve` *(in development)* | Web UI + API on `:3000` | ✅ |
| `ethos acp` | Agent Control Protocol (mesh) server | ✅ |
| `ethos chat`, `setup`, `batch`, `eval`, `plugin`, `skills`, `keys`, `claw`, `upgrade`, `personality`, `memory`, `evolve` | One-shot or REPL | ❌ |

This guide uses `ethos gateway start` as the canonical example. Substitute any of the others freely.

---

## Pre-flight check (do this first)

Daemons fail silently. Before wrapping `ethos` in a service manager, prove it works in a foreground shell.

```bash
# 1. Make sure your gateway platforms are configured
ethos gateway setup            # interactive — Telegram bot token

# 2. Or hand-edit ~/.ethos/config.yaml (see Platforms docs for shape)

# 3. Run it in the foreground
ethos gateway start

# 4. Send a message to your bot from Telegram / Slack / Discord
#    → confirm it replies
# 5. Ctrl+C to stop
```

If foreground doesn't work, the daemon won't either. Fix the config first.

---

## Option 1 — macOS (launchd)

`launchd` is built into macOS. No extra install. The unit file lives in `~/Library/LaunchAgents/`.

### Create the plist

`~/Library/LaunchAgents/ai.ethosagent.gateway.plist`:

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
    <string>/usr/local/bin/ethos</string>
    <string>gateway</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOUR_USERNAME</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USERNAME</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/gateway.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/gateway.err.log</string>
</dict>
</plist>
```

> **Replace `YOUR_USERNAME`** with your macOS login (run `whoami`). Check `which ethos` — if you installed via nvm-managed Node, the binary lives at `~/.nvm/versions/node/v24.x.x/bin/ethos`, not `/usr/local/bin/ethos`. Use the full path.

### Load and start

```bash
launchctl load ~/Library/LaunchAgents/ai.ethosagent.gateway.plist
launchctl start ai.ethosagent.gateway

# Check it's running
launchctl list | grep ethosagent

# Tail logs
tail -f ~/.ethos/logs/gateway.out.log
```

### Stop / unload / reload

```bash
launchctl stop ai.ethosagent.gateway
launchctl unload ~/Library/LaunchAgents/ai.ethosagent.gateway.plist

# After editing the plist, unload + load again to apply
```

### Auto-start at login

`RunAtLoad` + the file's location in `~/Library/LaunchAgents/` is enough — `launchd` starts the agent at login. `KeepAlive` restarts it if it crashes.

---

## Option 2 — Linux (systemd user unit)

`systemd` user units live in `~/.config/systemd/user/`. They run as your login user, not root — perfect for a personal bot.

### Create the unit

`~/.config/systemd/user/ethos-gateway.service`:

```ini
[Unit]
Description=Ethos gateway (Telegram/Slack/Discord/WhatsApp/Email)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ethos gateway start
Restart=on-failure
RestartSec=5
StandardOutput=append:%h/.ethos/logs/gateway.out.log
StandardError=append:%h/.ethos/logs/gateway.err.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

> **Check `which ethos`** — if you used nvm, the path is `/home/YOUR_USER/.nvm/versions/node/v24.x.x/bin/ethos`. Hardcode it in `ExecStart`. systemd runs without your shell's PATH, so `ethos` alone won't resolve.

### Enable, start, status

```bash
systemctl --user daemon-reload
systemctl --user enable --now ethos-gateway.service

# Status
systemctl --user status ethos-gateway

# Live logs
journalctl --user -u ethos-gateway -f

# Or tail the file logs
tail -f ~/.ethos/logs/gateway.out.log
```

### Survive logout (for headless servers)

By default, user units stop when you log out. To make them persist across SSH sessions:

```bash
sudo loginctl enable-linger $USER
```

Now the gateway runs even when you're not logged in.

### Stop / restart / disable

```bash
systemctl --user restart ethos-gateway
systemctl --user stop ethos-gateway
systemctl --user disable ethos-gateway
```

---

## Option 3 — pm2 (cross-platform)

[PM2](https://pm2.keymetrics.io) is a Node.js process manager. Works the same on macOS, Linux, and Windows. Comes with built-in log rotation, auto-restart, and a `pm2 startup` command that wires into launchd / systemd / Windows Service Manager for you.

### Install

```bash
npm install -g pm2
```

### Start the gateway under pm2

```bash
pm2 start ethos --name ethos-gateway -- gateway start

# Confirm
pm2 list

# Tail logs
pm2 logs ethos-gateway
```

The `--` separates pm2's own flags from the args passed to `ethos`. Anything after `--` becomes `process.argv` for ethos.

### Survive reboots

```bash
pm2 startup       # generates the system service install command — run what it prints
pm2 save          # snapshot the current process list
```

After this, `pm2 resurrect` runs at boot and brings your processes back.

### Common pm2 commands

```bash
pm2 restart ethos-gateway     # restart
pm2 stop ethos-gateway        # stop (still managed)
pm2 delete ethos-gateway      # forget about it
pm2 monit                     # live dashboard (CPU + memory)
pm2 logs ethos-gateway --lines 200
```

### Multiple ethos processes under pm2

You can run several long-running ethos commands side by side:

```bash
pm2 start ethos --name ethos-gateway -- gateway start
pm2 start ethos --name ethos-cron    -- cron worker     # cron worker mode
pm2 start ethos --name ethos-serve   -- serve --port 3000
pm2 save
```

Or use a [pm2 ecosystem file](https://pm2.keymetrics.io/docs/usage/application-declaration/) (`ecosystem.config.js`):

```javascript
module.exports = {
  apps: [
    { name: 'ethos-gateway', script: 'ethos', args: 'gateway start' },
    { name: 'ethos-cron',    script: 'ethos', args: 'cron worker' },
    { name: 'ethos-serve',   script: 'ethos', args: 'serve --port 3000' },
  ],
};
```

```bash
pm2 start ecosystem.config.js
```

---

## Option 4 — tmux / screen (lightweight, no auto-restart)

Useful for testing on a remote box without bothering with service managers. **Does not survive reboots and does not restart on crash** — only use this for a quick "let me leave this running for the afternoon" scenario.

### tmux

```bash
tmux new -s ethos
ethos gateway start
# Ctrl+B then D — detaches, leaves it running

# Reattach later
tmux attach -t ethos
```

### screen

```bash
screen -S ethos
ethos gateway start
# Ctrl+A then D — detaches

screen -r ethos    # reattach
```

For anything you actually depend on, use launchd / systemd / pm2.

---

## Logs

Where logs land depends on which service manager you used:

| Manager | Default log location |
|---|---|
| launchd | Wherever you set `StandardOutPath` / `StandardErrorPath` in the plist (this guide uses `~/.ethos/logs/gateway.{out,err}.log`) |
| systemd | journald — `journalctl --user -u ethos-gateway`; also `~/.ethos/logs/gateway.{out,err}.log` if you set `StandardOutput=append:` |
| pm2 | `~/.pm2/logs/ethos-gateway-out.log` + `-error.log`. View with `pm2 logs` |
| tmux/screen | Whatever's in your scrollback — not persisted |

Ethos itself writes structured logs to `~/.ethos/logs/` in addition to stdout/stderr. Inspect with:

```bash
ls ~/.ethos/logs/
tail -f ~/.ethos/logs/gateway.out.log
```

For long-term retention, configure log rotation. PM2 has [`pm2-logrotate`](https://github.com/keymetrics/pm2-logrotate); on Linux, `logrotate` handles file rotation natively.

---

## Updating the daemon

When a new `@ethosagent/cli` ships:

```bash
# 1. Upgrade the binary in-place
ethos upgrade

# 2. Restart the daemon to pick up the new code
launchctl stop ai.ethosagent.gateway && launchctl start ai.ethosagent.gateway   # macOS
systemctl --user restart ethos-gateway                                          # Linux
pm2 restart ethos-gateway                                                       # pm2
```

Always restart after `ethos upgrade` — the running process keeps the old binary loaded in memory until restarted.

---

## Health checks

A simple liveness check: send your bot a message and confirm a reply within 10 seconds. For automated monitoring:

```bash
# Is the process running?
launchctl list | grep ai.ethosagent       # macOS
systemctl --user is-active ethos-gateway  # Linux — exits 0 if active
pm2 jlist | jq '.[] | .name'              # pm2

# Did it crash recently?
tail -50 ~/.ethos/logs/gateway.err.log

# Is Telegram getting our long-poll requests?
tail -f ~/.ethos/logs/gateway.out.log     # look for "platform=telegram heartbeat"
```

For external monitoring, point [Healthchecks.io](https://healthchecks.io), Uptime Kuma, or a `cron` ping at a small wrapper script that checks `systemctl --user is-active` (or equivalent) and curls a heartbeat URL on success.

---

## Troubleshooting

**Daemon starts but bot doesn't respond.** Foreground-test the same config first: `ethos gateway start`. If foreground works and daemon doesn't, almost always a PATH or HOME env-var issue — daemons run with a stripped environment. Hardcode the full path to `ethos` and set `HOME` explicitly in the unit file.

**`ethos: command not found` in launchd/systemd logs.** Service managers don't source your shell rc. If you installed via nvm, `ethos` lives at `~/.nvm/versions/node/v24.x.x/bin/ethos`. Use that absolute path in `ProgramArguments` / `ExecStart`.

**Crashes immediately, "Run ethos setup first" in the log.** The daemon's `HOME` doesn't point at your user. systemd user units inherit `HOME` correctly; launchd sometimes doesn't — set `HOME` in the plist's `EnvironmentVariables` block (this guide does).

**API rate-limit errors (Telegram 429).** You're running multiple gateway processes against the same bot token. Check for duplicate launchd plists, double-registered pm2 entries, or a forgotten `tmux` session. One process per bot token.

**Daemon stops on logout (Linux).** `loginctl enable-linger $USER` once. Without it, systemd tears down user units when the last login session ends.

**Memory grows unbounded.** Check `pm2 monit` or `top -p $(pgrep -f "ethos gateway")`. If it climbs steadily over hours, it's likely a leak — file an issue with a `node --inspect` heap snapshot. Short-term: pm2 has `--max-memory-restart 500M` to auto-restart at a threshold.

---

## See also

- [Platforms overview](../platforms/overview) — how each platform adapter works
- [Deploy a Telegram agent](./deploy-telegram-agent) — end-to-end Telegram setup
- [CLI Reference → gateway](../cli-reference#gateway) — flags and config for `ethos gateway`
- [Troubleshooting](../troubleshooting) — common config errors
