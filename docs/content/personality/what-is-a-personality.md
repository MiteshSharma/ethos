---
title: What is a Personality?
description: How Ethos personalities work — and why they're architecture, not configuration.
sidebar_position: 1
---

# What is a Personality?

In most agent frameworks, a "persona" is a string you paste into a system prompt. You change how the agent talks; you don't change what it can do.

In Ethos, **a personality is a structural component**. Switching from `engineer` to `researcher` changes four things simultaneously:

| Dimension | What changes |
|---|---|
| **Identity** | The first-person voice in `ETHOS.md` — how the agent frames problems and what it prioritises |
| **Tool access** | The `toolset.yaml` list determines which tools are available to this personality |
| **Memory scope** | `memoryScope: global` shares memory across all personalities; `per-personality` gives the personality its own isolated memory |
| **Model routing** | Each personality can specify its own `model` — e.g. `researcher` runs on Opus, `engineer` on Sonnet |

None of these require a restart. They take effect on the next turn.

---

## Directory structure

A personality lives in a single directory:

```
~/.ethos/personalities/<id>/
├── ETHOS.md        ← first-person identity
├── config.yaml     ← name, model, memoryScope
└── toolset.yaml    ← allowed tool names
```

Built-in personalities ship with the package. User personalities go in `~/.ethos/personalities/`. Both coexist without conflict.

---

## ETHOS.md — first-person identity

`ETHOS.md` is written in the first person. It's not a description of a persona; it's the agent speaking as itself.

```markdown title="ETHOS.md"
# Strategist

I am a long-horizon planning agent. My job is to find the decision that matters most,
not the one that's loudest.

I ask "what are we actually optimising for?" before engaging with tactics. I don't
produce action lists until I understand the goal and the constraints.

I think in months and years, not days. I flag when a near-term choice closes off a
future option — that cost is real even when it's not on the roadmap.
```

Keep it in first person. Keep it opinionated. A vague identity produces vague behaviour.

---

## config.yaml

Simple `key: value` format — no nested YAML.

```yaml title="config.yaml"
name: Strategist
description: Long-horizon planning and prioritisation
model: claude-opus-4-7
memoryScope: global
```

| Key | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name shown in the UI |
| `description` | string | no | One-line summary shown in `/personality list` |
| `model` | string | no | Overrides the global model from `~/.ethos/config.yaml` |
| `provider` | string | no | Overrides the global LLM provider for this personality (e.g. `anthropic`, `openrouter`, `ollama`) |
| `platform` | string | no | Restricts this personality to a single channel adapter (e.g. `cli`, `telegram`, `slack`, `discord`) |
| `capabilities` | string (comma-separated) | no | Capability labels advertised to the agent mesh — used by `route_to_agent` to pick this agent for matching tasks |
| `memoryScope` | `global` \| `per-personality` | no | Defaults to `global` |
| `streamingTimeoutMs` | number | no | Per-personality streaming watchdog — abort the LLM stream if no chunk arrives within this many milliseconds. Defaults to the agent loop's 120000ms |
| `toolset` | string[] | no | Allowed tool names — declared in the separate `toolset.yaml` file (see below) |

---

## toolset.yaml

A flat list of tool names this personality is allowed to use.

```yaml title="toolset.yaml"
tools:
  - web_search
  - read_file
  - memory_read
  - memory_write
```

Keep toolsets minimal. A personality that can do everything is a personality that does nothing well. The `operator` personality deliberately excludes `web_search` — an operator shouldn't be researching, it should be executing.

---

## memoryScope

Memory scope controls what the agent remembers and when.

**`global`** (default) — the personality reads from and writes to `~/.ethos/MEMORY.md`, which is shared across all personalities. Use this when continuity matters: a `coach` and a `researcher` working on the same project should share context.

**`per-personality`** — the personality reads from and writes to its own memory file, isolated from other personalities. Use this when isolation matters: a `reviewer` shouldn't absorb the opinions it reviews; an `operator` shouldn't carry forward context from unrelated planning sessions.

---

## Switching personalities in chat

```
/personality engineer
/personality list
/personality
```

`/personality <id>` takes effect immediately — the next message you send uses the new identity, tools, and memory scope. No restart required.

### The conversation thread stays continuous

Switching personality does **not** fork your session. The same conversation history is visible to both personalities. This is intentional: you are one human swapping hats, not two different users. A researcher can gather context, then an engineer can act on it — all in one thread.

If you want a clean slate, use `/new` to start a fresh session before switching personalities.

---

## Isolation rules — what's per-personality, what's shared

| Per-personality (isolated) | Shared (person-level) |
|---|---|
| ETHOS.md identity | API keys + platform bot tokens |
| Tool access (`toolset.yaml`) | Web auth token |
| MCP server allowlist (`mcp_servers`) | USER.md (who you are) |
| Plugin allowlist (`plugins`) | |
| Memory scope (`memoryScope`) | |
| Model routing | |
| Cron jobs (each job declares its personality) | |

**`mcp_servers`** — default-deny. A globally configured MCP server is invisible to a personality unless it lists the server name. Prevents an agent with Linear access from being available to a personality that should be research-only.

**`plugins`** — default-deny. An installed plugin is inert until at least one personality lists it in `plugins`. Plugins register hooks and context injectors with a wide blast radius; explicit opt-in per role is the safety default.

---

## Hot-reload

When you edit a personality's files on disk, the changes take effect on the next turn. `FilePersonalityRegistry` caches personalities by `mtime` — it re-reads the directory only when `config.yaml` has changed. This means you can tune `ETHOS.md` mid-session without losing your conversation history.

---

## Next steps

- [Built-in personalities](./built-in-personalities) — the five personalities that ship with Ethos
- [Create your own](./create-your-own) — step-by-step guide to writing a custom personality
