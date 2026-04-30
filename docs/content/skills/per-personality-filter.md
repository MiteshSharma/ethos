---
title: Per-Personality Filter
description: How Ethos scopes the skill library per personality — capability mode by default, plus explicit/tags/none modes for fine-grained control.
sidebar_position: 2
---

# Per-personality skill filter

The [universal scanner](./overview) builds one global pool of skills. **The filter decides which skills each personality sees.**

In other frameworks, every skill is visible to every agent. Your researcher sees deploy skills; your deploy bot sees research skills. The boundary is whatever the LLM decides to ignore.

In Ethos, the filter is structural: a skill that needs `terminal` never reaches a personality that doesn't have `terminal` in its toolset. Enforced at the framework layer, not advisory.

---

## How it works (capability mode — the default)

For each personality, Ethos compares the skill's `required_tools` against the personality's effective toolset. If every required tool is reachable, the skill flows in. Otherwise it's rejected.

```yaml title="A deploy skill"
---
name: deploy-staging
description: Deploy the current branch to staging
required_tools: [terminal, web_extract]
---

1. Run tests
2. Build artifacts
3. ssh to staging
...
```

| Personality | Toolset | Sees `deploy-staging`? |
|---|---|---|
| `researcher` | `web_search`, `read_file`, `memory_*` | ❌ — needs `terminal` |
| `engineer` | `terminal`, `read_file`, `write_file`, `web_extract` | ✅ |
| `operator` | `terminal`, `read_file`, `write_file` | ❌ — needs `web_extract` |

No manual scoping. The personality's existing toolset constraint already does the right thing.

---

## Filter modes

Set the mode in the personality's `config.yaml`:

```yaml title="~/.ethos/personalities/researcher/config.yaml"
name: Researcher
description: Methodical research agent
model: claude-opus-4-7
memoryScope: global
skills:
  global_ingest:
    mode: capability   # default — required_tools must subset personality.toolset
```

Four modes are available:

| Mode | Behaviour | Use when |
|---|---|---|
| `capability` *(default)* | Auto-allow if `required_tools` ⊆ personality toolset | You want safety with no manual curation. Best for most personalities. |
| `tags` | Match if any skill `tag` appears in the personality's `tags`/`capabilities` list | Skills are tagged semantically (e.g. `[research]`, `[devops]`) and you want tag-based grouping. |
| `explicit` | Default-deny — only skills in the `allow:` list are loaded | You want full curation. Useful for narrow-purpose personalities. |
| `none` | Disable global ingest entirely | The personality only uses skills in its own `~/.ethos/personalities/<id>/skills/` folder. |

### `tags` mode

```yaml
skills:
  global_ingest:
    mode: tags
    # personality already declares: capabilities: [research, citation]
```

A skill with `tags: [research, summarisation]` flows in (overlap on `research`). A skill with `tags: [devops, deploy]` does not.

### `explicit` mode

```yaml
skills:
  global_ingest:
    mode: explicit
    allow:
      - claude-code/code-review
      - claude-code/security-audit
      - openclaw/git-release
```

Names use the qualified `<source>/<skill>` format — same names you see in the boot output. Only listed skills load; everything else in the global pool is rejected.

### `none` mode

```yaml
skills:
  global_ingest:
    mode: none
```

Useful for personalities you want fully sandboxed. Drop skills directly into `~/.ethos/personalities/<id>/skills/<name>/SKILL.md` — that folder always loads unfiltered, regardless of mode.

---

## The deny list (works with any mode)

Block specific skills regardless of what the mode would allow:

```yaml
skills:
  global_ingest:
    mode: capability
    deny:
      - openclaw/aggressive-rewrite
      - claude-code/auto-commit
```

`deny` is checked after `mode` — anything in `deny` is rejected even if the mode would have allowed it.

---

## Per-personality `skills/` folder always wins

Drop a skill into `~/.ethos/personalities/<id>/skills/<name>/SKILL.md` and it loads for that personality regardless of any filter rule. This is the explicit hand-curated library — bypassing global filters is intentional.

```text
~/.ethos/personalities/researcher/
├── ETHOS.md
├── config.yaml
├── toolset.yaml
└── skills/
    ├── citation-style/SKILL.md       ← always loads for researcher
    └── primary-source-check/SKILL.md ← always loads for researcher
```

---

## Built-in personality defaults

Each built-in personality ships with a sensible filter mode. You can override in your own copy.

| Personality | Mode | What this means |
|---|---|---|
| `researcher` | `capability` | Loads skills whose `required_tools` match research-shaped toolset (web search, file read, memory) |
| `engineer` | `capability` | Loads skills that need terminal/file/code tools — auto-rejects research-only skills |
| `reviewer` | `explicit` | Read-only role; only allows skills you explicitly approve |
| `coach` | `tags` | Matches by `coaching` / `learning` / `reflection` tags |
| `operator` | `capability` | Loads skills needing terminal/file tools, but no web — research skills auto-rejected |

---

## Troubleshooting — "why doesn't my skill show up?"

Three checks, in order.

### 1. Did the scanner find it?

Boot output shows total + visible counts:

```text
$ ethos chat
Skills loaded: 47 total · 14 visible to researcher
  sources: ethos (12), claude-code (28), openclaw (7)
```

If the source path isn't listed, your skill directory isn't being scanned. Move the skill to one of [the discovered paths](./overview#where-skills-are-discovered) or symlink it.

### 2. Does the skill have valid frontmatter?

A `SKILL.md` without `---` frontmatter delimiters or with malformed YAML is silently dropped. Validate with:

```bash
head -10 ~/.claude/skills/my-skill/SKILL.md
```

Expect something like:

```markdown
---
name: my-skill
description: ...
---
```

### 3. Is the personality's filter rejecting it?

If the skill is in the global pool but doesn't reach a personality:

- **`capability` mode rejecting:** check `required_tools` in the skill's frontmatter and compare to the personality's `toolset.yaml`. The skill needs *every* tool listed to be in the personality's toolset.
- **No `required_tools` declared:** the safe default is to reject. Either add `required_tools: [...]` to the skill, or add the skill to the personality's `allow:` list under `explicit` mode, or move it to that personality's per-personality `skills/` folder (always loads).
- **`tags` mode rejecting:** at least one `tag` must overlap with the personality's `tags`/`capabilities`.
- **`deny` list:** check the personality's `skills.global_ingest.deny` for the skill's qualified name.

---

## Threat model — what this prevents

The filter is a structural safety net for the case "the LLM is led astray by the wrong skill content". It is NOT a security boundary against motivated abuse.

✅ **Prevents:**

- A research personality being suggested deploy actions because a deploy skill is in the global pool.
- A reviewer accidentally loading code-execution skills it shouldn't have.
- The "I forgot which personality I'm in" failure mode silently doing damage.

❌ **Does NOT prevent:**

- A skill containing literal commands the user copy-pastes into a shell. (That's why dangerous skills are still gated by the personality's `toolset` and by [`fs_reach`](../personality/what-is-a-personality#isolation-rules--whats-per-personality-whats-shared).)
- A malicious skill author. The filter is content-aware (matches on `required_tools`) but doesn't audit the skill's actual instructions.

If you want a stronger boundary, combine the filter with a tighter `toolset.yaml` — fewer tools means fewer skills can pass `capability` mode, regardless of what their authors claimed.

---

## Next steps

- [Skills overview](./overview) — what gets scanned, dialect parsers, frontmatter reference
- [Create a personality](../personality/create-your-own) — wire the filter mode into a custom role
- [Built-in personalities](../personality/built-in-personalities) — see what each built-in's filter mode loads in practice
