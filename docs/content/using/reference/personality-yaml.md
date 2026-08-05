---
title: "Personality config reference"
description: "Every field in a personality's config.yaml and toolset.yaml — model, fs_reach, MCP, plugins, budget, safety."
kind: reference
audience: user
slug: personality-yaml
updated: 2026-07-17
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

## fs_reach.read / fs_reach.write {#fs-reach}

Type: comma-separated absolute paths · Default: AgentLoop fallback scope

Per-personality filesystem allowlist for the `read_file` / `write_file` tools. The runtime resolves these substitutions at construction time:

| Token | Resolves to |
|---|---|
| `${ETHOS_HOME}` | `~/.ethos` |
| `${self}` | This personality's id. |
| `${CWD}` | `AgentLoop.workingDir`. |

When unset, the fallback is:

```
read:  [~/.ethos/personalities/<self>/, ~/.ethos/skills/, ${CWD}]
write: [~/.ethos/personalities/<self>/, ${CWD}]
```

Paths outside the allowlist surface as a `BoundaryError` from `ScopedStorage` and are rendered as a user-facing tool error.

```yaml
fs_reach.read: ${CWD}, ${ETHOS_HOME}/skills, ${ETHOS_HOME}/personalities/${self}
fs_reach.write: ${CWD}, ${ETHOS_HOME}/personalities/${self}
```

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
