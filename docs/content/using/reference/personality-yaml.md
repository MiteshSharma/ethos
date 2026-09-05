---
title: "Personality config reference"
description: "Every field in a personality's config.yaml and toolset.yaml — model, fs_reach, MCP, plugins, budget, voice, safety."
kind: reference
audience: user
slug: personality-yaml
updated: 2026-09-05
---

A [personality](../../getting-started/glossary.md#personality) is a directory at `~/.ethos/personalities/<id>/` with three files:

| File | Purpose |
|---|---|
| `SOUL.md` | First-person identity prose. Loaded as the system-prompt baseline. Free-form markdown. |
| `config.yaml` | Flat `key: value` config — fields documented below. Dotted keys (e.g. `fs_reach.read`) express nested structure. |
| `toolset.yaml` | Flat YAML list of [tool](../../getting-started/glossary.md#tool) names this personality is allowed to call. |

An optional sibling file `tools.yaml` configures a tool per personality. It is **not** a field on the frozen `PersonalityConfig` schema (like `mcp.yaml`, it is a sibling artifact loaded by the registry), so it does not touch `.personality-field-count`. In v1 only `web_search` is configurable — it binds a provider and a **named secret**:

```yaml
# ~/.ethos/personalities/researcher/tools.yaml
web_search: { provider: exa, secret: exa-main }
```

`secret` is a NAME only (resolving to `providers/<provider>/<name>` in the vault) — never a value — so the directory stays shareable and committable ([§V S9](https://github.com/ethosagent/ethos/blob/main/ARCHITECTURE.md)). The personality's own `tools.yaml` is the source of truth; the global `~/.ethos/config.yaml` `toolSettings` map is a fallback layer for personalities (especially read-only built-ins) that don't declare the tool. Resolution order: `tools.yaml` → `toolSettings.<id>` → `toolSettings._default` → first backend with a key present.

## Source {#source}

The schema type lives in [`packages/types/src/personality.ts`](../../../../packages/types/src/personality.ts) (`PersonalityConfig`). The loader / parser lives in [`extensions/personalities/src/index.ts`](../../../../extensions/personalities/src/index.ts) — `parseConfigYaml` (flat keys + the `safety:` nested block), `parseToolsetYaml` (the `- name` list), and `parseToolsYaml` (the optional `tools.yaml` sidecar).

The schema is frozen — adding a top-level field requires the `personality-schema-change` PR label and a bump to `.personality-field-count`. Internal-only fields (`id`, `soulFile`, `skillsDirs`, `metadata`) are populated by the loader and are not user-editable.

## Minimal example {#minimal-example}

```yaml
# ~/.ethos/personalities/researcher/config.yaml
name: Researcher
description: Deep reading and synthesis.
model: claude-opus-4-7
```

```yaml
# ~/.ethos/personalities/researcher/toolset.yaml
- read_file
- write_file
- web_search
```

Memory is always per-personality — each personality reads and writes `~/.ethos/personalities/<id>/MEMORY.md` automatically. No configuration field is required.

## name {#name}

Type: string · Default: title-cased directory id · Required

Human-readable label. Surfaces in `ethos personality list`, the picker UIs, and the chat header.

```yaml
name: Engineer Paired
```

## description {#description}

Type: string · Default: unset

One-line summary shown in pickers and `ethos personality list`.

```yaml
description: Builds and ships features for this repo.
```

## model {#model}

Type: string · Default: top-level `config.yaml` `model`

Per-personality model override. Used by the LLM provider when this personality drives the turn. Falls back to the global `model` from `~/.ethos/config.yaml` when unset. The wiring layer also honours `modelRouting.<id>` from `config.yaml` — both routes converge on the same per-personality model.

```yaml
model: claude-opus-4-7
```

## provider {#provider}

Type: string · Default: top-level `config.yaml` `provider`

Per-personality provider override. Only meaningful when the wiring layer has the named provider registered.

```yaml
provider: openrouter
```

## platform {#platform}

Type: string · Default: unset

Channel binding hint. Recognised values (used by the load-time safety gate): `telegram`, `discord`, `slack`, `whatsapp`, `email`. Bound channels combined with `safety.approvalMode: off` are rejected at config load.

```yaml
platform: slack
```

## capabilities {#capabilities}

Type: comma-separated strings · Default: unset

Free-form capability tags. Surfaces to skill-filtering and adapter routing.

```yaml
capabilities: read, write, web
```

## streamingTimeoutMs {#streaming-timeout-ms}

Type: integer (ms) · Default: AgentLoop default (`120000`)

Watchdog for the LLM stream. If no chunk arrives within this many milliseconds, the agent aborts the stream and emits an `error` event. Reset on every chunk — slow-but-progressing streams are unaffected. Thinking-mode personalities (Opus extended thinking) typically need longer; fast personalities (Haiku) can pick tighter.

```yaml
streamingTimeoutMs: 300000
```

## execution {#execution}

Type: string · Default: unset (the deployment decides)

Execution requirement — what this personality demands of wherever its execution tools (`terminal`, `run_code`, `run_tests`, `lint`) run. Two values:

- `remote` — this personality's work belongs on a machine that is **not** the one Ethos runs on. Refused under a constitution that sets `execution.requireSandbox` or `execution.forbidLocal`: a remote host is trust, not confinement.
- `none` — this personality does not execute.

```yaml
execution: remote
```

A personality states a requirement; it never names a transport. `docker`, `local` and `ssh` are machine facts two deployments of the same personality reasonably disagree about — one runs inside a container, one has no Docker daemon, one has an ssh target — so the transport is the operator's, resolved from the environment, [`~/.ethos/config.yaml`](./config-yaml.md), and the constitution. Absent means no requirement at all: an exec-bearing personality is sandboxed by default, and runs in-process when Ethos is itself containerized.

- This is **not** the remote host. The target — host, user, port, identity file, known-hosts file, remote workdir — is operator config under `execution.ssh.*` in [`~/.ethos/config.yaml`](./config-yaml.md), one per deployment. Never put a hostname, user, or key path in this file.
- **A requirement this deployment cannot meet is refused, not downgraded.** `execution: remote` with no `execution.ssh.host` configured leaves the execution tools unavailable. It does not fall back to running the work here, whatever the constitution permits — a permitting constitution grants the host, which is the one machine this personality ruled out.
- `ethos personality show <id>` prints the requirement and the resolved transport on separate lines, so you can see both what was asked for and what you got.
- An unrecognised value is a load error, not a silent drop. So are the retired transport literals `ssh`, `docker` and `local`; the error names the replacement.
- The requirement is resolved when a loop is composed, so a change takes effect on restart.

## fs_reach.read / fs_reach.write {#fs-reach}

Type: comma-separated absolute paths · Default: AgentLoop fallback scope

Per-personality filesystem allowlist for the `read_file` / `write_file` tools. The runtime resolves these substitutions once per turn:

| Token | Resolves to |
|---|---|
| `${ETHOS_HOME}` | `~/.ethos` |
| `${self}` | This personality's id. |
| `${CWD}` | The personality's working directory — the **first** [`fs_reach.workdir`](#fs-reach-workdir) entry when declared, otherwise the process working directory. |

When unset, the fallback is:

```
read:  [~/.ethos/personalities/<self>/, ~/.ethos/skills/, ${CWD}]
write: [~/.ethos/personalities/<self>/, ${CWD}]
```

A declared list replaces the defaults for that direction — it is not merged with them. Paths outside the allowlist surface as a `BoundaryError` from `ScopedStorage` and are rendered as a user-facing tool error.

```yaml
fs_reach.read: ${CWD}, ${ETHOS_HOME}/skills, ${ETHOS_HOME}/personalities/${self}
fs_reach.write: ${CWD}, ${ETHOS_HOME}/personalities/${self}
```

Notes:

- Under the container execution posture, the derived read and write paths are the container's bind mounts (read-only and read-write respectively), so the app-layer allowlist and the OS-layer mount set never disagree.
- The active personality's derived write paths are created at startup if missing. Read-only paths are not — a read prefix that does not exist is simply an empty scope.
- Paths under `/proc`, `/sys`, `/dev`, or a Docker socket are never mounted into a container and are never pre-created.

## fs_reach.workdir {#fs-reach-workdir}

Type: one or more comma-separated absolute paths · Default: unset (the process working directory)

The personality's working directory. Each entry takes the same substitution tokens as `fs_reach.read` / `fs_reach.write` and resolves to an absolute path. The **first** entry is the personality's working directory and becomes `${CWD}` for the rest of the `fs_reach` derivation: every tool in the personality's toolset stands there, a bare relative path passed to `read_file` or `write_file` resolves against it, and the `terminal` tool runs its commands in it under both the local and the container execution posture.

```yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}
```

Declare several to give the [Documents tab](../how-to/retrieve-agent-files.md) several roots. Each entry becomes its own browsable root with its own containment boundary:

```yaml
fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}, /srv/reports
```

Notes:

- The first declared entry is added to both the derived read list and the derived write list, so it stays reachable even when `fs_reach.write` is declared and therefore replaces the defaults. Later entries are **not** — a second root is browsable from Documents but out of the agent's own reach until it is listed in `fs_reach.read` / `fs_reach.write` too.
- The dotted key is the only accepted syntax — an indented `fs_reach:` block is refused at load with `Top-level key "fs_reach" cannot be a nested object in personality config`.
- A token that resolves to an empty string refuses the turn with `FS_REACH_INVALID` rather than synthesizing a path at the filesystem root.
- Unset leaves the derivation untouched: the working directory is the process working directory and the read/write lists derive exactly as they did before this field existed. The Documents tab, which has no such fallback, shows the personality as unconfigured — see [`WORKDIR_NOT_CONFIGURED`](../../troubleshooting.md#error-reference).
- `ethos personality show <id>` prints the declared value (tokens unresolved) as a `Workdir` line under **Filesystem reach**.
- Files written here are retrievable from a browser — see [Retrieve files the agent wrote](../how-to/retrieve-agent-files.md). Files can be uploaded into the same directory — see [Upload a file into the agent's folder](../how-to/upload-agent-files.md).

## mcp_servers {#mcp-servers}

Type: space-separated strings · Default: unset (no MCP access)

MCP server names this personality may reach. Server configs live globally in `~/.ethos/mcp.json`; this is a per-personality allowlist. Missing or empty means no MCP access — explicit opt-in only.

```yaml
mcp_servers: github linear
```

Notes:

- Manage attachments interactively with `ethos personality mcp <id> --attach <name>` / `--detach <name>`.

## plugins {#plugins}

Type: space-separated strings · Default: unset (no plugins active)

Plugins attached to this personality. Default-deny: a plugin not listed here is dormant for this personality — its tools, hooks, and injectors do not fire.

```yaml
plugins: weather invoice-checker
```

Notes:

- Manage attachments interactively with `ethos personality plugins <id> --attach <id>` / `--detach <id>`.
- Use `ethos plugins` (plural) for the global attachment matrix.

## budgetCapUsd {#budget-cap-usd}

Type: float (USD) · Default: unset (no cap)

Per-session spending cap. When the running cost for the current session crosses this value, the next turn is refused with a typed `BUDGET_EXCEEDED` error. Session-scoped — resets on `/new` or `ethos chat` in a different working directory. Override mid-session with [`/budget reset`](./slash-commands.md#slash-budget).

```yaml
budgetCapUsd: 1.00
```

## context_engine {#context-engine}

Type: string · Default: `drop_oldest`

Context-compaction engine name. Resolved against the runtime's engine registry when the conversation approaches the model's context window. Unknown names fall back to the built-in `drop_oldest`.

```yaml
context_engine: summarize_oldest
```

## context_engine_options.\* {#context-engine-options}

Type: scalar (string / number / boolean) · Default: unset

Free-form per-engine options. Keys are dotted (`context_engine_options.<key>`); values are typed automatically — integers, floats, `true` / `false`, otherwise strings.

```yaml
context_engine_options.keep_last_n: 8
context_engine_options.summary_model: claude-haiku-4-5
```

## context_layering.* {#context-layering}

Workspace-aware context layering. Controls how `AGENTS.md` / `CLAUDE.md` files are discovered as the agent navigates the workspace.

| Field | Type | Default | Description |
|---|---|---|---|
| `context_layering.mode` | `static` \| `progressive` \| `off` | `static` | `static` loads context once at session start from `workingDir`. `progressive` also discovers sub-`AGENTS.md` as the agent reads / writes files; injected on the next turn. `off` skips context-file injection entirely. |
| `context_layering.max_depth` | integer | runtime default | Maximum directory depth to walk when discovering context files. |
| `context_layering.discovery_files` | comma-separated strings | `AGENTS.md, CLAUDE.md` | Filenames to scan for at each depth. |
| `context_layering.cap_total_chars` | integer | runtime default | Cap on the total character budget injected. |

```yaml
context_layering.mode: progressive
context_layering.max_depth: 3
context_layering.discovery_files: AGENTS.md, CLAUDE.md, SOUL.md
context_layering.cap_total_chars: 12000
```

## skill_evolution.* {#skill-evolution}

Auto-triggered skill evolution. When `enabled: true`, the skill-evolver auto-trigger queues an analysis after every turn that crosses the `min_tool_calls` threshold and is outside the cooldown window. The built-in `engineer` personality ships with it enabled (`min_tool_calls: 5`, `cooldown_minutes: 60`).

| Field | Type | Default | Description |
|---|---|---|---|
| `skill_evolution.enabled` | boolean | `false` | Master switch. Off by default — opt-in per personality. |
| `skill_evolution.min_tool_calls` | integer | runtime default | Minimum tool calls in a turn before evolution runs. |
| `skill_evolution.cooldown_minutes` | integer | runtime default | Cooldown between evolution runs. |
| `skill_evolution.model` | string | top-level `model` | Override which LLM the evolver uses for analysis. Falls back to the personality's model when unset. |

```yaml
skill_evolution.enabled: true
skill_evolution.min_tool_calls: 5
skill_evolution.cooldown_minutes: 60
skill_evolution.model: claude-sonnet-4-6
```

Notes:

- The global cron schedule for running the evolver lives in [`config.yaml`](./config-yaml.md#evolver-cron-enabled) (`evolver.cron_enabled`, `evolver.schedule`), not here. These personality-level keys control whether a personality participates and the per-turn trigger thresholds.

## safety {#safety}

Per-personality safety config. Unlike the other fields, `safety:` is a true nested block — YAML indentation matters here.

```yaml
safety:
  approvalMode: manual
  observability:
    storeToolArgs: redacted
    storeToolBodies: redacted
    storeLlmPayloads: metadata
    redactPatterns:
      - sk-ant-
      - sk-or-
```

### safety.approvalMode {#safety-approval-mode}

Type: `manual` | `smart` | `off` · Default: `manual`

Decides what happens when a tool call is classified `dangerous`.

| Value | Behaviour |
|---|---|
| `manual` | Every `dangerous` classification surfaces the approval modal; `safe` auto-fires; `blocked` errors out. |
| `smart` | An auxiliary fast-model call reviews each `dangerous` classification and either auto-approves, auto-denies, or escalates to `manual`. Trades latency and dollars for reduced approval fatigue. |
| `off` | `dangerous` classifications auto-fire without prompting; the hardline `blocked` floor still applies. |

Notes:

- `approvalMode: off` paired with any channel ingress (`platform: telegram / discord / slack / whatsapp / email`) is rejected at config load.

### safety.observability.* {#safety-observability}

Controls what the observability store persists for this personality.

| Field | Values | Description |
|---|---|---|
| `safety.observability.storeToolArgs` | `none` \| `redacted` \| `full` | Tool-call arguments. |
| `safety.observability.storeToolBodies` | `none` \| `redacted` \| `full` | Tool-call result bodies. |
| `safety.observability.storeLlmPayloads` | `none` \| `metadata` \| `full` | LLM request and response payloads. |
| `safety.observability.redactPatterns` | string[] | Substrings redacted from anything stored. |

## voice.\* {#voice}

Type: dotted block · Default: unset (inherit the deployment's voice config)

How this personality sounds, which engines serve it, and how its call is drawn. A deployment picks the *provider*; the personality picks how it *sounds* and how it *looks*, so anything declared here beats the global [`auxiliary.tts.*` / `voice.*`](./config-yaml.md#voice-tier) and `display.call_style` settings, and silence means inherit. The provider, voice and call-look keys are editable in the web Personalities tab (Identity step); `tier`, `model` and the language map are file-only.

| Field | Type | Description |
|---|---|---|
| `voice.tts_voice` | string | Voice id handed to the TTS provider. Provider-specific and free-form — `af_bella` for Kokoro, `alloy` for OpenAI. |
| `voice.languages.<tag>` | string | BCP-47 tag → voice id. Beats `tts_voice` when the turn's language is known. Two surfaces supply one: browser talk-mode reports the language it heard, and the gateway derives it from an inbound voice note's transcript with `detectLanguage()` (`@ethosagent/voice-text`). Detection is constrained to the tags declared here and to nothing else — a personality with no language map supplies no candidates, so no guess is made and `tts_voice` wins. |
| `voice.tier` | `pipeline` \| `realtime` | Preferred voice engine, beating the deployment's [`voice.tier`](./config-yaml.md#voice-tier). A preference, not a guarantee: a deployment with no realtime provider serves `pipeline` either way. An unrecognised value is dropped rather than thrown on — a bad voice field must not make a personality unloadable. |
| `voice.tts_provider` | string | Names an entry in the deployment's TTS roster (`voice.tts.providers.<name>`). A **label** the operator chose, never a provider id. A name this machine lacks falls back to the default `auxiliary.tts` entry, so a shared personality still speaks. |
| `voice.stt_provider` | string | The same, for the STT roster. A personality's voice is identity; its ear is a technical override. |
| `voice.realtime_provider` | string | The same, for the [realtime roster](./config-yaml.md#voice-realtime-providers). Consulted only on the realtime tier; falls back to `voice.realtime.default`. |
| `voice.model` | string | Fast-lane model for spoken turns — a small, quick model for conversation, so a voice lane never waits on the agentic default. Pinned onto the lane's runner once when the session opens, not per turn, so every host that opens a voice lane (the LiveKit adapter, the SIP adapter) gets the routing without having to remember it. Resolves from the personality alone: the deployment's `model` is deliberately not a fallback, since handing it over would pin every spoken lane to the model this key exists to keep off it. Unset leaves the runner untouched. |
| `voice.call_style` | `liquid` \| `orb` \| `rings` | Which treatment the Call Stage draws for this personality — `liquid`, the circle filling like a vessel; `orb`, a body deforming with the voice; `rings`, concentric rings breathing outward. Unset is **not** a fixed default: the treatment falls through to the operator's `display.call_style` when that names a concrete shape, and otherwise to one derived from the personality id, so every personality already looks distinct. An unrecognised value is dropped rather than thrown on. |

```yaml
voice.tts_voice: af_bella
voice.languages.es: ef_dora
voice.tier: realtime
voice.realtime_provider: live
voice.call_style: rings
```

Notes:

- Voice-id precedence, resolved in one function (`resolveVoicePreferences`) so every surface agrees: `voice.languages.<tag>` > `voice.tts_voice` > the chosen entry's own `voice` > global `auxiliary.tts.voice`. A realtime call uses the same order, so switching tiers does not switch who you are talking to.
- Naming a roster entry buys no trust. The [egress gate](./config-yaml.md#voice-trusted-plugins) keys on the entry's underlying `provider`, so an entry called `local-anything` backed by a hosted model is still refused.
- `voice.provider` is accepted on read as the older spelling of `voice.tts_provider` and re-serialized as the new one; a file never carries both.
- Talk-mode also needs `voice_session` in [`toolset.yaml`](#toolset-yaml). Without it the phone button renders disabled.
- Call-look precedence, resolved in one function (`resolveCallTreatment` in `packages/types/src/personality.ts`) so every surface agrees: `voice.call_style` > a concrete `display.call_style` > derived from the personality id. `display.call_style: personality` is the default and is not a pin — it defers to the derivation.
- Confirm what parsed with `ethos personality show <id>` — it emits a `## Voice` block, and omits the section entirely when the personality declares no `voice` block. Its `Call look` line names the derived treatment when the key is unset, because there is no blank state to report.

## toolset.yaml {#toolset-yaml}

Flat YAML list of tool names. Each entry on its own line, prefixed with `- `. Tools missing from this list are filtered out before the LLM sees them.

```yaml
# ~/.ethos/personalities/researcher/toolset.yaml
- read_file
- write_file
- web_search
- web_extract
- browse_url
```

Notes:

- An empty file (or one with only comments) means the personality runs with no external tools. The file may be omitted entirely for an internal-only personality.
- Tools the personality requests but does not list are rejected by `DefaultToolRegistry` and returned to the LLM as `is_error: true` so the Anthropic tool-result contract remains intact.

## SOUL.md {#ethos-md}

The first-person identity file. Markdown, no front-matter required. Loaded as part of the system prompt at every turn — combined with memory context and the dynamic personality config.

The file is mtime-cached by `FilePersonalityRegistry.loadFromDirectory()`; the loader re-reads it only when the on-disk mtime changes, so editing it during a chat session takes effect on the next turn.

## skills/ {#skills}

Optional sibling directory at `~/.ethos/personalities/<id>/skills/`. Per-personality skill files (markdown with frontmatter). The universal skill scanner picks them up alongside the global `~/.ethos/skills/` directory. Per-personality skills are always loaded unfiltered; global skills are filtered by `capability` mode by default.

## See also {#see-also}

- [`config.yaml` reference](./config-yaml.md) — the user-level `~/.ethos/config.yaml` that picks which personality runs (different file, different schema).
- [CLI reference](./cli.md#ethos-personality) — the `ethos personality` subcommands that scaffold and edit these files.
- [Glossary: personality](../../getting-started/glossary.md#personality) — one-line definition shared across every page that names the construct.
- [Glossary: fs_reach](../../getting-started/glossary.md#fs-reach) — the path-allowlist field this file declares; backed by `ScopedStorage`.
- [Run agent tools on a remote host](../how-to/run-tools-over-ssh.md) — the `execution: remote` requirement end to end, and what the remote host is exposed to.
- [Retrieve files the agent wrote](../how-to/retrieve-agent-files.md) — `fs_reach.workdir` in practice, on a headless deployment.
- [Local voice: Kokoro TTS + Whisper large v3 STT](../how-to/local-voice.md) — configure the providers this file's `voice.*` block picks between.
