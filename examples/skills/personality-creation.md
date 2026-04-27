# Ethos Personality Creation

Use this skill when helping a user create, edit, or debug an Ethos personality.

## What a personality is

A personality is a structural component (not just a system prompt string) that simultaneously shapes:

- **Identity / voice** — `ETHOS.md` (first-person), injected at priority 110.
- **Tool access** — `toolset.yaml` declares which tools the personality is allowed to call. The registry enforces this at execution time — calls outside the allowlist return a `tool_result` with `is_error: true`.
- **Skills** — optional `skills/` directory of `*.md` files injected into the system prompt by `SkillsInjector` (priority 100).
- **Routing & runtime** — `config.yaml` sets the model, provider, platform, memory scope, and mesh-advertised capabilities.

A personality is loaded by `FilePersonalityRegistry.loadFromDirectory()` (mtime-cached, hot-reloadable).

## File structure

```
<id>/                  ← directory name = personality id (lowercase, no spaces)
├── config.yaml        ← required: name, description, model, memoryScope, capabilities
├── ETHOS.md           ← required: first-person identity ("I am ...", "I do ...")
├── toolset.yaml       ← optional but recommended: flat list of allowed tool names
└── skills/            ← optional: per-personality skill markdown files
    ├── <skill>.md
    └── ...
```

At least one of `config.yaml` or `ETHOS.md` must exist for the directory to register as a personality.

## Installation locations

```
~/.ethos/personalities/<id>/         global (any project)
.ethos/personalities/<id>/            project-local
extensions/personalities/data/       built-in (monorepo only)
examples/plugins/personality/        packaged via plugin (api.registerPersonality)
```

For a packaged personality (npm or local plugin), use `api.registerPersonality({...})` plus an injector at priority 110 with `shouldInject: ctx => ctx.personalityId === '<id>'` — see `examples/plugins/personality/src/index.ts`.

## `config.yaml` schema (flat key: value, no nesting)

| Key | Required | Notes |
|---|---|---|
| `name` | yes | Display name (e.g. `Engineer`). Defaults to title-cased id. |
| `description` | yes | One-line summary used in `/personality` listings. |
| `model` | yes | LLM model id (e.g. `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`). |
| `provider` | no | Override provider (`anthropic`, `openai-compat`). Defaults to wiring config. |
| `platform` | no | Restrict to a platform (`cli`, `telegram`). |
| `memoryScope` | yes | `global` (shared `~/.ethos/MEMORY.md`) or `per-personality` (isolated). |
| `capabilities` | no | Comma-separated mesh roles, e.g. `code, review`. Advisory; not the same as `toolset`. |

The parser is `parseConfigYaml()` in `extensions/personalities/src/index.ts`. It supports only `key: value` lines — no nested YAML, no lists, no multiline. Quotes around values are stripped.

## `toolset.yaml` schema (flat YAML list)

```yaml
- read_file
- write_file
- web_search
```

Common built-in tools to choose from:

| Group | Tools |
|---|---|
| File | `read_file`, `write_file`, `patch_file`, `search_files` |
| Terminal | `terminal`, `process_start`, `process_list`, `process_kill`, `execute_code`, `run_tests`, `lint` |
| Web | `web_search`, `web_extract`, `web_crawl` |
| Memory | `memory_read`, `memory_write`, `session_search` |

If `toolset.yaml` is omitted, the personality gets all registered tools. Always declare the minimum needed — toolsets are enforced at the registry level, so a tighter list is real isolation, not a hint.

`capabilities` ≠ `toolset`. Capabilities are labels advertised to the mesh router; toolset is the hard allowlist of tool names the personality may call.

## `ETHOS.md` writing rules

First-person identity. Read like the agent describing itself, not a manual about the agent.

- Open with `# <Name>` and a one-sentence statement of role: "I am a software engineer agent."
- Use "I do X" / "I don't do Y" — not "you should" or "the agent will".
- State *behavioral* rules: how it handles errors, padding, tradeoffs, clarifying questions, output format.
- Keep it short (10–20 lines). Long ETHOS files dilute focus.
- Don't repeat what's in `toolset.yaml` or `config.yaml`. Identity, not config.

Reference exemplars in `extensions/personalities/data/`:
- `engineer/ETHOS.md` — terse, code-first
- `coach/ETHOS.md` — warm but direct, asks questions
- `researcher/ETHOS.md` — methodical, primary-source bias
- `reviewer/ETHOS.md` — critical, evidence-based
- `operator/ETHOS.md` — cautious, confirms before irreversible actions

## Per-personality `skills/`

Drop markdown files in `<id>/skills/`. Each file is appended to the system prompt by `SkillsInjector` (priority 100) when this personality is active. Global `~/.ethos/skills/` files are also injected.

Two formats supported:

1. Plain markdown — injected verbatim.
2. OpenClaw frontmatter — YAML frontmatter with `metadata.openclaw.{requires, os, always}` rules. See `extensions/skills/src/skill-compat.ts`.

Discovery: top-level `*.md`, plus `<dir>/<slug>/SKILL.md`, plus `<dir>/<scope>/<slug>/SKILL.md`. Files in a `pending/` subdir or starting with `.` are skipped.

## Workflow for creating a new personality

1. **Pick the id** — lowercase, single word, no spaces. The directory name is the id.
2. **Pick the model** — `haiku` for fast lookups, `sonnet` for code/review, `opus` for planning/coaching.
3. **Decide memory scope** — `global` lets the personality see other agents' MEMORY.md notes; `per-personality` isolates it (good for reviewer/operator).
4. **Write ETHOS.md first** — identity drives every other choice.
5. **Derive toolset from identity** — a coach doesn't need `terminal`; an operator does.
6. **Write config.yaml last** — name, description, model, memoryScope, capabilities.
7. **Verify** — start `ethos`, run `/personality <id>`, check the personality loads and the model resolves.

## Common mistakes

- **Nested YAML in `config.yaml`** — the parser only handles flat `key: value`. `model:\n  default: claude-...` silently produces `model: ''`.
- **`capabilities` written as YAML list** — must be a comma-separated string (`code, review`), not `- code\n- review`.
- **Missing `ETHOS.md`** — a directory with only `config.yaml` will register, but the agent has no identity injection. Always include both.
- **`toolset.yaml` with hyphens but indented** — lines must start with `- ` at column 0 (after trimming). Indented entries are ignored.
- **Identity written in third person** — "The agent should be terse" reads like a spec, not a self. Rewrite as "I am terse."
- **Memory scope mismatch** — declaring `memoryScope: per-personality` but expecting context from a `global` session means MEMORY.md writes won't carry over.
- **Writing the personality as a plugin without registering an identity injector** — `api.registerPersonality({...})` adds the config, but you also need an injector at priority 110 to inject the ETHOS.md content.
- **Choosing a model id that doesn't exist** — model resolution happens per-turn; an unknown model throws at runtime, not at load time.

## Where to look for help

- `extensions/personalities/src/index.ts` — `FilePersonalityRegistry`, `parseConfigYaml`, `parseToolsetYaml`, `loadFromDirectory`
- `extensions/personalities/data/<built-in>/` — five reference personalities
- `packages/types/src/personality.ts` — `PersonalityConfig` interface
- `extensions/skills/src/skills-injector.ts` — how `skillsDirs` and `~/.ethos/skills/` are merged and injected
- `examples/plugins/personality/src/index.ts` — packaging a personality as a plugin
