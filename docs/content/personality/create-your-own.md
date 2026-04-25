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
```

**Fields:**
- `name` — display name (shown in `/personality list`)
- `description` — one-line description
- `model` — LLM model to use for this personality
- `memoryScope` — `global` or `per-personality`

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
