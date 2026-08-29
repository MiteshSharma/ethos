---
title: "config.yaml reference"
description: "Every field in ~/.ethos/config.yaml — provider, model, channel tokens, retention TTLs, provider chain, voice tier, channels, transcode, wake, telephony."
kind: reference
audience: user
slug: config-yaml
updated: 2026-08-22
---

`~/.ethos/config.yaml` is a flat `key: value` file. Dotted keys (e.g. `retention.messages`, `providers.0.provider`) are how nested structures appear on disk — there is no indentation-based nesting. The parser ignores quotes around values.

## Source {#source}

The full field set lives in the `EthosConfig` interface in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts). `parseConfigYaml` reads values; `writeConfig` writes them. Fields marked `@internal` are managed by the runtime (e.g. `activeContext` by `ethos set`) — do not hand-edit them.

## Minimal example {#minimal-example}

```yaml
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-...
personality: researcher
```

This is what `ethos setup` writes for a default Anthropic install. Everything below is optional.

## provider {#provider}

Type: string · Default: `anthropic` · Required (effectively)

LLM provider id. Resolved at wiring time against the registered provider list. Built-in values: `anthropic`, `openrouter`, `openai`, `ollama`, `gemini`. Custom values may resolve through plugins.

```yaml
provider: anthropic
```

## model {#model}

Type: string · Default: `claude-opus-4-7` · Required (effectively)

Model id to pass to the provider. Format depends on the provider — Anthropic uses raw model names, OpenRouter uses `vendor/model`.

```yaml
model: claude-opus-4-7
```

## apiKey {#api-key}

Type: string · Default: empty · Required

Primary provider API key. For multi-key rotation, leave this set to the most-trusted key and add fallbacks via `ethos keys add` (which writes `~/.ethos/keys.json`). The `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` env vars override this at wiring time when set.

```yaml
apiKey: sk-ant-...
```

## personality {#personality}

Type: string · Default: `researcher` · Required

Id of the default [personality](../../getting-started/glossary.md#personality). Built-ins: `researcher`, `engineer`, `reviewer`. System: `personality-architect`, `team-architect`. User personalities live under `~/.ethos/personalities/<id>/`.

```yaml
personality: engineer
```

## memory {#memory}

Type: `markdown` | `vector` · Default: unset (treated as `markdown`)

Memory backend. `markdown` reads and writes `~/.ethos/MEMORY.md` and `~/.ethos/USER.md`. `vector` enables the SQLite + embeddings store at `~/.ethos/memory.db`.

```yaml
memory: vector
```

Notes:

- Switching backends mid-stream does not migrate data — export from one, then import into the other.
- Vector mode requires an embeddings-capable provider key.

## baseUrl {#base-url}

Type: string · Default: provider default

Override the provider's API endpoint. Required for OpenAI-compatible providers (OpenRouter, Ollama, local proxies).

```yaml
baseUrl: https://openrouter.ai/api/v1
```

## modelRouting.\<personality\> {#model-routing}

Type: string · Default: falls back to top-level `model`

Per-personality model override. The key is a personality id; the value is a model string for that personality's provider.

```yaml
modelRouting.researcher: claude-opus-4-7
modelRouting.engineer: moonshotai/kimi-k2.6
```

## providers.\<i\>.\* {#providers-chain}

Provider fallback chain. When two or more entries are present, the runtime wraps them in a `ChainedProvider` with cooldown-based failover. Index `0` is primary; higher indices fall back in order. When only one entry is set, the top-level `provider` / `apiKey` / `model` fields are used.

| Field | Type | Description |
|---|---|---|
| `providers.<i>.provider` | string | Provider id for entry `<i>`. |
| `providers.<i>.apiKey` | string | API key for entry `<i>`. |
| `providers.<i>.model` | string | Optional model override for entry `<i>`. |
| `providers.<i>.baseUrl` | string | Optional endpoint override for entry `<i>`. |

```yaml
providers.0.provider: anthropic
providers.0.apiKey: sk-ant-...
providers.0.model: claude-opus-4-7
providers.1.provider: openrouter
providers.1.apiKey: sk-or-...
providers.1.model: anthropic/claude-opus-4-7
```

## telegram.bots.\* {#telegram-bots}

Multi-bot list shape. When set, the gateway creates one `TelegramAdapter` and one `AgentLoop` per entry. `telegram.bots` takes precedence over the legacy `telegramToken` scalar when both are present.

| Field | Type | Default | Description |
|---|---|---|---|
| `telegram.bots.<i>.token` | string | — | Bot token from BotFather. Required per entry. |
| `telegram.bots.<i>.id` | string | `sha256(token)[:24]` | Stable, human-readable bot key. Used in session lane names (`telegram:<botKey>:<chatId>`), log output, and the internal `Map<botKey, AgentLoop>`. Set once; do not change after the bot goes live. |
| `telegram.bots.<i>.bind.type` | `personality` \| `team` | — | Required. `personality` routes to a named personality. `team` routes to the team's coordinator personality and auto-starts the team supervisor. |
| `telegram.bots.<i>.bind.name` | string | — | Required. Personality id (for `personality`) or team name (for `team`). |
| `telegram.bots.<i>.bind.allowSlashSwitch` | boolean | `false` | Allow per-chat `/personality` switching. Disabled by default for identity-bound bots. |
| `telegram.bots.<i>.useWebhook` | boolean | `false` | Receive updates over an inbound webhook instead of long-polling. Requires `webhookUrl` and `webhookSecretToken` — the adapter throws at startup without either. See [Receive Slack and Telegram events over webhooks](../how-to/run-channels-over-webhooks.md). |
| `telegram.bots.<i>.webhookUrl` | string | — | Required when `useWebhook` is `true`. The full public URL Telegram POSTs updates to, **including** the `/telegram/webhook/<botKey>` path — the host routes on that path, so a URL without it reaches no handler. Registered for you by `setWebhook()` at startup. |
| `telegram.bots.<i>.webhookSecretToken` | string | — | Required when `useWebhook` is `true`. Echoed by Telegram in `X-Telegram-Bot-Api-Secret-Token` and compared by grammy before the update is processed. A credential: externalized to the secret vault exactly like `token`, so write it as `${secrets:<ref>}`. |
| `telegram.bots.<i>.dropPendingUpdates` | boolean | `true` | Discard updates Telegram queued while the process was down. **Poll mode only** — `bot.start()` is never called for a webhook-mode bot, so the flag does nothing there. Set `false` on a poll-mode bot in a deployment that sleeps and wakes, so a restart does not wipe the backlog. |

```yaml
telegram.bots.0.token: "123456:ABCdefGhIJklmNopQRstuVwxYZ"
telegram.bots.0.id: researcher-bot
telegram.bots.0.bind.type: personality
telegram.bots.0.bind.name: researcher

telegram.bots.1.token: "654321:XYZabcDeFgHijKlMnOpqRsTuV"
telegram.bots.1.id: coder-bot
telegram.bots.1.bind.type: personality
telegram.bots.1.bind.name: engineer
```

Notes:

- Session key format in multi-bot mode: `telegram:<botKey>:<chatId>`. This differs from single-bot mode (`telegram:<chatId>`).
- `deriveBotKey()` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts) computes the sha256-derived default when `id` is omitted.
- See [Run multiple Telegram bots from one process](../how-to/run-multi-bot-telegram.md) for a full walkthrough.

## telegramToken {#telegram-token}

Type: string · Default: unset · **Deprecated** (use `telegram.bots` instead)

Legacy scalar shape — wires one bot bound to the default `personality`. Still supported; creates a single-element entry in the gateway's internal bot list. When both `telegramToken` and `telegram.bots` are set, `telegram.bots` takes precedence and this field is ignored with a deprecation warning.

```yaml
telegramToken: 123456:ABC-DEF...
```

## slack.apps.\* {#slack-apps}

Multi-app list shape for Slack. Each entry creates one Slack adapter bound to a personality or team. Supersedes the legacy scalar fields `slackBotToken`, `slackAppToken`, and `slackSigningSecret` when set.

| Field | Type | Default | Description |
|---|---|---|---|
| `slack.apps.<i>.botToken` | string | — | `xoxb-` bot token. Required per entry. |
| `slack.apps.<i>.appToken` | string | — | `xapp-` app-level token for Socket Mode. Required only while `mode.socket` is in effect (the default); an HTTP-mode app has no Socket Mode connection and needs none. The adapter throws when `mode.socket` is on and this is absent. |
| `slack.apps.<i>.signingSecret` | string | — | Signing secret from the app's Basic Information page. Required per entry. Exercised only under `mode.http`, where it is the HMAC key every inbound Events API request is verified against; under Socket Mode it is carried but never used — the socket is authenticated by `appToken` and receives no HTTP requests to verify. |
| `slack.apps.<i>.mode.socket` | boolean | `true` | Connect over Socket Mode (WebSocket). Mutually exclusive with `mode.http` — the adapter throws when both are `true`, because they are two transports for the same inbound event stream. |
| `slack.apps.<i>.mode.http` | boolean | `false` | Receive Events API deliveries over inbound HTTP instead. Requires `signingSecret`, and requires setting `mode.socket: false` explicitly. Slack has no registration API: you must set the Event Subscriptions Request URL in the Slack app dashboard yourself. See [Receive Slack and Telegram events over webhooks](../how-to/run-channels-over-webhooks.md). |
| `slack.apps.<i>.webhookPath` | string | the app's `botKey` | Route segment this app's HTTP receiver answers on, under `/slack/events/`. HTTP mode only. Leading and trailing slashes are stripped. |
| `slack.apps.<i>.id` | string | `sha256(botToken)[:24]` | Stable, human-readable app key. Used in session lane names and log output. Set once; do not change after the app goes live. |
| `slack.apps.<i>.bind.type` | `personality` \| `team` | — | Required. Same semantics as the Telegram equivalent. |
| `slack.apps.<i>.bind.name` | string | — | Required. Personality id or team name. |
| `slack.apps.<i>.bind.allowSlashSwitch` | boolean | `false` | Allow per-channel `/personality` switching. |
| `slack.apps.<i>.defaultChannelMode` | `mention_only` \| `thread_follow` \| `all` | `mention_only` | When the agent replies in a channel with no per-channel override. `thread_follow` also answers follow-ups in threads it has already posted in; `all` answers every message. |
| `slack.apps.<i>.receiptReaction` | string | `eyes` | Emoji name (no colons) reacted onto an inbound message on arrival and removed once the reply lands. Needs the `reactions:write` scope; without it the reaction is skipped silently. |
| `slack.apps.<i>.allowedSlashUsers` | string list | unset | Comma-separated Slack user ids allowed to run `/ethos` and to see the App Home tab's memory, session, kanban, and channel sections. Narrows `channel_filter.slack` (`ownerUserId` + `recipientAllowlist`) — an id listed here that is not on that allowlist stays denied. Absent or empty means the `channel_filter.slack` allowlist alone. Both empty means nobody: the gate is default-closed. |
| `slack.apps.<i>.allowedBotIds` | string list | unset | Comma-separated Slack `bot_id`s whose messages reach the agent, in new posts, edits, and thread backfill alike. Absent or empty drops every bot- and workflow-authored message — the gate is default-closed. Read a bot's id from the `bot_id` field of any message it has posted. |
| `slack.apps.<i>.longReplyThresholdChars` | integer | `9000` | Reply length above which the agent posts a short lead message ending in "full answer attached" plus the complete text as an `answer.md` upload, instead of four or more chunked messages. `0` disables the fallback. The upload needs the `files:write` scope; without it the reply falls back to the chunked messages. |

```yaml
slack.apps.0.botToken: "xoxb-..."
slack.apps.0.appToken: "xapp-..."
slack.apps.0.signingSecret: "abc123..."
slack.apps.0.id: eng-slack
slack.apps.0.bind.type: team
slack.apps.0.bind.name: eng
slack.apps.0.allowedBotIds: B01DEPLOYBOT,B02ALERTBOT
```

Notes:

- `/ethos` and the App Home tab are default-deny as of this release, and the trust set comes from `channel_filter.slack` — the same allowlist that decides who may message the bot. A workspace with no `channel_filter.slack.ownerUserId` and no `recipientAllowlist` authorizes nobody: every `/ethos` invocation answers "You are not authorized to use this command," and App Home shows a notice in place of its private sections. **This is a breaking change** — before it, any workspace member could run `/ethos memory add`, which writes the bound personality's `MEMORY.md` into every later system prompt. Set `channel_filter.slack.ownerUserId` to your Slack user id to restore access. `channel_filter.slack.enabled: false` does not reopen these surfaces; it only disables the message filter.
- An allowlisted bot's message carries `userId = <bot_id>`, and the gateway's channel filter allowlists by `userId`. Two gates guard a bot message and both must open: `allowedBotIds` here, plus the same `bot_id` in `channelFilter.slack.recipientAllowlist` (or no filter configured at all). See [Run an agent on Slack](../../platforms/slack.md) for the filter block. There is no bypass — an operator who opens one gate and forgets the other sees the bot's messages silently dropped at the gateway.
- The same two gates apply to the bot's lines in **thread backfill**, and only under `channel_filter.slack.contextVisibility: allowlist`. Backfilled history is attributed line by line, and each line is checked against `recipientAllowlist` by the same id — a human's Slack user id, a bot's `bot_id`. So an operator running the stricter context-visibility setting who allowlists a bot in `allowedBotIds` but not in `recipientAllowlist` sees its history lines dropped while its live messages are dropped too, consistently. Under the default `contextVisibility: all`, backfill is not filtered at all and `allowedBotIds` alone decides which bots appear in it.

## teams.\* {#teams}

Per-team runtime knobs. These apply to teams that the gateway auto-starts via `bind.type: team` in `telegram.bots` or `slack.apps`.

| Field | Type | Default | Description |
|---|---|---|---|
| `teams.<name>.autoStop` | boolean | `true` | When `true`, the gateway stops the team supervisor when the gateway shuts down. Set to `false` to leave the supervisor running across gateway restarts. |

```yaml
teams.eng.autoStop: false
```

Notes:

- `<name>` must match the team manifest filename stem at `~/.ethos/teams/<name>.yaml`.
- With `autoStop: false`, stop the supervisor manually with `ethos team stop <name>`.
- See [Connect a Telegram bot to a team](../how-to/connect-telegram-to-team.md) for a usage example.

## discordToken {#discord-token}

Type: string · Default: unset

Bot token for the Discord gateway.

## slackBotToken {#slack-bot-token}

Type: string · Default: unset

`xoxb-` bot token for the Slack gateway. Required together with `slackAppToken` and `slackSigningSecret` for Slack to bind.

```yaml
slackBotToken: xoxb-...
slackAppToken: xapp-...
slackSigningSecret: ...
```

## slackAppToken {#slack-app-token}

Type: string · Default: unset

`xapp-` app-level token for Slack Socket Mode. See [`slackBotToken`](#slack-bot-token) for the example.

## slackSigningSecret {#slack-signing-secret}

Type: string · Default: unset

Slack request signing secret. Verifies inbound webhooks when running Slack in HTTP mode.

## emailImapHost {#email-imap-host}

Type: string · Default: unset

IMAP server hostname for the email gateway. The email block requires all six of `emailImapHost`, `emailImapPort`, `emailUser`, `emailPassword`, `emailSmtpHost`, `emailSmtpPort` to bind.

```yaml
emailImapHost: imap.gmail.com
emailImapPort: 993
emailUser: you@example.com
emailPassword: ...
emailSmtpHost: smtp.gmail.com
emailSmtpPort: 587
```

## emailImapPort {#email-imap-port}

Type: integer · Default: unset

IMAP server port. Conventional values: `993` (TLS), `143` (STARTTLS).

## emailUser {#email-user}

Type: string · Default: unset

Mailbox username — typically the full email address.

## emailPassword {#email-password}

Type: string · Default: unset

Mailbox password. Use an app-specific password where the provider supports it (Gmail, Fastmail).

## emailSmtpHost {#email-smtp-host}

Type: string · Default: unset

SMTP server hostname for outbound mail.

## emailSmtpPort {#email-smtp-port}

Type: integer · Default: unset

SMTP server port. Conventional values: `587` (STARTTLS), `465` (TLS).

## web.host, web.port, web.corsOrigins {#web-server}

Type: dotted group · Default: per-field below

Bind address, port, and CORS origins for the `ethos serve` web API — the process that mounts `/v1/*` and `/rpc/*`.

| Field | Type | Default | Description |
|---|---|---|---|
| `web.host` | string | `127.0.0.1` | Bind address. Precedence: `--web-host` CLI flag > `ETHOS_WEB_HOST` env var > this key > default. |
| `web.port` | integer | `3000` | Listen port. Precedence: `--web-port` CLI flag > `ETHOS_WEB_PORT` env var > this key > default. |
| `web.corsOrigins` | string | unset (no CORS) | Comma-separated origins (or `*`) allowed to call `/v1/*` directly from a browser. No CLI flag exists for this one. Precedence: `ETHOS_API_CORS_ORIGINS` env var > this key > default (unset). |

```yaml
web.host: 0.0.0.0
web.port: 3000
web.corsOrigins: "https://chat.example.com"
```

Notes:

- See [Serve Ethos as an OpenAI-compatible backend](../../building/how-to/openai-server-chat.md#1-boot-the-server) for these keys in practice, including the CORS caveat for server-side clients.

## verbose {#verbose}

Type: boolean · Default: `false`

Print a per-turn timing summary (LLM time, TTFT, tool wall-clock, tokens, cost) after every chat response.

```yaml
verbose: true
```

Notes:

- Toggle within a session with [`/verbose`](./slash-commands.md#slash-verbose) — that override is session-local and never written here.

## skin {#skin}

Type: string · Default: engine default

Named [skin](../../getting-started/glossary.md#skin) override. Built-in values: `default`, `mono`, `paper`. Applies across the TUI and the web `ConfigProvider`. This is the only place a skin is set — a personality is an identity, not a theme, so personalities carry no `skin` field.

```yaml
skin: mono
```

## retention.* {#retention}

Per-category TTLs for the observability store. Values accept duration strings — `30d`, `12h`, `forever`. Unset fields fall back to the runtime defaults shown below.

| Field | Default | Description |
|---|---|---|
| `retention.messages` | `365d` | Conversation message history. |
| `retention.traces` | `90d` | Turn traces. |
| `retention.spans` | `90d` | Tool / LLM spans inside traces. |
| `retention.blobs` | `7d` | Large response payloads stored out-of-band. |
| `retention.archive` | `730d` | Archive partitions. |
| `retention.events.error` | `90d` | Error events from `errors.jsonl`. |
| `retention.events.audit` | `365d` | Audit events (key rotation, personality writes, approvals). |
| `retention.events.channel` | `365d` | Channel-adapter events (pairing, dedup). |
| `retention.events.install` | `forever` | Install / migration events. Never deleted by default. |

```yaml
retention.messages: 365d
retention.traces: 90d
retention.events.error: 90d
retention.events.install: forever
```

## personalities.\<id\>.retention.* {#personalities-retention}

Per-personality retention overrides. Same sub-fields as the top-level `retention.*` block; values apply only to data tagged with the matching personality id.

```yaml
personalities.engineer-paired.retention.messages: 730d
personalities.engineer-paired.retention.traces: 180d
```

Notes:

- Only the `retention` sub-block is parsed under `personalities.<id>.*`. Other top-level keys cannot be overridden per personality from this file — set them in the personality's own `config.yaml`.

## logs.rotation {#logs-rotation}

Type: object · Default: `{ maxBytes: 10485760, maxFiles: 5, enabled: true }`

Controls rotation of `~/.ethos/logs/errors.jsonl`. When the file exceeds `maxBytes`, it is renamed to `errors.jsonl.1` and older backups shift up to `maxFiles`.

| Key | Type | Default | Description |
|---|---|---|---|
| `logs.rotation.maxBytes` | integer | `10485760` (10 MiB) | Maximum file size before rotation. Must be a positive integer. |
| `logs.rotation.maxFiles` | integer | `5` | Maximum number of rotated backup files. Must be a positive integer. |
| `logs.rotation.enabled` | boolean | `true` | Set to `false` to disable rotation entirely. |

```yaml
logs.rotation.maxBytes: 20971520
logs.rotation.maxFiles: 10
logs.rotation.enabled: true
```

## security.trusted_github_orgs {#security-trusted-github-orgs}

Type: comma-separated list · Default: `ethosagent, anthropic`

The GitHub organizations whose skills and plugins install at the `trusted-repo` trust tier. Everything else on `github.com` installs at `community`. The value **replaces** the default list rather than extending it, so removing an organization you do not trust — including either shipped default — is expressible. Matching is exact on the organization path segment; `github.com/ethosagent-evil/x` does not match `ethosagent`, and any path containing `.` or `..` is refused outright.

```yaml
security.trusted_github_orgs: acme-corp, ethosagent
```

An explicitly empty value trusts no organization. It is a real setting, not the same as leaving the key out — an absent key keeps the shipped default in force.

```yaml
security.trusted_github_orgs: ""
```

Notes:

- `trusted-repo` lets an operator force past a red scanner finding with `--force`. It does **not** silently accept yellow findings — only `builtin` (code shipped inside Ethos itself) does that. Adding an organization here grants an override lever, not a scan bypass.
- Organization names are case-sensitive here. Write the organization exactly as it appears in the `github.com/<org>/<repo>` path.
- The list is read at the composition root and passed into the scanner. Defined in [`packages/safety/scanner/src/trust-tiers.ts`](https://github.com/ethosagent/ethos/blob/main/packages/safety/scanner/src/trust-tiers.ts).

## evolver.cron_enabled {#evolver-cron-enabled}

Type: boolean · Default: `false`

When `true`, registers an in-process cron job that runs `ethos evolve run --quiet` on the schedule defined by [`evolver.schedule`](#evolver-schedule). The cron job executes inside the chat process — no separate daemon.

```yaml
evolver.cron_enabled: true
```

## evolver.schedule {#evolver-schedule}

Type: string (5-field cron expression) · Default: `"0 3 * * *"`

Controls when the evolve cron fires. Only meaningful when [`evolver.cron_enabled`](#evolver-cron-enabled) is `true`.

```yaml
evolver.schedule: 0 3 * * *
```

Notes:

- Skill evolution config that is per-personality (e.g. `skill_evolution.enabled`, `skill_evolution.min_tool_calls`) lives in the [personality config.yaml](./personality-yaml.md#skill-evolution), not here. The evolver cron keys above control the global schedule; the personality keys control which personalities participate and when.

## voice.tier {#voice-tier}

Type: `pipeline` | `realtime` · Default: unset (the surface decides)

The deployment's default voice engine. `pipeline` — speech-to-text → the agent turn → text-to-speech, the only tier local providers can serve, and the explicit private/offline mode. `realtime` — one hosted speech-to-speech session owns listening and speaking together. Unset means "try realtime where a provider is configured, otherwise pipeline". An unrecognised value is ignored rather than thrown on, so a typo cannot make the config unloadable. A personality's own [`voice.tier`](./personality-yaml.md#voice) beats this.

```yaml
voice.tier: realtime
```

Only an explicit `pipeline` refuses a realtime call outright — the browser is told `pipeline_preferred` and continues silently, because nothing went wrong. Editable in **Settings → Voice**, along with every key below.

## voice.realtime.providers.\<name\>.\* {#voice-realtime-providers}

Type: dotted roster · Default: unset (no realtime provider)

Named hosted speech-to-speech engines. `<name>` is a label you choose — a personality points at it by name, and [`voice.realtime.default`](#voice-realtime-default) names the one everything else uses. Labels are restricted to `[A-Za-z0-9_-]+`. There is no `auxiliary.*` fallback for this roster: no entry means no realtime tier.

| Field | Type | Description |
|---|---|---|
| `provider` | string | Registered provider id. Required. `openai-realtime` — OpenAI Realtime, 24 kHz in and out, issues browser credentials. `gemini-live` — Gemini Live, 16 kHz in / 24 kHz out, **cannot serve a browser call** (see the note below). |
| `model` | string | Provider model id. Defaults to `gpt-realtime` for `openai-realtime`. |
| `apiKey` | string | The provider key. Use a [`${secrets:...}`](./secrets-resolver.md) reference rather than a literal. |
| `baseUrl` | string | Override the provider's endpoint. |
| `voice` | string | Default voice id for this entry. The speaking personality's own `voice.tts_voice` beats it — switching tiers must not switch who you are talking to. |
| `costPerMinuteUsd` | float | The provider's published rate, typed by you. A realtime session bills by wall-clock audio time, so this is the only number that turns duration into money, and the only thing [`voice.realtime.sessionBudgetUsd`](#voice-realtime-session-budget) can act on. Absent = no rate known, nothing accrues, and a budget cannot bite. |

```yaml
voice.realtime.providers.live.provider: openai-realtime
voice.realtime.providers.live.model: gpt-realtime
voice.realtime.providers.live.apiKey: ${secrets:voice/realtime/providers/live/apiKey}
voice.realtime.providers.live.costPerMinuteUsd: 0.06
```

Notes:

- **The label buys nothing.** The [local-only egress gate](#voice-trusted-plugins) keys on the entry's `provider` and the constructed provider's own `caps.local`, so an entry named `local-realtime` backed by a hosted model is refused before a session opens. List the **provider id** in `voice.trustedPlugins`, not the label.
- **`gemini-live` is contract-only in this release.** It proves the provider contract is not OpenAI-shaped and is exercised by the shared conformance suite, but it declares `caps.ephemeralToken: false` — there is no browser credential to mint, and no server-relay path ships in this phase. A browser call selecting it is refused with `no_browser_token` and continues on the pipeline tier behind a visible notice. This is a stated limitation, not a bug.

## voice.realtime.default {#voice-realtime-default}

Type: string · Default: unset

Which [roster entry](#voice-realtime-providers) a call uses when the personality names none — `voice.realtime.default: live` for the example above. A **label** from that roster, never a provider id. Naming an entry the deployment does not have is reported as `unknown_entry` and the call continues on the pipeline.

## voice.realtime.sessionBudgetUsd {#voice-realtime-session-budget}

Type: float (USD) · Default: unset (no cap) · Must be `> 0`

Spending cap on **one** realtime session — the entry's `costPerMinuteUsd` times the session's audio minutes, plus what any `agent_consult` turns spent. On reaching it the session speaks a short sign-off and *then* closes, in that order, and the call strip shows a `budget reached` chip. A session on an entry with no `costPerMinuteUsd` accrues nothing, so this cap never fires for it.

```yaml
voice.realtime.sessionBudgetUsd: 1.50
```

Notes:

- A lowered cap takes effect on the next call; **removing** a cap takes effect on restart. Where the live read and the boot snapshot disagree, the boot cap stands — the direction to be wrong in when the subject is money.
- The personality's own [`budgetCapUsd`](./personality-yaml.md#budget-cap-usd) also governs this lane; the lower of the two binds.

## voice.trustedPlugins {#voice-trusted-plugins}

Type: comma-separated provider ids · Default: key absent (gate off)

The local-only egress gate. **Declaring the key at all arms it** — an empty value therefore means "trust nothing non-local" and is not the same as omitting the key. Providers advertising `caps.local` (`local-stt`, `local-tts`, `command-stt`, `command-tts`) always pass; every other provider must be named by its **provider id**. A refused provider fails at resolution, before it is handed a byte, on every surface — gateway, browser, `ethos doctor`, and the realtime mint.

```yaml
voice.trustedPlugins: openai-tts, openai-realtime
```

Notes:

- **Settings → Voice → Restrict voice egress** arms the gate and edits the list. The declared-but-empty form is the one shape it cannot write (the web config writer drops empty values) — set that line by hand.
- The refusal reads `<kind> provider "<id>" is not local and is not in voice.trustedPlugins — refusing to send audio off this machine`. See [Keep voice on this machine](../how-to/local-voice.md#keep-voice-on-this-machine).

## voice.defaultMode {#voice-default-mode}

Type: `off` | `mirror_inbound` | `all` · Default: `mirror_inbound`

Where a conversation starts on spoken replies, on any channel whose adapter declares voice output — Telegram, Slack, Discord, and WhatsApp today.

- `off` — never speak.
- `mirror_inbound` — speak back when spoken to (default).
- `all` — speak every reply.

An unrecognised value is ignored. Change it per conversation in chat with `/voice off|mirror_inbound|all`; that choice is written to `~/.ethos/voice/lane-modes.json` and outlives both `/new` and a gateway restart. A channel switched off with [`voice.channels.<platform>.ttsOut: false`](#voice-channels-tts-out) stays silent even in `all`. See [Send and receive voice notes on a channel](../how-to/voice-notes-on-channels.md).

```yaml
voice.defaultMode: all
```

## voice.channels.\<platform\>.ttsOut {#voice-channels-tts-out}

Type: boolean, keyed by platform id · Default: unset (the platform follows [`voice.defaultMode`](#voice-default-mode))

Which channels may speak their replies. Accepted platform ids are `telegram`, `slack`, `discord`, `whatsapp`, and `email` (`VOICE_CHANNEL_PLATFORMS` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts)); an unknown id or a non-boolean value is dropped on read, so a typo cannot invent a channel entry no adapter will act on.

An explicit `false` is an operator decision and outranks the conversation's mode — `/voice all` in a silenced Slack channel still produces text only. An explicit `true` changes nothing on its own; the conversation's mode still decides when to speak.

```yaml
voice.channels.slack.ttsOut: false
voice.channels.whatsapp.ttsOut: true
```

Notes:

- `email` is accepted by the parser but has no voice sink — the email adapter declares no voice caps, so the value is inert.
- Editable in **Settings → Voice**, one switch per channel.

## voice.transcode.\<field\> {#voice-transcode}

Type: dotted group · Default: the per-field defaults below

The ffmpeg stage that normalizes inbound audio before speech-to-text and converts synthesized replies into the container each adapter declared. `ffmpeg` is an **optional** runtime dependency of `ethos gateway start`: without it, audio already in an accepted format still passes through untouched, everything else is skipped rather than delivered unplayable, and the gateway prints `⚠ ffmpeg not found` once at startup.

| Field | Type | Default | Description |
|---|---|---|---|
| `ffmpegPath` | string | `ffmpeg` (resolved on `PATH`) | Path or name of the binary. Set it when ffmpeg is installed somewhere the gateway's `PATH` does not reach. |
| `bitrateKbps` | integer | `32` | Target bitrate for compressed containers (opus, mp3, aac). Must be an integer in `8`–`320`; a value outside that range, or a non-integer, is **dropped, not clamped**, and the default stands. 32 kbps is a speech setting — raise it only if you are shipping music. |
| `timeout` | integer (**seconds**) | `30` | Budget for one ffmpeg invocation. Must be an integer in `1`–`600`; out-of-range values are dropped. Note the unit: the key is seconds, the internal option is milliseconds. |

```yaml
voice.transcode.ffmpegPath: /opt/homebrew/bin/ffmpeg
voice.transcode.bitrateKbps: 48
voice.transcode.timeout: 45
```

Notes:

- Only the outbound leg reads `bitrateKbps`. Inbound normalization targets the STT provider's preferred container, which is `wav` wherever the provider accepts it.
- Editable under **Settings → Voice → Advanced**.

## voice.artifacts.\<field\> {#voice-artifacts}

Type: dotted group · Default: the per-field defaults below

Retention for synthesized voice notes held on disk under `~/.ethos/voice/artifacts/`. An artifact is written before the send and deleted the moment its delivery obligation is confirmed, so in a healthy deployment this directory is empty; these two keys bound what happens to the recordings whose delivery is never confirmed. Both are enforced by `Gateway.pruneVoiceArtifacts()`, which runs at boot and hourly.

| Field | Type | Default | Description |
|---|---|---|---|
| `abandonAfterDays` | integer (days) | `7` | Give up on an undelivered obligation after this long and delete its recording. Must be an integer in `1`–`365`; out-of-range values are dropped, not clamped. |
| `maxTotalMb` | integer (MiB) | `512` | Total on-disk cap for the artifact directory, evicting oldest-first once exceeded. The backstop for runaway accumulation when neither delivery nor abandonment has fired. Must be an integer in `1`–`102400`; out-of-range values are dropped. |

```yaml
voice.artifacts.abandonAfterDays: 3
voice.artifacts.maxTotalMb: 128
```

Notes:

- Redelivery re-sends the stored recording rather than synthesizing a second one — see [Why does a redelivered voice note re-send the recording?](../../building/explanation/why-voice-replies-redeliver.md). Shortening `abandonAfterDays` shortens the window in which that repair is still possible.
- Editable under **Settings → Voice → Advanced**.

## voice.livekit.\<field\> {#voice-livekit}

Type: dotted group · Default: unset — no LiveKit transport

LiveKit project credentials. Required for telephony: [`voice.trunk`](#voice-trunk) names the trunk, and this block carries the credentials Ethos signs its SIP control-plane requests with.

| Field | Type | Description |
|---|---|---|
| `url` | string | LiveKit server URL. Write the WebSocket form (`wss://…`); the SIP control plane normalizes it to `https://` itself, so one key serves both legs. |
| `apiKey` | secret ref | LiveKit project API key. |
| `apiSecret` | secret ref | LiveKit project API secret. Signs the JWTs on the SIP control plane and on room access tokens. |

```yaml
voice.livekit.url: wss://<your-project>.livekit.cloud
voice.livekit.apiKey: ${secrets:voice/livekit/apiKey}
voice.livekit.apiSecret: ${secrets:voice/livekit/apiSecret}
```

Notes:

- **All three are required together.** A partial block is a parse error, not a half-configured transport.
- These credentials make the SIP trunk client and the token minter **constructible** — no SDK and no native binary are involved. Room **audio** is a separate leg needing `@livekit/rtc-node` installed on the host; without it a call is answered, gated and logged but carries no voice. See [Give an agent a phone number](../how-to/answer-phone-calls.md#3-install-the-media-binding).
- Editable under **Settings → Voice → LiveKit**.

## voice.bots.\<i\>.\<field\> {#voice-bots}

Type: indexed dotted list · Default: none — no number or room reaches a personality

Which number or LiveKit room each agent answers. This *is* the telephony routing table — there is no separate number-to-personality mapping. It mirrors `telegram.bots[]`, except `match` replaces `token`: a voice bot has no platform token.

| Field | Type | Description |
|---|---|---|
| `match` | string | Required. E.164 number or LiveKit room name this bot answers. `*` is the only wildcard and matches any run of characters; the pattern is anchored, so it must match the whole value. |
| `bind.type` | `personality` \| `team` | Required. What answers. |
| `bind.name` | string | Required. The personality id or team name. |
| `id` | string | Stable key used in the lane key (`voice:<botKey>:sip:<caller>`) and in the call log. Defaults to a short sha256 of `match` — set it explicitly if you want the key to survive a number change. |

```yaml
voice.bots.0.match: "+15550000000"
voice.bots.0.bind.type: personality
voice.bots.0.bind.name: receptionist
voice.bots.1.match: "+1555*"
voice.bots.1.bind.type: personality
voice.bots.1.bind.name: engineer
```

Notes:

- **First match in config order wins**, so a specific number can precede a broad wildcard — as in the example above.
- An entry missing `match`, `bind.type` or `bind.name` is a parse error naming its index.
- A dialled number matching no entry is not dropped silently: the call is logged `screened` with reason `no_bot_match` and the owner is notified.
- A `team`-bound voice bot has no single personality to pin, so a call to it falls through to the deployment's default.
- Editable under **Settings → Voice → Numbers**.

## voice.trunk.\<field\> {#voice-trunk}

Type: dotted group · Default: no trunk — telephony is off

The SIP trunk that gives an agent a phone number. A rented PSTN number on a trunk provider is pointed at LiveKit SIP, so an inbound or outbound call arrives as one more room participant. Which number reaches which [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) is not configured here — a [`voice.bots[]`](#voice-bots) entry whose `match` is an E.164 pattern *is* that mapping.

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | enum | — | Required. Selects which inbound-webhook signature scheme the gateway's call listener verifies with; the providers do not agree on how a request is signed, and that is the one fact the verifier cannot read off the payload. Values below. An unrecognised value is a parse error and the whole trunk block is dropped. |
| `trunkId` | string | — | Required. The LiveKit SIP trunk id the number is attached to, used on both the inbound and the outbound leg. |
| `fromNumber` | string (E.164) | unset | Caller-ID presented on an outbound `call`. Read by the `call` tool; a trunk with no `fromNumber` dials with whatever the provider defaults to. |
| `username` | string | unset | SIP registrar username for outbound trunk auth. |
| `password` | secret ref | unset | SIP auth password. Must be written as `${secrets:voice/trunk/password}` — `writeConfig` moves a plaintext value into the vault under that ref, and loading a config with a plaintext value here fails. Authenticates **us to the trunk**, on the outbound leg. |
| `webhookSecret` | secret ref | unset | Shared secret the inbound-call listener verifies the trunk's request signature against. Same vault handling as `password`, under `${secrets:voice/trunk/webhookSecret}`. Authenticates **the trunk to us**, on the inbound leg — a deployment rotating one is not forced to rotate the other. |
| `webhookPath` | string | unset | HTTP path the listener mounts the trunk webhook at. Must start with `/`; anything else is a parse error. Left unset, the listener applies its own default. |
| `codec` | enum | unset | Preferred call codec. Values below. **Parsed and validated, but read by nothing today** — the media leg does not negotiate from it. Declaring it changes only what `ethos config print` echoes back. |

`provider` values:

- `twilio` — a Twilio Elastic SIP Trunk.
- `telnyx` — a Telnyx SIP connection.
- `livekit` — LiveKit's own SIP service signs the webhook.
- `generic` — any other trunk. No provider-specific signature scheme is applied, so pair it with a network-level control.

`codec` values:

- `opus` — wideband, where the trunk carries it. The better ear.
- `g711` — the narrowband PSTN codec every trunk speaks. The fallback. (Ethos ships a μ-law and A-law codec, but nothing selects between the two from this key yet.)

```yaml
voice.trunk.provider: livekit
voice.trunk.trunkId: ST_1
voice.trunk.fromNumber: +15550000000
voice.trunk.webhookSecret: ${secrets:voice/trunk/webhookSecret}
voice.trunk.webhookPath: /voice/inbound
voice.trunk.codec: opus
```

Notes:

- `provider` and `trunkId` are required together. A block carrying one without the other is a parse error and the trunk is dropped — telephony stays off rather than half-configured.
- Removing the whole block does **not** delete `voice/trunk/password` or `voice/trunk/webhookSecret` from the vault. Drop them with `ethos secrets remove <ref>` if the credentials are retired.

## voice.inbound.\<field\> {#voice-inbound}

Type: dotted group · Default: no policy — the consumer's own defaults apply

A phone number is the one surface strangers reach without being invited. This block is the answering policy: who gets through, what a call may cost, and where the summary lands. Callers outside `allowlist` are answered by `receptionist` in a restricted scope — no owner memory, no privileged tools — and are refused outright when no `receptionist` is set.

| Field | Type | Default | Description |
|---|---|---|---|
| `allowlist` | comma-separated list | unset | Caller numbers that reach the owner's own personality. E.164 patterns using the same `*` wildcard grammar as [`voice.bots[].match`](#voice-bots), matched against the whole number. Entries are trimmed and empties dropped. Unset means nobody is allowlisted — every caller goes to `receptionist`, or is refused if there is none. |
| `receptionist` | string | unset | Personality id answering callers that are not on the allowlist. Its own `memoryScope` and `toolset` *are* the restriction; there is no second restriction system. Unset makes a non-allowlisted call a refusal (`screened`, reason `not_allowlisted`) rather than a screened conversation. |
| `concurrencyCap` | integer | `2` | Ceiling on concurrent inbound calls; callers over the cap get busy handling and the owner is notified. Must be a positive integer — `0` and fractions are parse errors, not "no cap". |
| `perCallerPerHour` | integer | unset | Per-caller call ceiling inside a rolling hour, evaluated over a sliding window. Positive integer. |
| `dailyBudgetUsd` | number | unset | Spend ceiling in USD per day across all inbound calls, reset on the UTC day boundary. Must be greater than zero. Counts **LLM token spend only**, at the provider's own estimate — STT, TTS, LiveKit media and PSTN minutes are not in the total, so the cap trips on real spend but trips late relative to a day's true cost. Browser talk-mode and channel voice notes do not route through the call dispatcher and never count against it. |
| `prewarm` | enum | `allowlisted` | Which callers *would* get the realtime provider socket opened during ring. **Decided per call and acted on by nothing today** — the SIP↔realtime bridge is built and unit-tested but has no production caller, so no socket is opened on ring or on answer. Values below. |
| `owner.platform` | string | unset | Platform id the call summary and capacity notices are delivered on, e.g. `telegram`. |
| `owner.chatId` | string | unset | Chat id on that platform. |
| `owner.botKey` | string | unset | Which bot sends the notice, in a multi-bot deployment. |

`prewarm` values:

- `allowlisted` — pre-warm on ring for known callers only, and warm on answer for everyone else. No provider spend on calls that may be screened.
- `none` — always warm on answer. Cheapest; the caller hears a beat of dead air.
- `all` — warm every ring, including the ones that get screened.

```yaml
voice.inbound.allowlist: +1555123*, +447700900000
voice.inbound.receptionist: receptionist
voice.inbound.concurrencyCap: 3
voice.inbound.perCallerPerHour: 5
voice.inbound.dailyBudgetUsd: 12.50
voice.inbound.prewarm: allowlisted
voice.inbound.owner.platform: telegram
voice.inbound.owner.chatId: 4242
```

Notes:

- **Malformed values are parse errors, not ignored.** Unlike the `voice.wake.*` knobs, a bad value here drops the whole `voice.inbound` block and reports the offending key. A silently-dropped budget or concurrency cap costs real money on a surface strangers can dial.
- `owner.platform` and `owner.chatId` are required together. One without the other is a parse error naming the missing key, rather than a half-built destination that quietly drops the notification this block exists to deliver.
- **An explicitly empty allowlist is not expressible.** A flat `key: value` line with no value does not parse, so `voice.inbound.allowlist:` and an absent key are the same file. Set `voice.inbound.receptionist` and leave `allowlist` out — that *is* the screen-everyone policy.
- An unrecognised field name under `voice.inbound.` is a parse error, so a typo cannot look configured while doing nothing.
- Gates run cheapest-refusal-first: daily budget → per-caller rate → concurrency → allowlist. A refusal releases whatever it took, so a wall of refused calls leaves the concurrency counter at zero rather than wedging the line.
- The end-to-end behaviour of every key here is in [Give an agent a phone number](../how-to/answer-phone-calls.md).

## voice.bargeIn.\<surface\>.\<field\> {#voice-barge-in}

Type: dotted group, keyed by surface · Default: the consumer's own thresholds

How eagerly the agent stops talking when it hears you, tuned per audio surface. A phone line is noisier than a room and a satellite sits across that room, so one global threshold is wrong on at least one of the two.

Two surfaces: `call` (telephony) and `satellite` (a [wake satellite](../../getting-started/glossary.md#wake-satellite) — a separate process that owns a microphone). Any other surface name is a parse error.

`call` reaches the SIP lane's VAD and endpoint detector. `satellite` reaches the `ethos listen` microphone's VAD.

Browser talk-mode is not tuned here. The web talk lane endpoints in the browser, from the [`display.voice_*`](#display-voice) keys.

| Field | Type | Range | `call` | `satellite` | Description |
|---|---|---|---|---|---|
| `energyThreshold` | number | `0` exclusive – `1` inclusive | read | read | Input energy above which the far end counts as speaking. Higher tolerates more line noise and makes barge-in harder to trigger. |
| `minSpeechMs` | integer (ms) | ≥ 1 | read | read | How long that energy must persist before the barge-in is believed. The cough filter. |
| `silenceMs` | integer (ms) | ≥ 1 | read | **not read** | How long silence must last to end an utterance. |

```yaml
voice.bargeIn.call.energyThreshold: 0.4
voice.bargeIn.call.minSpeechMs: 220
voice.bargeIn.call.silenceMs: 700
voice.bargeIn.satellite.energyThreshold: 0.2
```

Notes:

- Every field is optional per surface — tune the one knob a room is wrong about, not all three. Only the surfaces you declare are present in the parsed config; the rest keep the consumer's defaults.
- `voice.bargeIn.satellite.silenceMs` is accepted and read by nothing. A satellite ends an utterance on a count of silent audio *frames*, and a frame is only a duration once the capture device reports its frame size — there is no conversion the config layer can do honestly. To make a satellite wait longer before replying, there is no knob today.
- Out-of-range values and unknown field names are parse errors that drop the whole `voice.bargeIn` block. A threshold typed against a misspelled surface is not a slightly different setting — it is no tuning at all, and the operator would only learn that from a line the agent kept talking over.
- `voice.bargeIn.browser.*` parsed in earlier releases and reached nothing. It is now a parse error naming `display.voice_*` as the replacement. Delete the key; the whole `voice.bargeIn` block is dropped while it is present.

## display.voice_\<field\> {#display-voice}

Type: flat keys · Default: per field below

Endpointing and barge-in for talk-mode in the web UI. This is the browser counterpart to [`voice.bargeIn`](#voice-barge-in) — the web talk lane runs its detector in the browser, so these are the keys it reads.

Edit them in Settings → Voice → Advanced voice tuning, or write them directly.

| Key | Type | Default | Range | Description |
|---|---|---|---|---|
| `display.voice_endpoint_silence_ms` | integer (ms) | `700` | 300 – 1500 | How long you pause before the agent replies. |
| `display.voice_barge_threshold` | number | `0.06` | 0.02 – 0.2 | Input energy that counts as interrupting the agent while it speaks. Lower is easier to interrupt. |
| `display.voice_barge_sustain_ms` | integer (ms) | `250` | 100 – 800 | How long that energy must persist before the interruption is believed. |
| `display.voice_speech_threshold` | number | `0.02` | 0.005 – 0.1 | Input energy that counts as speech at all. Lower picks up quieter speech. |
| `display.voice_speech_min_ms` | integer (ms) | `150` | 100 – 500 | Ignore bursts shorter than this. |

```yaml
display.voice_endpoint_silence_ms: 900
display.voice_barge_threshold: 0.08
```

Notes:

- A value saved through Settings is clamped to the range. A value that will not parse as a number falls back to the default rather than failing the load — these keys are read on every talk-mode turn, so a typo must not take the lane down.
- The five keys are independent. Set the one that is wrong; the rest keep their defaults.

## voice.wake.\<field\> {#voice-wake}

Type: dotted group · Default: the per-field defaults below

Deployment-wide settings for [wake satellites](../../getting-started/glossary.md#wake-satellite) — separate processes that own a microphone and connect to the web API at `GET /satellite/ws`. The whole group is pushed to every connected satellite in a `routes` frame on connect, and again whenever Settings is saved.

Out-of-range numbers and unrecognised engine ids are **ignored, not clamped** — the default stands and the rest of the file still loads, so one typo cannot make a deployment unconfigurable.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch for the whole fleet. Only an explicit `false` turns wake off; the key's absence means the operator never disabled it, not that they disabled it. ANDed with the per-node `voice.wake.nodes.<id>.enabled` — either one saying no means no. |
| `engine` | enum | `fallback` | Which matcher a satellite runs. Any other value is ignored. Per-value meanings below. |
| `sensitivity` | number | `0.5` | Match threshold, `0`–`1`. Higher tolerates more transcription slip and produces more false accepts; `0` demands an exact match. A value outside the range is dropped. |
| `confirmationFrames` | integer | `2` | Consecutive agreeing frames before an acoustic spot counts — the false-accept damper. Must be an integer in `1`–`10`. Ignored by the `fallback` engine, which decides a transcript once and has nothing to confirm. |
| `edgeStt` | boolean | `false` | Ask satellites to transcribe on-device and send text instead of audio. The node's probed capability is the veto: neither shipped host has an on-device recognizer, so both report `edgeStt: false` and the server ANDs this down to false. |
| `idleTimeout` | integer (**seconds**) | `30` | How long a conversation stays open, in two places. On a satellite it ends the LISTENING state. On the server it bounds the **addressing window**: after a wake phrase picks a personality, further utterances within this long reach that same personality with no phrase. Must be an integer in `5`–`600`. It ends listening and addressing **only** — never the session, so a re-wake an hour later resumes the same conversation with its history. |

`engine` values:

- `fallback` — the built-in transcript matcher (it names itself `transcript` in `ethos listen doctor` rows). Matches wake phrases against recognized text *after* speech-to-text, so it loads no native binding and no model file. The default.
- `sherpa` — sherpa-onnx keyword spotting in the acoustic stream, *before* recognition. Requires the optional peer `sherpa-onnx-node` (a per-architecture native binary, roughly 33 MB, deliberately not a repo dependency) plus `encoder.onnx`, `decoder.onnx`, `joiner.onnx` and `tokens.txt` in `~/.ethos/models/wake/`. The adapter is written against sherpa's documented `KeywordSpotter` surface and has not been run against a real binary in this repository.
- `openwakeword` — accepted by the parser; **no such engine ships**. `ethos listen doctor` reports it unavailable by name rather than falling through to another engine.

```yaml
voice.wake.engine: fallback
voice.wake.sensitivity: 0.6
voice.wake.confirmationFrames: 3
voice.wake.idleTimeout: 45
```

Notes:

- **Which host reads what.** The desktop satellite matches phrases itself, so it applies `sensitivity`, `confirmationFrames`, `idleTimeout` and `enabled` from the pushed frame each time it arms capture. `ethos listen` matches nothing, so it ignores the pushed `sensitivity` and `confirmationFrames` and reads `idleTimeout` for its capture machine from its own `config.yaml`; with the key absent there, the capture machine's own 300-second default applies rather than the 30 seconds the server reports.
- **`sensitivity` and `idleTimeout` are also server-side.** For a satellite that does not match phrases itself — `ethos listen` — the server runs the match, so `sensitivity` governs how much transcription slip a phrase tolerates and `idleTimeout` governs the addressing window. Both are read from this file on the server, not from the satellite's.
- **Read-only in the UI.** Settings → Voice shows these values and does not write them; the route table below is what the web editor edits. Change the scalars in this file.
- The `~/.ethos/models/wake/` directory is probed on every `ethos listen doctor` run. A missing directory is a warning for a `fallback` host and a hard failure for a `sherpa` one.

## voice.wake.routes.\<id\>.\<field\> {#voice-wake-routes}

Type: dotted group, keyed by route id · Default: no routes

The phrase → personality table. The route id is yours to choose and must match `[A-Za-z0-9_-]+`; an id outside that charset is dropped, because a key the serializer could not write back would corrupt the file later.

| Field | Type | Default | Description |
|---|---|---|---|
| `phrase` | string | — | The spoken trigger, e.g. `engineer`. Required. Matched with an optional leading greeting on either side — `hey`, `hi`, `hello`, `ok`, `okay`, `yo`, `hey there` — so a phrase written `engineer` also answers to "hey engineer", and one written `hey engineer` also answers to "engineer". Write it without the greeting; the two spellings are one trigger, so two routes differing only by a greeting can never both fire — the first in the table wins. |
| `personality` | string | — | Personality id this phrase wakes. Required. Resolved against the live registry at wake time, so a route naming a deleted or renamed personality is refused rather than silently defaulted. |
| `privileged` | boolean | `false` | Opt-in required before a **privileged** personality is reachable by voice — one whose toolset can reach a tool the approval layer would stop and ask about. See [Why can't a voice in the room reach a privileged personality?](../explanation/wake-privilege.md). |
| `enabled` | boolean | `true` | Switch a route off without deleting it. |

```yaml
voice.wake.routes.kitchen.phrase: engineer
voice.wake.routes.kitchen.personality: engineer
voice.wake.routes.kitchen.privileged: true
```

Notes:

- A route missing `phrase` **or** `personality` is dropped entirely rather than half-built — a half-route would look configured in the Settings table and never fire.
- **The phrase must open the utterance.** Matching is head-anchored and word-aligned, so "so I said hey engineer to nobody" does not fire. The longest matching phrase wins, and the matched words — the greeting included — are stripped before the turn runs, so `engineer, did CI pass` and `hey engineer, did CI pass` both reach the agent as `did CI pass`.
- **Implicit routes.** Every unprivileged personality also answers to its own name, synthesized server-side and never written to this file. Those carry the id `auto:<personalityId>` — outside the charset above, so they can never collide with one of yours. A configured route naming a personality suppresses that personality's implicit route, including a route you set to `enabled: false`.
- Saving the table in **Settings → Voice → Wake routes** pushes it to every connected satellite. Hand-editing this file applies on the next satellite reconnect or server restart; nothing watches the file.
- Implicit routes are shown in the Settings editor and cannot be saved back — they are not entries in this file.

## voice.wake.nodes.\<id\>.\<field\> {#voice-wake-nodes}

Type: dotted group, keyed by node id · Default: no overrides

Per-satellite overrides. The key is the node's own stable id, which it generates once and persists in `~/.ethos/listen-node-id` on that machine — `ethos listen doctor` prints it on the `node id` row.

| Field | Type | Default | Description |
|---|---|---|---|
| `inputDevice` | string | unset | Host-specific capture device id. **Pushed on the wire and read by no shipped host today** — `ethos listen` enumerates only its stdin pipe, and the desktop host has no capture device at all. |
| `enabled` | boolean | `true` | Switch one microphone off without touching the others. ANDed with the fleet-wide `voice.wake.enabled`. |

```yaml
voice.wake.nodes.pi-kitchen-f089dce2.enabled: false
```

Notes:

- An entry with no recognised field is dropped rather than kept as an empty object.
- A node muted from its Settings row is muted over the wire instead, and the satellite persists that choice across restarts — that path does not write this key.

## background.acp.agents.\<name\>.\* {#background-acp-agents}

Type: dotted roster · Default: unset (no ACP-native coding-agent job runners)

Real [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) coding-agent CLIs a background job can run on — Claude Code's official adapter, Gemini CLI, and any other CLI that speaks ACP's `session/*` methods over stdio. `<name>` is the id the job registers under (a `delegate_task` call's `runner` parameter names it directly, e.g. `runner: 'claude'` or `runner: 'gemini'`); each configured entry becomes its own independent job runner, never a single shared `'acp'` runner with a sub-parameter.

| Field | Type | Description |
|---|---|---|
| `background.acp.agents.<name>.command` | string | The ACP agent binary to exec inside the sandbox container. Required — an entry missing `command` or `image` is dropped entirely rather than half-built. |
| `background.acp.agents.<name>.args` | comma-separated list | Arguments after `command`, e.g. the flag that puts the CLI into ACP mode. Optional. |
| `background.acp.agents.<name>.image` | string | Digest-pinned container image (`@sha256:...`) with `command` reachable inside it. Required. A bare tag does not satisfy the containment posture this needs — same reason `pi_image` must be digest-pinned. |

```yaml
background.acp.agents.claude.command: claude-agent-acp
background.acp.agents.claude.image: localhost:5555/ethos-acp-claude@sha256:...

background.acp.agents.gemini.command: gemini
background.acp.agents.gemini.args: --acp
background.acp.agents.gemini.image: localhost:5555/ethos-acp-gemini@sha256:...
```

Notes:

- `gemini`'s `--acp` is the CLI's own documented flag ("Starts the agent in ACP mode" per `gemini --help`); `--experimental-acp` also exists but is deprecated in favor of it.
- An entry with both `command` and `image` set registers immediately; there is no separate enable switch. Removing an entry (or its `image`) unregisters that runner — a job naming it then gets the same `not_available` answer a machine that never built the image would.
- Each entry needs its own container image with credentials for that agent mounted in — there is no shared auth story across entries. Neither agent's credential mount is wired yet.

## activeContext {#active-context}

Type: managed · Required: no

Managed by `ethos set personality <id>` / `ethos set team <name>`. The runtime writes two dotted keys: `activeContext.type` (`personality` | `team`) and `activeContext.name` (id or team name). Hand-editing is not supported — values are interpreted only when both keys are present and `type` is recognised.

## File location and permissions {#file-location}

`~/.ethos/config.yaml` is written by `ethos setup` and `ethos personality set`. The companion `~/.ethos/keys.json` (chmod 600) holds the rotation pool — manage it through `ethos keys`, not by hand.

The directory can be relocated with the `ETHOS_DIR` env var.

## See also {#see-also}

- [CLI reference](./cli.md) — every `ethos` subcommand and the flags that override what config.yaml sets
- [Personality config reference](./personality-yaml.md) — the per-personality `config.yaml` and `toolset.yaml` (different file, different schema)
- [How to configure providers](../how-to/configure-providers.md) — task-shaped recipe for switching between Anthropic, OpenAI, OpenRouter, and Ollama
- [Run multiple Telegram bots from one process](../how-to/run-multi-bot-telegram.md) — `telegram.bots` list shape in practice
- [Connect a Telegram bot to a team](../how-to/connect-telegram-to-team.md) — `bind.type: team` and `teams.*` knobs in practice
- [Local voice: Kokoro TTS + Whisper large v3 STT](../how-to/local-voice.md) — the `auxiliary.asr.*` / `auxiliary.tts.*` pipeline keys and the egress gate in practice
- [Send and receive voice notes on a channel](../how-to/voice-notes-on-channels.md) — the `voice.defaultMode` / `voice.channels.*` / `voice.transcode.*` keys in practice, plus the `/voice` command
- [Run a wake satellite](../how-to/run-a-wake-satellite.md) — the `voice.wake.*` keys in practice, and what `ethos listen` can and cannot do
- [Glossary: personality](../../getting-started/glossary.md#personality) — what the term means everywhere else in the docs
