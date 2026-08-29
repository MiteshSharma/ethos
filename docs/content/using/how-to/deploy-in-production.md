---
title: "Deploy Ethos in production"
description: "Run the gateway (bots) and web dashboard together on a mini PC, VPS, or home server. One supervised command; PM2 keeps it alive across reboots."
kind: how-to
audience: user
slug: deploy-in-production
time: "10 min"
updated: 2026-08-14
---

## Task

Run Ethos on an always-on machine — a mini PC, a Raspberry Pi 4+, a cheap VPS, a home server — so your Telegram and Slack bots stay online, the web dashboard is reachable, and the whole thing survives a power cut or a reboot. Operate it from your laptop via `ethos chat` when you want to drive it directly.

## Result

- Telegram + Slack + Discord + Email bots running under one supervisor.
- Web dashboard reachable at `http://<your-box>:3000`.
- ACP server reachable at `http://<your-box>:3001` for editor integrations.
- A crash in one surface doesn't take the others down; supervisor restarts the failed child automatically.
- Everything comes back after a reboot — no manual intervention.

## Prereqs

- A machine you can keep on: mini PC (Beelink, Mac mini, NUC), Raspberry Pi 4 with 4 GB+ RAM, a Linux VPS (Hetzner, Fly, DigitalOcean, etc.), or a Mac you don't shut down.
- Node 24+ installed (`node --version`).
- API keys for at least one [LLM provider](configure-providers.md) and one [channel](../../platforms/telegram.md) you want to expose.
- Network access from the box outbound (LLM APIs, Telegram, Slack).
- `ffmpeg` on `PATH`, if you want spoken replies on channels. Optional — the gateway runs and speaks without it, but only in formats the TTS provider already emits, and it prints a `⚠ ffmpeg not found` notice at startup. Install with `sudo apt-get install -y ffmpeg` (Debian/Ubuntu), `sudo dnf install -y ffmpeg` (AL2023/Fedora), or `brew install ffmpeg`. See [Send and receive voice notes on a channel](voice-notes-on-channels.md).

The official mental model: you don't need a beefy server. A 4 GB Pi or a $5 VPS is plenty for a single operator's bots; SQLite WAL handles concurrent reads, the long-polling/Socket-Mode adapters dial out so you don't even need an inbound port unless you want the web dashboard public.

## The shape of a production deployment

Ethos is not one process running everything — it's a few small processes that share `~/.ethos/`. The two long-running ones for production are:

- **`ethos gateway start`** — every channel adapter (Telegram, Slack, Discord, Email).
- **`ethos serve`** — web dashboard (`:3000`) and ACP server (`:3001`).

`ethos run-all` is the supervisor that brings both up with one command. It spawns them as child processes, watches them, and restarts the one that crashed (with exponential backoff). PM2 (or systemd, or launchd) wraps `ethos run-all` so it survives reboots.

```
+--------------------------------------------------------+
|  Your mini PC / VPS / home server                      |
|                                                        |
|  PM2 → ethos run-all (supervisor)                      |
|         ├── ethos gateway start    [child 1]           |
|         │     ├── Telegram bot                         |
|         │     ├── Slack bot                            |
|         │     ├── Discord bot                          |
|         │     └── Email                                |
|         │                                              |
|         └── ethos serve            [child 2]           |
|               ├── web dashboard   :3000                |
|               └── ACP server      :3001                |
|                                                        |
|  Shared state:  ~/.ethos/                              |
|  Child logs:    ~/.ethos/logs/{gateway,serve}.log      |
+--------------------------------------------------------+
                        ▲
                        │ same ~/.ethos/ via SSH (or
                        │ different one on your laptop)
                        │
+--------------------------------------------------------+
|  Your laptop (operator)                                |
|                                                        |
|  ethos chat                                            |
|  - REPL whenever you want to drive the agent           |
|  - bots keep running whether your laptop is on or not  |
+--------------------------------------------------------+
```

## Steps

### 1. Install Ethos and PM2 on the box

SSH to your mini-PC / server, install Node 24 if needed, then:

```bash
npm i -g @ethosagent/cli pm2
ethos --version    # confirm it's installed
pm2 --version      # PM2 is the process manager that keeps ethos alive
```

### 2. First-run setup

```bash
ethos setup
```

The wizard configures your default provider, adds an API key, picks a personality, and walks you through Telegram / Slack / Discord / Email tokens for whichever channels you want online. Everything lands in `~/.ethos/config.yaml`.

### 3. Verify with a foreground run before daemonising

Always foreground-test once before handing it to PM2. If anything is misconfigured (bad token, missing model, port collision), you want the error in your terminal, not buried in a log.

```bash
ethos run-all
```

You should see one line per child:

```
ethos run-all — 2 children
✓ gateway  pid 12345 · logs: ~/.ethos/logs/gateway.log
✓ serve    pid 12346 · logs: ~/.ethos/logs/serve.log
```

Test it:

- Send a DM to your Telegram bot → it replies.
- Send a `@mention` in your Slack workspace → it replies.
- Open `http://<box-hostname>:3000/` → the dashboard loads.

Stop with **Ctrl-C**. Both children receive `SIGTERM` and exit cleanly within ~5 seconds.

### 4. Hand it to PM2 for reboot survival

Download the reference PM2 config and start:

```bash
curl -O https://ethosagent.ai/ecosystem.config.js
pm2 start ecosystem.config.js
pm2 save
pm2 startup       # follow the printed command — it auto-starts at boot
```

`pm2 status` should show one `ethos` process running. Reboot the box; it comes back up on its own.

If you don't want to use the hosted config, this is the whole file:

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'ethos',
      script: 'ethos',
      args: 'run-all',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 2_000,
      out_file: '~/.pm2/logs/ethos-out.log',
      error_file: '~/.pm2/logs/ethos-err.log',
      time: true,
    },
  ],
};
```

### 5. Operate it from your laptop

The box is now running bots forever. To chat with the agent directly:

- **Same machine?** Open another terminal: `ethos chat`. The CLI shares `~/.ethos/` with the running daemons via SQLite (WAL mode handles concurrent reads); your chat session is on its own lane (`cli:<cwd>`) and doesn't collide with bot sessions.
- **Remote box?** SSH in and run `ethos chat`. Or run `ethos chat` on your laptop with its own `~/.ethos/` — completely independent. Bots on the server, REPL on your laptop, two different states.

The mental separation: **bots run where they need to run; chat happens where you are**.

## Verify

- `pm2 status` shows `ethos` as `online`.
- `pm2 logs ethos` streams supervisor output (the `✓ gateway · ✓ serve` lines).
- `tail -f ~/.ethos/logs/gateway.log` shows per-child output.
- `curl -s http://localhost:3000/api/health` (or whatever your health route is) returns 200.
- Telegram / Slack: send a message; the bot replies; the message appears in the dashboard's Sessions tab at `:3000`.
- Reboot the box: `sudo reboot`. Wait. SSH back in: `pm2 status` shows `ethos` online again, no manual start needed.

## Operate

### Logs

| What | Where | How |
|---|---|---|
| Supervisor (`ethos run-all`) output | `~/.pm2/logs/ethos-out.log` | `pm2 logs ethos` |
| Gateway child | `~/.ethos/logs/gateway.log` | `tail -f ~/.ethos/logs/gateway.log` |
| Serve child | `~/.ethos/logs/serve.log` | `tail -f ~/.ethos/logs/serve.log` |
| Crash reports | `~/.ethos/errors/` | `ethos errors` |

### Restart, stop, status

```bash
pm2 restart ethos    # restart both children (supervisor + everything under it)
pm2 stop ethos       # stop, keep the registration (for later `pm2 start`)
pm2 delete ethos     # remove from PM2 entirely
pm2 status           # one-line status of every PM2 process on the box
pm2 monit            # full-screen monitor with CPU + memory + log tail
```

### Upgrade

```bash
ethos upgrade        # in-place upgrade of @ethosagent/cli
pm2 restart ethos    # pick up the new binary
```

`pm2 startup` already wires reboot survival, so an upgrade-then-restart cycle is the full update flow.

### Adjust resources

Ethos's footprint is light — typical single-operator deployment on a 4 GB Pi:

- Idle: ~150 MB RAM (supervisor + 2 children).
- Active turn: spikes by ~200–400 MB depending on the model and context size.
- Disk: SQLite under `~/.ethos/` grows ~1 MB per hundred messages. Run `ethos retention` to set caps.
- Network: outbound only by default. Telegram long-polling and Slack Socket Mode dial out; you don't need an inbound port unless you publish the web dashboard.

If you want the dashboard reachable from the open internet, put a reverse proxy (Caddy is two lines of config) in front of `:3000` — and absolutely require auth on the web side (`ethos api-key create` for bearer-token access).

## Alternatives to PM2

PM2 is the easiest cross-platform path; here's the rest of the table:

- **Linux server** — systemd user unit running `ethos run-all`. Generate the unit file with `ethos systemd-unit ethos-runall > ~/.config/systemd/user/ethos-runall.service`, then `systemctl --user enable --now ethos-runall`. See [Run as a daemon](run-as-daemon.md) for the full walkthrough and [CLI reference](../reference/cli.md#ethos-systemd-unit) for all available units.
- **macOS** — launchd plist running `ethos run-all`. Also in [Run as a daemon](run-as-daemon.md).
- **Docker** — official image is planned; not yet shipped. Build your own from `node:24-alpine` + `npm i -g @ethosagent/cli`; mount `~/.ethos/` as a volume.
- **Manual `tmux` / `screen`** — for development or "I'll just leave it running while I'm logged in." Not for production; survives logout only with `screen -d -m` discipline.

Whichever you pick, the inside is the same: one `ethos run-all` process, two children, shared `~/.ethos/`.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| `ethos run-all` exits immediately with "Run ethos setup first" | `~/.ethos/config.yaml` missing | Run `ethos setup` |
| `gateway` keeps crashing in restart loop | Bad Telegram / Slack token, or no provider configured | `tail -f ~/.ethos/logs/gateway.log` — the error is usually one line; fix the token in `~/.ethos/config.yaml` |
| Supervisor gives up after 10 crashes in 5 minutes | Real crash loop, intentional safety net | Inspect the child log; the supervisor sets `exitCode = 1` so PM2 restarts the whole thing. Fix the cause first. |
| Web dashboard isn't reachable | `:3000` not bound to `0.0.0.0`, or firewall blocking | Bind options in [serve](../reference/cli.md#ethos-serve); open the port in your firewall |
| Bots stop responding but `pm2 status` shows `online` | Inside-process hang (rare); supervisor doesn't see it | `pm2 restart ethos`; if it repeats, check provider rate-limits or network egress |
| Two `ethos chat` sessions see each other's history | They're using the same session key (`cli:<cwd-basename>`) | `cd` to a different directory, or run `ethos chat` with `/new` to start a fresh session |
| `pm2 startup` printed a `sudo` command but it didn't run | Boot-time wiring needs root | Run the exact `sudo env PATH=...` line PM2 printed — that's the bit that survives reboot |
| After `ethos upgrade`, bots use the old version | PM2 still has the old child cached | `pm2 restart ethos` |

For everything else: `pm2 logs ethos --lines 200`, `ethos doctor`, [Troubleshooting reference](../../troubleshooting.md).

## What you learned

- The four moving parts: `ethos run-all` (supervisor) → `gateway start` + `serve` (children) → `~/.ethos/` (shared state) → `ethos chat` (operator REPL).
- One command starts everything (`ethos run-all`); PM2 keeps it alive across reboots.
- Failure isolation works because children are real subprocesses, not in-process threads.
- The mini-PC sizing reality: 4 GB RAM is plenty, outbound network is enough.

## Next step

- [Run multiple Telegram bots from one gateway](run-multi-bot-telegram.md) — one Ethos instance, several personalities each with their own bot.
- [Run a team with kanban](run-a-team-with-kanban.md) — multi-personality teams that coordinate through a shared board.
- [Connect Telegram to a team](connect-telegram-to-team.md) — wire the team coordinator to a Telegram bot.
