---
title: "Add a skill"
description: "Author a SKILL.md file with agentskills frontmatter, drop it in a scanned source, and tune the per-personality filter so the right roles see it."
kind: how-to
audience: developer
slug: add-a-skill
time: "10 min"
updated: 2026-08-12
---

## Task

Author a markdown-defined [skill](../../getting-started/glossary.md#skill), place it where the universal scanner finds it, and configure the per-personality filter so only the right [personalities](../../getting-started/glossary.md#personality) load it.

## Result

The skill is parsed at boot, keyed by qualified name (`<source>/<name>`), and added to the skill pool. Personalities whose toolset reaches the skill's `required_tools` see it; the rest do not. `ethos skills list` shows it grouped under its source label.

## Prereqs

- An installed Ethos (`ethos --version` returns a string).
- A clear answer to "what should the agent do when this skill activates?" — one paragraph or a numbered procedure.
- The list of [tools](../../getting-started/glossary.md#tool) the skill needs. The filter blocks any skill whose `required_tools` are outside the personality's toolset.

## Steps

### 1. Pick the source directory

Ethos scans these paths at startup. Pick the one that matches the skill's scope.

| Path | Source label | Visible to |
|---|---|---|
| `~/.ethos/skills/<name>/SKILL.md` | `ethos` | All projects on this machine. |
| `<repo>/.claude/skills/<name>/SKILL.md` | `claude-code-project` | Anyone running Ethos inside this checkout. Commit to share. |
| `<repo>/.opencode/skills/<name>/SKILL.md` | `opencode-project` | Same, for repos that already keep skills in OpenCode's layout. |
| `~/.claude/skills/<name>/SKILL.md` | `claude-code` | Ethos AND Claude Code. Best for cross-framework skills. |
| `~/.ethos/personalities/<id>/skills/<name>/SKILL.md` | per-personality | Only the named personality. Always loads, bypasses the filter. |

Ethos has no per-repo `.ethos/skills/` source. A skill you want committed alongside the code goes in `<repo>/.claude/skills/` — the scanner reads that directory whatever tool wrote it. (`<repo>/.ethos/commands/` is a real project-scoped directory, but it holds slash commands, not skills.)

`skills/<category>/<name>/SKILL.md` inside the Ethos checkout is the bundled location; it ships inside the framework and is read-only at runtime. Add new skills under one of the user paths.

### 2. Write the SKILL.md file

Every skill is one directory with `SKILL.md` as the entrypoint. Supporting files (scripts, references) live alongside it and are loaded only when the skill body references them.

```markdown title="~/.ethos/skills/explain-code/SKILL.md"
---
name: explain-code
description: Explain unfamiliar code with an analogy and a small ASCII diagram. Use when the user asks "how does this work?" or wants a tour of a file they didn't write.
tags: [coding, explanation]
required_tools: [read_file]
---

# Explain code

When the user asks how a piece of code works:

1. Read the file with `read_file`.
2. Open with a one-sentence analogy from everyday life.
3. Draw an ASCII diagram showing the data flow (3–6 lines).
4. Walk through the code in execution order, skipping import boilerplate.
5. Close with one gotcha — something the reader will trip over if they edit it.
```

Frontmatter fields the scanner reads:

| Field | Required | Purpose |
|---|---|---|
| `name` | No | The `<name>` half of the qualified name `<source>/<name>`. Defaults to the directory name. |
| `description` | Yes (in practice) | The agent reads this to decide when to load the skill. Keep keywords up front. |
| `required_tools` | No | The filter compares this list against the personality's toolset. Skills with no declaration are allowed by default (`fallback_unknown: allow`). |
| `tags` | No | Used by `tags` filter mode and the deny list. |

Other frontmatter fields from the agentskills.io spec are accepted by the parser and ignored when Ethos has no use for them yet, so your skills stay portable. That cuts both ways: a field Ethos does not read is silently inert, not an error. In particular there is no per-skill switch to block model invocation and no per-skill tool allowlist — `disable-model-invocation` and `allowed-tools` belong to slash commands, a different artifact. The only gates on a skill are the safety scan and the per-personality filter below.

### 3. Configure the per-personality filter

The personality picks how it ingests the global skill pool. The default is `capability` — a skill is visible only if every entry in its `required_tools` is in the personality's `toolset.yaml`. Override in the personality's `config.yaml`:

```yaml title="~/.ethos/personalities/researcher/config.yaml"
name: Researcher
description: Methodical research agent
model: claude-opus-4-7
memoryScope: global

skills:
  global_ingest:
    mode: capability   # default — required_tools must subset personality.toolset
```

Four modes are available.

| Mode | Behaviour | When to use |
|---|---|---|
| `capability` (default) | Auto-allow if `required_tools ⊆ personality.toolset`. | The personality's toolset is the natural gate. Best for most roles. |
| `tags` | Match if any skill tag is in the personality's `accept_tags`; reject if any tag is in `reject_tags`. Capability check still runs after. | Skills are tagged semantically and you want grouping by tag. |
| `explicit` | Default-deny — only skills in `allow` are loaded. Capability check still runs after. | Narrow-purpose personalities with hand-curated libraries. |
| `none` | Disable global ingest entirely. | Personalities that should only use skills in their own `~/.ethos/personalities/<id>/skills/` folder. |

Example `tags` and `explicit` configs (skill names use the qualified `<source>/<name>` format from the boot output):

```yaml
skills:
  global_ingest:
    mode: tags
    accept_tags: [research, citation]
    reject_tags: [deploy, irreversible]
```

```yaml
skills:
  global_ingest:
    mode: explicit
    allow: [claude-code/code-review, ethos/explain-code]
    deny:  [claude-code/auto-commit]    # checked first; wins over every mode
```

`deny` is checked first — anything listed is rejected even if the mode would have allowed it.

### 4. Skip the filter for one personality

To bypass every filter rule for one personality, drop the skill inside its directory:

```text
~/.ethos/personalities/researcher/
├── SOUL.md
├── config.yaml
├── toolset.yaml
└── skills/
    └── citation-style/SKILL.md   ← always loads for researcher
```

This is the explicit hand-curated library — bypassing the global filter is intentional.

## Verify

Scan the pool and confirm the skill is in it:

```bash
ethos skills list
```

Skills are grouped by source label, bundled first, then your own:

```text
ethos-bundled
  code-review  [software-development]
  tdd  [software-development]
ethos  (/Users/you/.ethos/skills)
  explain-code
```

Add `--json` for a machine-readable list of `{ name, source, category }`.

Then give the agent a request that matches the skill's `description`:

```bash
ethos chat -q "how does src/auth/login.ts work?"
```

A turn that opens with the analogy you wrote in `SKILL.md` confirms the skill reached the prompt and the LLM followed it. There is no slash command for a directory-shaped skill — activation is the description match plus the per-personality filter.

## Troubleshoot

**Skill not in `ethos skills list` at all.** — The scanner did not find the directory. Confirm the path matches one of the sources in step 1: `<repo>/.ethos/skills/` is not one of them. Confirm the shape too — `~/.claude/skills/explain-code/SKILL.md` is right; `~/.claude/skills/explain-code.md` is wrong. Every discovered skill is its own directory with `SKILL.md` inside it.

**Skill is in the pool but not visible to the personality.** — The filter is rejecting it. Check `capability` mode: every entry in `required_tools` must appear in the personality's `toolset.yaml`. A skill with `required_tools: [terminal, web_extract]` will not reach a personality whose toolset is `[web_search, read_file]`.

**No `required_tools` declared, skill still rejected.** — The personality has `fallback_unknown: deny` set. Either declare `required_tools`, add the skill to the `allow` list under `explicit` mode, or drop it into the personality's own `skills/` folder.

**Skill loads but never activates.** — The `description` is missing or buried. The LLM reads the description (not the body) to decide when to load. Move the activation keywords to the first sentence: who needs this, when, and what it does.

**Frontmatter not parsing.** — The file is missing the leading `---` delimiter or the YAML is malformed. Run `head -10 ~/.ethos/skills/<name>/SKILL.md`; the first line must be exactly `---`, and the closing `---` must be on its own line.

**Duplicate skill names across sources.** — The pool is keyed by qualified name (`<source>/<name>`), so two sources with the same skill name both survive — `ethos/code-review` and `ethos-bundled/code-review` are distinct entries and both reach the filter. There is no override: a same-named directory under `~/.ethos/skills/` adds a second skill, it does not replace the bundled one. To suppress the bundled copy, name the personality's `deny` list: `deny: [ethos-bundled/code-review]`.
