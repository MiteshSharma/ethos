---
title: Create a Custom Personality
description: Build a custom Ethos personality from scratch — ETHOS.md, config.yaml, toolset.yaml, and hot-reload.
sidebar_position: 2
---

# Create a Custom Personality

:::info ~10 min
Prerequisite: completed [Build your first agent](./build-your-first-agent).
:::

You'll build a "strategist" personality: a long-horizon planning advisor with web access and memory.

## Step 1 — Create the directory

```bash
mkdir -p ~/.ethos/personalities/strategist
```

## Step 2 — Write the identity

```markdown title="~/.ethos/personalities/strategist/ETHOS.md"
I am a strategic advisor focused on long-horizon planning and prioritisation.

I help identify what matters most, what to defer, and what to drop entirely.
I think in terms of leverage: which actions compound over time, which are
one-time costs.

I ask clarifying questions before giving advice. I'm direct about tradeoffs.
I don't pretend decisions are easier than they are.
```

## Step 3 — Write the config

```yaml title="~/.ethos/personalities/strategist/config.yaml"
name: Strategist
description: Long-horizon planning and prioritisation
model: claude-opus-4-7
memoryScope: global
```

## Step 4 — Define the toolset

```yaml title="~/.ethos/personalities/strategist/toolset.yaml"
tools:
  - web_search
  - read_file
  - memory
```

## Step 5 — Switch to it

Start ethos (or if it's already running, just type):

```
/personality strategist
```

Output:

```
Switched to strategist (Strategist)
```

Send a message to verify the new identity:

```
> What should I focus on this quarter?
```

The response style and questioning approach should reflect what you wrote in ETHOS.md.

## Step 6 — Try hot-reload

While ethos is running, open ETHOS.md in your editor and add a line:

```diff title="~/.ethos/personalities/strategist/ETHOS.md"
  I am a strategic advisor focused on long-horizon planning and prioritisation.

+ I prefer frameworks and models over gut feelings. I'll name the mental model
+ I'm using.
```

Save the file, then send another message. The change is live immediately — no restart needed.

:::tip Hot-reload
Ethos watches `config.yaml` modification times. Any personality file change is picked up on the next turn.
:::

## Step 7 — List all personalities

```
/personality list
```

Output:

```
Available personalities:
  researcher   Methodical, citation-focused, uncertainty-aware
  engineer     Terse, code-first, direct
  reviewer     Critical, structured, evidence-based
  coach        Warm, questioning, growth-focused
  operator     Cautious, confirms before acting, dry-run first
  strategist   Long-horizon planning and prioritisation  ← your new one
```

---

**Next:** [Write your first tool →](./write-your-first-tool)
