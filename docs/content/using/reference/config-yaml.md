---
title: "config.yaml reference"
description: "Every field in ~/.ethos/config.yaml — provider, model, channel tokens, retention TTLs, provider chain."
kind: reference
audience: user
slug: config-yaml
updated: 2026-08-12
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
| `slack.apps.<i>.appToken` | string | — | `xapp-` app-level token for Socket Mode. Required per entry. |
| `slack.apps.<i>.signingSecret` | string | — | Signing secret for inbound webhook verification. Required per entry. |
| `slack.apps.<i>.id` | string | `sha256(botToken)[:24]` | Stable, human-readable app key. Used in session lane names and log output. Set once; do not change after the app goes live. |
| `slack.apps.<i>.bind.type` | `personality` \| `team` | — | Required. Same semantics as the Telegram equivalent. |
| `slack.apps.<i>.bind.name` | string | — | Required. Personality id or team name. |
| `slack.apps.<i>.bind.allowSlashSwitch` | boolean | `false` | Allow per-channel `/personality` switching. |

```yaml
slack.apps.0.botToken: "xoxb-..."
slack.apps.0.appToken: "xapp-..."
slack.apps.0.signingSecret: "abc123..."
slack.apps.0.id: eng-slack
slack.apps.0.bind.type: team
slack.apps.0.bind.name: eng
```

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
- [Glossary: personality](../../getting-started/glossary.md#personality) — what the term means everywhere else in the docs
