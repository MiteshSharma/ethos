---
name: ethos-skill-authoring
description: Write a SKILL.md that the Ethos universal scanner will accept. Covers the frontmatter contract (name, description, version, tags, required_tools, ethos extension block), the body shape (When to use / Workflow / Anti-patterns), and the common rejection reasons (missing fields, unreachable tools, category drift).
version: 1.0.0
author: ethosagent
tags: [ethos, meta, skill-authoring]
required_tools: [read_file, write_file]

ethos:
  category: framework-usage
  default_personalities: [engineer, coordinator]
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: [terminal]
  integrates_with:
    - skill: code-review
      role: companion — after writing the SKILL.md, run code-review on the diff to catch frontmatter / body issues
    - skill: native-mcp
      role: example — MCP server skills follow the same authoring contract
  surface_metadata:
    invocation_trigger: "user says 'write a new skill', 'add a skill for X', 'why is my skill not loading?'; agent self-invokes when asked to extend Ethos behaviour with prose-only guidance"
    estimated_turns: "1-2"
---

# Ethos Skill Authoring

Skills are prose. The Ethos universal scanner discovers them, the ingest filter prunes them per personality, and the agent loop injects the surviving ones into the system prompt. This skill is the contract.

## When to use this skill

- User asks "how do I write a skill?" or "add a skill for <X>".
- A skill the user wrote isn't loading — diagnose the rejection.
- You're authoring a personality and want it to ship with a skill.

## When NOT to use this skill

- The thing the user wants is actually a tool (it executes something). Tools live in `extensions/tools-*` packages; skills are prose.
- The thing is a personality, not a skill. Personalities answer "who am I"; skills answer "how do I do X well".

## File layout

```
~/.ethos/skills/<skill-id>/SKILL.md       # user-level (any personality can ingest)
~/.ethos/personalities/<p>/skills/<id>/SKILL.md  # personality-scoped
skills/data/<category>/<id>/SKILL.md             # first-party bundle (repo-level)
.agents/skills/<id>/SKILL.md                     # repo-level community skill
```

The file must be named `SKILL.md` exactly. The directory name becomes the skill id (kebab-case). One skill = one directory.

## Frontmatter — the required contract

```yaml
---
name: <kebab-case, matches directory>
description: <one paragraph — what it does, in the same voice the agent will read it. Avoid marketing copy.>
version: <semver, start at 1.0.0>
author: <handle / org>
tags: [<lowercase, kebab-case>, ...]
required_tools: [<exact tool names from the registry>]
---
```

**Every field is enforced**. The ingest filter rejects skills with missing or malformed frontmatter. The `required_tools` list is the gate: if a personality's toolset doesn't include every name in the list, the skill is filtered out (logged at INFO at boot — operator can see which skills got pruned and why).

### The `ethos:` extension block

First-party skills carry an additional block the scanner uses for routing:

```yaml
ethos:
  category: <one of the validated categories>
  renders: [<renderer@specVersion>, ...]   # optional — see below
  default_personalities: [<personality ids this skill complements>]
  prerequisites:
    external_cli: [<binaries the skill assumes exist>]
    auth: [<one-line auth steps>]
    env_vars: [<names>]
    optional_tools: [<tool names that enhance but aren't required>]
  integrates_with:
    - skill: <other-skill-id>
      role: <companion / prereq / shares-logic-with>
    - tool: <tool-name>
      role: <what the tool adds>
  surface_metadata:
    invocation_trigger: "<plain-language description of when this skill should fire>"
    estimated_turns: "<small range, e.g. 1-3>"
```

Valid `category` values today: `planning-and-process`, `quality-and-testing`, `github-workflow`, `delegation-and-orchestration`, `framework-usage`. Adding a new category requires updating the bundle-test allowlist in lockstep.

### `ethos.renders` — declaring an output renderer

A skill that teaches a fenced output format declares it here. `skills/document/charts/SKILL.md` is the reference example: `renders: ['echarts@1']` teaches the ```` ```echarts ```` fence AND unlocks the chart renderer for any personality whose skill set includes it. One declaration, both effects — what a personality is taught and what it may draw cannot drift apart.

- **It goes under `ethos:`, not at top level.** Top level is the shared agentskills.io namespace (`name`, `description`, `tags`, `required_tools`); every Ethos-specific contract field lives in the `ethos:` block.
- **The grammar is `<renderer-name>@<integer>`** — `/^[a-z][a-z0-9-]*@\d+$/`. Entries that do not match are dropped silently.
- **Semver is rejected on purpose.** The integer is *our* spec version — a documented option subset owned by the skill — not the renderer library's npm version. There is no `echarts@1.1`: a changed subset is `echarts@2`. During a migration a skill declares both (`renders: ['echarts@1', 'echarts@2']`).
- **Declaring a renderer no surface maps is harmless.** It is an inert capability claim. Surfaces keep their own curated, first-party registry and simply do not draw what they do not map; the fence falls back to a code block. This is also why a skill can never ship renderer code — it declares, the surface provides.

## Body — the standard shape

The body is markdown. Order matters because the agent reads top-down.

```markdown
# <Skill Name>

<One paragraph: what this skill is, in a sentence the model can recall.>

## When to use this skill
<Bulleted list of triggers. Specific over abstract.>

## When NOT to use this skill
<Bulleted list of explicit non-triggers. Cheaper than letting the model guess.>

## <Workflow / Steps>
<Numbered or stepped procedure. Use code blocks for actual commands the agent will run.>

## Anti-patterns
<Bulleted list — the failure modes you want the model to avoid.>

## Hard rules
<Non-negotiable constraints. The most senior content in the skill.>

## Setup the user needs to do once   (optional)
<For skills that depend on external CLIs or auth. Mirrors the `prerequisites:` frontmatter.>
```

The "When to use / When NOT to use" pair is the most load-bearing section — the model relies on it to decide whether the skill applies *at all*. Spend time on it.

## Common rejection reasons

| Reason | Cause | Fix |
|---|---|---|
| `required_tools not in effective reach` | A tool listed in `required_tools` isn't in the personality's `toolset.yaml` | Either drop the tool from `required_tools` (skill works without it) or add it to the personality |
| Missing `name` / `description` | Frontmatter not parsed | YAML syntax error — most often unquoted `:` in description |
| `category is undefined` | First-party skill without an `ethos:` block | Add the block; categories are validated against an allowlist |
| `tags not array` | Tags written as a comma-separated string | Use YAML list: `[tag1, tag2]` |
| Skill not in scanner output | Directory not under a known source root | Check the scanner sources list in `apps/ethos/src/wiring.ts` |

## Writing well — voice and density

- **Imperative second person**: "Run `gh auth status`." Not "the user runs gh auth status".
- **Concrete identifiers**: real file paths, real tool names, real config keys.
- **No marketing copy**: skills are read by an LLM that uses them; not by a prospect.
- **Tables for ≥3 parallel items.** Prose for 1-2.
- **Code blocks for actual commands.** Inline backticks for tool / file / flag references.
- **No emoji.** Voice rules from `DESIGN.md` apply.

## Anti-patterns

- **Skill that lists every tool in `required_tools`.** Only list the ones whose absence makes the skill useless. Optional tools go in `optional_tools` (under `prerequisites`).
- **Skill body that recapitulates the description.** The description is the gate; the body is the operating manual.
- **No "When NOT to use" section.** The model will over-trigger.
- **Vague triggers.** "Use this when reviewing code" is too broad; "Use after staged edits when the next action is git push" is right.
- **Inventing tools.** If the registry doesn't have it, the skill can't require it. Check `ethos personality show <id>` for the actual tool list.

## Hard rules

- **`SKILL.md` is the only required file.** Companion files (`adapters/`, `examples/`, `templates/`) are optional and skill-specific.
- **Bump `version` on every meaningful change.** Patch for typo, minor for body changes, major for frontmatter contract changes.
- **`required_tools` and `optional_tools` use the *exact* names the registry exposes.** No aliases, no abbreviations.
- **First-party skills must declare a category in the validated set.** New categories require the bundle-test update in the same commit.
- **Don't ship skills that load secrets via env-var without documenting it.** The `prerequisites.env_vars` list is the operator-visible contract; if it's missing, the skill will silently fail under capability isolation.
