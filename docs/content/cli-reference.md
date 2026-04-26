---
sidebar_position: 10
title: CLI Reference
---

# CLI Reference

Comprehensive reference for the `ethos` command-line interface — every subcommand, every flag, every slash command, every config field.

> **Quick links:** [cheat sheet](#cheat-sheet) · [global flags](#global) · [commands](#commands) · [slash commands](#slash-commands-inside-chat) · [config file](#config-file--ethosconfigyaml) · [env vars](#environment-variables) · [file locations](#file-locations) · [exit codes](#exit-codes)

---

## Cheat sheet

| Command | What it does |
|---|---|
| `ethos setup` | First-time interactive config wizard |
| `ethos chat` *(or just `ethos`)* | Interactive REPL chat — the default |
| `ethos personality list` | List built-in + custom personalities |
| `ethos personality set <id>` | Change the default personality |
| `ethos memory show` | Print current memory contents |
| `ethos memory add "<text>"` | Append to memory |
| `ethos gateway setup` | Configure Telegram bot token |
| `ethos gateway start` | Run all configured platform bots — long-running |
| `ethos cron list` | List scheduled jobs |
| `ethos cron create --name … --schedule "…" --prompt "…"` | Create a cron job |
| `ethos serve` | Web UI + API on `:3000` *(Phase 26)* — long-running |
| `ethos acp` | Agent Control Protocol mesh server — long-running |
| `ethos batch <tasks.jsonl>` | Run tasks in parallel from a JSONL file |
| `ethos eval run <tasks.jsonl> --expected <expected.jsonl>` | Score agent output against expected answers |
| `ethos evolve --list-pending` | Show evolved skills awaiting review |
| `ethos plugin install <pkg>` | Install an npm plugin |
| `ethos skills install <slug>` | Install a ClawHub-compatible skill |
| `ethos keys add <api-key>` | Add a key to the rotation pool |
| `ethos claw migrate` | Import an OpenClaw install into Ethos |
| `ethos upgrade` | Upgrade to the latest published version |

---

## Global

### Synopsis

```
ethos [command] [args] [--version | --help]
```

If `[command]` is omitted, `ethos` runs `chat` against `~/.ethos/config.yaml`. If no config exists, it auto-routes through `ethos setup` first.

### Top-level flags

| Flag | Aliases | Description |
|---|---|---|
| `--version` | `-v` | Print the installed CLI version and exit |
| `--help` | `-h` | Print top-level usage and exit |

Per-command flags are documented in each command section below.

---

## Commands

### `setup`

Interactive first-run wizard. Writes `~/.ethos/config.yaml`.

```
ethos setup
```

Asks for: LLM provider, model, API key, base URL (for OpenAI-compat providers), and the default personality. No flags — everything is prompt-driven.

**Re-running** is safe — answers default to your current config.

---

### `chat`

Interactive REPL with streaming output and slash commands. Sessions persist across restarts.

```
ethos chat
ethos                       # same — chat is the default
```

When invoked without an existing config, runs `setup` first.

Session key defaults to `cli:<basename of cwd>`, so different working directories get separate conversation histories. See [slash commands](#slash-commands-inside-chat) for in-chat actions.

---

### `personality`

Manage the active personality and list available ones.

```
ethos personality                      # same as `list`
ethos personality list
ethos personality set <id>
```

| Subcommand | Args | Description |
|---|---|---|
| `list` *(default)* | — | List all personalities (built-in + custom from `~/.ethos/personalities/`). Marks the current default. |
| `set` | `<id>` | Set this personality as default. Writes to `~/.ethos/config.yaml`. |

To create a new personality from scratch, drop a directory into `~/.ethos/personalities/<id>/`. See [Create your own personality](./personality/create-your-own).

**Examples:**

```bash
ethos personality                      # See what's available
ethos personality set engineer         # Make engineer the default
```

---

### `memory`

View and edit memory files. Behavior depends on `memory:` setting in config (`vector` or default markdown).

```
ethos memory                           # show — default
ethos memory show
ethos memory add "<text>"
ethos memory clear
ethos memory export [path]             # vector mode only
```

| Subcommand | Args | Description |
|---|---|---|
| `show` *(default)* | — | Markdown mode: print contents of `MEMORY.md` + `USER.md`. Vector mode: print 20 most recent chunks. |
| `add` | `"<text>"` | Append text to memory. In vector mode, embeds and chunks. |
| `clear` | — | Wipe memory. In vector mode, prompts for confirmation. |
| `export` | `[path]` | **Vector only.** Export all chunks to a markdown file. Default path: `~/.ethos/memory-export-<timestamp>.md`. |

Memory in markdown mode lives in two files:

| File | Purpose |
|---|---|
| `~/.ethos/MEMORY.md` | Rolling project context — updated each session |
| `~/.ethos/USER.md` | Who you are — persistent, rarely changes |

**Examples:**

```bash
ethos memory                                          # show current
ethos memory add "Mitesh prefers terse explanations"
ethos memory export ~/Desktop/memory-snapshot.md
```

---

### `gateway`

Configure and run the multi-platform message gateway. The gateway is the entry point for Telegram, Slack, Discord, WhatsApp, and Email — letting users DM your agent on whichever platform they prefer.

```
ethos gateway setup
ethos gateway start
```

| Subcommand | Description |
|---|---|
| `setup` | Interactive prompt for a Telegram bot token. (Other platforms are configured by editing `~/.ethos/config.yaml` directly.) |
| `start` | Spin up every platform whose credentials are present in config. **Long-running — keeps the process alive.** |

`gateway start` requires at least one of these in `~/.ethos/config.yaml`:

| Field(s) | Platform |
|---|---|
| `telegramToken` | Telegram |
| `discordToken` | Discord |
| `slackBotToken`, `slackAppToken`, `slackSigningSecret` | Slack |
| `emailImapHost`, `emailImapPort`, `emailUser`, `emailPassword`, `emailSmtpHost`, `emailSmtpPort` | Email |
| WhatsApp auth state in `~/.ethos/whatsapp-auth/` | WhatsApp |

To run `gateway start` permanently in the background, see [Run as a Daemon](./guides/run-as-daemon).

**Examples:**

```bash
ethos gateway setup                       # Configure Telegram
ethos gateway start                       # Foreground — Ctrl+C to stop
```

---

### `cron`

Schedule prompts to fire on cron expressions. Useful for daily summaries, hourly checks, weekly reports.

```
ethos cron                              # same as `list`
ethos cron list
ethos cron create --name "<name>" --schedule "<cron>" --prompt "<text>" [--personality <id>] [--deliver <target>]
ethos cron pause <id>
ethos cron resume <id>
ethos cron delete <id>
ethos cron run <id>                     # fire immediately
```

| Subcommand | Description |
|---|---|
| `list` *(default)* | Show all jobs with their schedule, last run, next run |
| `create` | Schedule a new job (see flags below) |
| `pause <id>` | Stop firing a job without deleting it |
| `resume <id>` | Resume a paused job |
| `delete <id>` | Permanently remove a job |
| `run <id>` | Fire the job's prompt right now (out-of-schedule) |

**Flags for `create`:**

| Flag | Required | Default | Description |
|---|---|---|---|
| `--name` / `-n` | yes | — | Human-readable job name |
| `--schedule` / `-s` | yes | — | Cron expression, e.g. `0 8 * * *` (daily 8 AM) |
| `--prompt` / `-p` | yes | — | The prompt the agent runs each fire |
| `--personality` | no | from config | Override the personality for this job |
| `--deliver` | no | — | Delivery target (e.g. a Telegram chat ID, Slack channel) |

Cron expressions follow standard 5-field syntax (`min hour dom month dow`). Examples:
- `0 8 * * *` — every day at 8:00 AM
- `*/15 * * * *` — every 15 minutes
- `0 9 * * 1` — every Monday at 9:00 AM

To run the cron worker in the background so jobs fire even when you're not at your terminal, see [Run as a Daemon](./guides/run-as-daemon).

**Examples:**

```bash
ethos cron list
ethos cron create --name "Daily standup" --schedule "0 8 * * 1-5" --prompt "What's on my calendar today?"
ethos cron run abc123                              # fire immediately
ethos cron delete abc123
```

---

### `serve`

Start the Ethos web UI + API on a local port. **Phase 26** — currently in development. **Long-running.**

```
ethos serve [--port <n>] [--bind <addr>]
```

| Flag | Default | Description |
|---|---|---|
| `--port` | `3000` | HTTP port |
| `--bind` | `127.0.0.1` | Bind address. `--bind 0.0.0.0` exposes to LAN (still token-protected). |

On first run, prints a `http://localhost:3000?t=<token>` URL with a one-time token; that token rotates into an httpOnly cookie on first browser visit. See [Phase 26 plan](https://github.com/MiteshSharma/ethos/blob/main/plan/phases/26-web-ui.md) for full architecture.

**Examples:**

```bash
ethos serve                            # localhost:3000
ethos serve --port 8080
ethos serve --bind 0.0.0.0             # LAN-accessible (still token-required)
```

---

### `acp`

Run the **Agent Control Protocol** server. ACP is a JSON-RPC stdin/stdout protocol used to compose multiple Ethos agents into a mesh (Phase 24). **Long-running.**

```
ethos acp
```

No flags. Reads JSON-RPC requests from stdin, writes responses to stdout. Typically invoked by a parent orchestrator, not a human. See [Phase 24 plan](https://github.com/MiteshSharma/ethos/blob/main/plan/phases/24-mesh.md) for the protocol spec.

---

### `batch`

Run a JSONL of prompts in parallel against the configured agent. Outputs results as JSONL.

```
ethos batch <tasks.jsonl> [--concurrency <n>] [--output <out.jsonl>] [--checkpoint <cp.json>]
```

| Arg / Flag | Default | Description |
|---|---|---|
| `<tasks.jsonl>` | — | **Required.** Input file. One task per line: `{"id": "...", "prompt": "..."}` |
| `--concurrency` / `-c` | `3` | Parallel workers |
| `--output` / `-o` | `<input>.output.jsonl` | Where to write results |
| `--checkpoint` | `<input>.checkpoint.json` | Resume file. If present, only re-runs missing tasks. |

Output JSONL shape: `{"id": "...", "ok": true|false, "output": "...", "tokens": {...}}`.

Re-running with the same input + checkpoint skips already-completed tasks, so you can Ctrl+C and resume safely.

**Examples:**

```bash
ethos batch tasks.jsonl
ethos batch tasks.jsonl --concurrency 10 --output results.jsonl
```

Use case: scoring datasets, processing inboxes, regression-testing a prompt against historical data.

---

### `eval`

Score the agent's output against expected answers. Useful for tuning personalities, comparing models, regression-testing.

```
ethos eval run <tasks.jsonl> --expected <expected.jsonl> [options]
```

**Subcommand:** `run` is the only one currently. It runs `tasks.jsonl` through the agent (like `batch`) then scores each output against `expected.jsonl`.

| Flag | Default | Description |
|---|---|---|
| `--expected` / `-e` | — | **Required.** JSONL of expected answers, keyed by `id` matching the input |
| `--scorer` / `-s` | `contains` | One of `exact`, `contains`, `regex`, `llm` |
| `--concurrency` / `-c` | `3` | Parallel workers |
| `--output` / `-o` | `<input>.eval.jsonl` | Where to write per-task scores |
| `--evolve` | off | After scoring, run skill evolution on the run (see `evolve`) |
| `--auto-approve` | off | With `--evolve`, auto-promote the new skills (skip the review queue) |

**Scorers:**

| Scorer | Passes when |
|---|---|
| `exact` | `output === expected` |
| `contains` | `expected` is a substring of `output` |
| `regex` | `expected` is a regex; `output` matches |
| `llm` | An LLM judge scores `output` against `expected` and assigns pass/fail with reason |

**Examples:**

```bash
ethos eval run tasks.jsonl --expected expected.jsonl
ethos eval run tasks.jsonl --expected expected.jsonl --scorer llm --concurrency 5
ethos eval run tasks.jsonl --expected expected.jsonl --evolve --auto-approve
```

---

### `evolve`

Generate new skill files from session traces, then queue them for review. The "learning pillar" of Ethos (Phase 25).

```
ethos evolve --eval-output <file.eval.jsonl> [--auto-approve]
ethos evolve --list-pending
ethos evolve --approve <skill-filename>
ethos evolve --approve-all
ethos evolve --reject <skill-filename>
```

| Flag | Description |
|---|---|
| `--eval-output <file>` | Run skill evolution on a prior eval output. Writes candidate skills to `~/.ethos/skills-pending/`. |
| `--auto-approve` | Skip the review queue and promote candidate skills directly to `~/.ethos/skills/` |
| `--list-pending` | Show all candidate skills awaiting review |
| `--approve <filename>` | Promote a single pending skill |
| `--approve-all` | Promote every pending skill |
| `--reject <filename>` | Delete a pending skill |

Pending skills sit in `~/.ethos/skills-pending/` until you accept or reject. Once approved, they move to `~/.ethos/skills/` and become available to any personality whose toolset includes them.

**Examples:**

```bash
ethos evolve --eval-output run.eval.jsonl
ethos evolve --list-pending
ethos evolve --approve summarize-meeting.md
```

---

### `plugin`

Manage Ethos plugins (npm packages that extend the agent — tools, hooks, providers).

```
ethos plugin                          # same as `list`
ethos plugin list
ethos plugin install <package>
ethos plugin remove <package>
```

| Subcommand | Description |
|---|---|
| `list` *(default)* | List installed plugins (npm + manual) |
| `install <package>` | `npm install -g <package>` and register it |
| `remove <package>` | Unregister and `npm uninstall -g` |

Plugins implement the `EthosPlugin` interface from `@ethosagent/plugin-sdk`. See [Plugin SDK](./extending-ethos/plugin-sdk).

**Examples:**

```bash
ethos plugin list
ethos plugin install ethos-plugin-stripe
ethos plugin remove ethos-plugin-stripe
```

---

### `skills`

Install ClawHub-compatible skills — markdown files with YAML frontmatter that teach a personality a specific workflow.

```
ethos skills                          # same as `list`
ethos skills list
ethos skills install <slug>
ethos skills update [<slug>]
ethos skills remove <slug>
```

| Subcommand | Description |
|---|---|
| `list` *(default)* | Show installed skills |
| `install <slug>` | Install from ClawHub. Slug formats: `owner/repo`, `github:owner/repo`, `github:owner/repo/path` |
| `update [<slug>]` | Update one skill, or all if no slug given |
| `remove <slug>` | Uninstall |

Skills land in `~/.ethos/skills/` and are loaded by any personality whose toolset references them. Uses globally-installed `clawhub` if present, else falls back to `npx clawhub@latest`.

**Examples:**

```bash
ethos skills list
ethos skills install steipete/slack
ethos skills install github:my-org/private-skills/notes
ethos skills update                     # update all
ethos skills remove steipete/slack
```

See [Migrate from OpenClaw](./guides/migrate-from-openclaw) for context on the ClawHub ecosystem.

---

### `keys`

Manage the API-key rotation pool. When multiple keys are present, requests round-robin through them, raising effective rate limits and tolerating per-key throttles.

```
ethos keys                            # same as `list`
ethos keys list
ethos keys add <api-key> [--label <name>] [--priority <n>]
ethos keys remove <index>
```

| Subcommand | Args | Description |
|---|---|---|
| `list` *(default)* | — | Show pool with masked keys |
| `add` | `<api-key>` `[--label]` `[--priority]` | Append to pool |
| `remove` | `<index>` (1-based) | Remove the key at that position |

**Flags for `add`:**

| Flag | Default | Description |
|---|---|---|
| `--label` | — | Human-readable name (e.g. `"prod"`, `"dev"`) |
| `--priority` | `50` | Higher numbers chosen first. Useful for "use this key until it 429s, then fall back" |

The pool lives in `~/.ethos/keys.json` (chmod 600).

**Examples:**

```bash
ethos keys list
ethos keys add sk-ant-... --label "prod" --priority 100
ethos keys add sk-ant-... --label "fallback" --priority 10
ethos keys remove 2
```

---

### `claw`

Migrate from [OpenClaw](https://github.com/steipete/openclaw) (`~/.claw/`) into Ethos (`~/.ethos/`). Idempotent — safe to re-run. (Phase 28)

```
ethos claw migrate [--dry-run] [--preset <name>] [--overwrite] [--yes]
```

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Print the plan without writing anything |
| `--preset` | `all` | What to copy. `all` migrates everything; `user-data` skips personalities |
| `--overwrite` | off | Replace existing Ethos files when conflicts arise |
| `--yes` / `-y` | off | Skip the confirmation prompt |

What gets migrated: API keys, personalities (your `SOUL.md` becomes a personality), skills, platform tokens (Telegram/Slack/Discord), memory files. Built-in OpenClaw personalities resolve to Ethos built-ins automatically.

**Examples:**

```bash
ethos claw migrate --dry-run                       # preview
ethos claw migrate                                  # apply
ethos claw migrate --preset user-data --yes         # data only, no prompts
```

See [Migrate from OpenClaw](./guides/migrate-from-openclaw) for the full guide.

---

### `upgrade`

Check npm for a newer published `@ethosagent/cli` and install it. Detects whether you're running from npm-global or a local source clone and prints the right instructions.

```
ethos upgrade
```

No flags. Calls `npm install -g @ethosagent/cli@latest` if a newer version exists. If you installed from a git clone, it tells you to `git pull` instead.

**Examples:**

```bash
ethos upgrade                                       # most common
ethos --version                                     # check what you're on after
```

---

## Slash commands (inside chat)

Type these inside `ethos chat`. They run synchronously and don't count as a turn.

### Session management

| Command | Description |
|---|---|
| `/new` | Start a new session (appends `:<timestamp>` to the session key) |
| `/clear` | Clear the current session history (cannot be undone) |

### Personality

| Command | Description |
|---|---|
| `/personality` | Show the active personality |
| `/personality <id>` | Switch to a different personality (auto-forks the session) |
| `/personalities` | List all available personalities |

### Information

| Command | Description |
|---|---|
| `/usage` | Token usage and estimated cost for this session |
| `/tools` | List the tools available to the current personality |
| `/model` | Show the active model |
| `/memory` | Print current `MEMORY.md` and `USER.md` contents |
| `/status` | Session key, personality, model, tool count |

### Control

| Command | Description |
|---|---|
| `/help` | Show available slash commands |
| `Ctrl+C` | Interrupt the current response |
| `Ctrl+D` | Exit the CLI |

---

## Config file — `~/.ethos/config.yaml`

Created by `ethos setup`. Every field is optional unless marked **required**.

```yaml
# ── Required ────────────────────────────────────────────────────────────────
provider: anthropic                  # anthropic | openrouter | ollama | gemini | <any>
model: claude-opus-4-7               # model ID for your provider
apiKey: sk-ant-...                   # API key

# ── Default personality ─────────────────────────────────────────────────────
personality: researcher              # built-in id or custom dir name

# ── Provider endpoint (required for non-Anthropic providers) ────────────────
baseUrl: https://openrouter.ai/api/v1

# ── Memory mode ─────────────────────────────────────────────────────────────
memory: markdown                     # markdown (default) | vector

# ── Per-personality model routing ───────────────────────────────────────────
modelRouting:
  researcher: anthropic/claude-opus-4-7
  engineer: moonshotai/kimi-k2.6

# ── Active platform adapters ────────────────────────────────────────────────
adapters:
  - cli                              # always include for ethos chat

# ── Telegram gateway ────────────────────────────────────────────────────────
telegramToken: 123456:ABC-...

# ── Discord gateway ─────────────────────────────────────────────────────────
discordToken: ...
discordClientId: ...

# ── Slack gateway ───────────────────────────────────────────────────────────
slackBotToken: xoxb-...
slackAppToken: xapp-...
slackSigningSecret: ...

# ── Email gateway ───────────────────────────────────────────────────────────
emailImapHost: imap.gmail.com
emailImapPort: 993
emailUser: you@example.com
emailPassword: ...                   # use an app-specific password
emailSmtpHost: smtp.gmail.com
emailSmtpPort: 587

# ── Plugins to load at startup ──────────────────────────────────────────────
plugins:
  - "@myorg/ethos-plugin-weather"
```

The companion `~/.ethos/keys.json` (managed via `ethos keys`) holds the API-key rotation pool. Don't edit it by hand.

---

## Environment variables

Read at startup; override values in `config.yaml`.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic provider key |
| `OPENAI_API_KEY` | OpenAI / OpenAI-compat provider key |
| `OPENROUTER_API_KEY` | OpenRouter key |
| `ETHOS_CONFIG` | Override config file path (default: `~/.ethos/config.yaml`) |
| `ETHOS_SESSION` | Override session key for this invocation |
| `ETHOS_DEBUG` | `1` to print hook events, token counts, prompt diagnostics |
| `ETHOS_DIR` | Override `~/.ethos/` location entirely (rarely needed) |

---

## File locations

```
~/.ethos/
├── config.yaml             ← provider, model, key, personality, platform tokens
├── keys.json               ← API key rotation pool (managed by `ethos keys`, chmod 600)
├── MEMORY.md               ← rolling project context (markdown mode)
├── USER.md                 ← who you are (markdown mode)
├── memory.db               ← vector memory (vector mode only)
├── sessions.db             ← SQLite session history (WAL + FTS5)
├── personalities/          ← custom personalities (drop a directory here)
│   └── <id>/
│       ├── ETHOS.md        ← identity prose
│       ├── config.yaml     ← name, description, model, memoryScope
│       ├── toolset.yaml    ← allowed tool list
│       └── skills/         ← per-personality skills (optional)
│           └── <skill>.md
├── skills/                 ← global skills (installed via `ethos skills install`)
│   └── <skill>.md
├── skills-pending/         ← evolved skills awaiting review (`ethos evolve`)
├── plugins/                ← manual plugin manifests
├── logs/                   ← daemon logs
├── allowlist.json          ← tool-call approval grants (Phase 26)
├── web-token               ← web UI auth token (Phase 26, chmod 600)
└── whatsapp-auth/          ← WhatsApp gateway auth state
```

To inspect sessions directly:

```bash
sqlite3 ~/.ethos/sessions.db
sqlite> .tables
sqlite> SELECT session_id, COUNT(*) FROM messages GROUP BY session_id;
```

To export a single session's transcript:

```bash
sqlite3 ~/.ethos/sessions.db \
  "SELECT role, content FROM messages WHERE session_id = 'cli:myproject' ORDER BY timestamp"
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Generic error (failed setup, missing config, command parse error, network failure) |
| `130` | Interrupted (Ctrl+C) |

Specific commands may print diagnostic output to stderr before exiting non-zero. Set `ETHOS_DEBUG=1` for verbose tracing.

---

## See also

- [Quickstart](./getting-started/quickstart) — first-time install + chat
- [Run as a Daemon](./guides/run-as-daemon) — keep `gateway start` / `cron` / `serve` alive in the background
- [Platforms](./platforms/overview) — Telegram / Slack / Discord / Email setup
- [Create your own personality](./personality/create-your-own) — custom personalities
- [Plugin SDK](./extending-ethos/plugin-sdk) — build a plugin
- [Troubleshooting](./troubleshooting) — common issues
