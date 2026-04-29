---
title: Create Your Own
description: How to create a custom personality in Ethos — ETHOS.md, config.yaml, and toolset.yaml.
sidebar_position: 3
---

# Create Your Own Personality

Drop a directory into `~/.ethos/personalities/<id>/` with three files. Ethos picks it up automatically — no restart needed.

## Step 1 — Create the directory

```bash
mkdir -p ~/.ethos/personalities/strategist
```

## Step 2 — Write the identity

`ETHOS.md` is read by the agent as part of its system prompt. Write it in first person. Be specific about communication style, what the agent prioritises, and what it avoids.

```markdown title="~/.ethos/personalities/strategist/ETHOS.md"
I am a strategic advisor focused on long-horizon planning and prioritisation.

I help identify what matters most, what to defer, and what to drop entirely.
I think in terms of leverage: which actions compound over time, which are
one-time costs.

I ask clarifying questions before giving advice. I'm direct about tradeoffs.
I don't pretend decisions are easier than they are.
```

## Step 3 — Configure the personality

`config.yaml` uses simple `key: value` format — no nested YAML.

```yaml title="~/.ethos/personalities/strategist/config.yaml"
name: Strategist
description: Long-horizon planning and prioritisation
model: claude-opus-4-7
memoryScope: global
fs_reach.read: ${ETHOS_HOME}/personalities/${self}/, ${ETHOS_HOME}/skills/, ${CWD}
fs_reach.write: ${ETHOS_HOME}/personalities/${self}/, ${CWD}
mcp_servers:  # allowed MCP server names (default-deny; omit or leave empty = no MCP access)
plugins:      # allowed plugin ids (default-deny; omit or leave empty = no plugin access)
```

The `fs_reach` keys scope filesystem access for the read_file / write_file tools to a per-personality allowlist of absolute path prefixes — closing the cross-personality leak gap.

**Fields:**
- `name` — display name (shown in `/personality list`)
- `description` — one-line description
- `model` — LLM model to use for this personality
- `memoryScope` — `global` or `per-personality`
- `fs_reach.read` / `fs_reach.write` — comma-separated absolute path prefixes the `read_file` / `write_file` tools may touch. Substitutions: `${ETHOS_HOME}` → `~/.ethos`, `${self}` → this personality's id, `${CWD}` → working dir. Unset → defaults to own personality dir + `~/.ethos/skills/` (read) and own dir + cwd (write).
- `mcp_servers` — space-separated list of MCP server names this personality may use. Default-deny: omit or leave empty to disable all MCP tools for this personality.
- `plugins` — space-separated list of plugin ids this personality may activate. Default-deny: omit or leave empty to disable all plugins for this personality.

## Step 4 — Define the toolset

List the tools this personality is allowed to use.

```yaml title="~/.ethos/personalities/strategist/toolset.yaml"
tools:
  - web_search
  - read_file
  - memory
```

Available tools depend on your Ethos version. Run `/help` in chat to see what's installed.

## Step 5 — Switch to it

```
/personality strategist
```

:::tip Hot-reload
Ethos watches `config.yaml` modification times. Edit any personality file and the changes are live on the next message — no restart required.
:::

## Tips

**Keep ETHOS.md in first person.** The agent reads it as a description of itself. Third-person descriptions ("This agent is...") work but feel less coherent.

**Keep toolsets minimal.** Only include tools the personality actually needs. A reviewer with no write access is safer than one that can accidentally modify files.

**Choose memoryScope deliberately.**
- `global` — use when this personality should share context with your other global-scope personalities (e.g., project notes, ongoing tasks)
- `per-personality` — use when this personality's context should be completely isolated (e.g., a persona for reviewing sensitive documents)

**Model routing per personality.** You can run different models for different personalities — fast/cheap for coach, powerful for engineer:
```yaml
# engineer/config.yaml
model: claude-opus-4-7

# coach/config.yaml  
model: claude-haiku-4-5-20251001
```
