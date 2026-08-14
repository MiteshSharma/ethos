---
title: "Create your first personality"
description: "Build a strategist personality end to end: SOUL.md identity, config.yaml fields, toolset.yaml allowlist, hot-reload, and a per-personality memory demo."
kind: tutorial
audience: user
slug: first-personality
time: "20 min"
updated: 2026-08-14
---

The three user-facing built-in personalities cover the common roles. This tutorial builds a fourth — a `strategist` for long-horizon planning — and uses it to prove the things personalities atomically change: prompt, tools, and model. Plus hot-reload and per-personality memory isolation, so you can edit identity prose while chat is running and verify that each personality keeps its own context.

## Goal

By the end, you have:

- A working personality at `~/.ethos/personalities/strategist/` with `SOUL.md`, `config.yaml`, and `toolset.yaml`.
- A live `ethos chat` session running as that personality with the tools you listed and the voice you wrote.
- Watched the registry hot-reload your edits to `SOUL.md` between turns without a restart.
- Verified that per-personality memory keeps the strategist's `MEMORY.md` separate from every other personality's.
- A reusable starting template — `ethos personality duplicate` — for the next personality you build.

The personality you build is small on purpose. The point of the tutorial is the contract, not the role: every dimension you set here is enforceable by the framework, not aspirational in the prompt.

## Prereqs

- [Build your first agent](./first-agent.md) finished — you have used `/personality` to switch between built-ins and know that the chip in the header is the source of truth.
- A text editor with two files open at once: `~/.ethos/personalities/strategist/SOUL.md` and a chat window.
- A working directory you do not mind associating with strategy work — sessions are still keyed per directory.
- A clear picture in your head of one role you actually want an agent to play. The tutorial uses "strategist" as a stand-in; if you have a real role (`code-reviewer`, `tech-writer`, `release-manager`, `incident-commander`), substitute its name everywhere and use this as a recipe.

## 1. Lay out the directory

A [personality](../../getting-started/glossary.md#personality) is a directory with three files. The directory name is the id you reference from `/personality <id>` — it must be filesystem-safe (no spaces) and globally unique across built-ins and user personalities.

```bash
mkdir -p ~/.ethos/personalities/strategist
cd ~/.ethos/personalities/strategist
```

Confirm where the registry will look:

```bash
ls ~/.ethos/personalities/
```

You should see `strategist/`. The three user-facing built-ins are not listed here — they ship inside the CLI package at `extensions/personalities/data/`. Both directories merge into one list at runtime; user files override builtins on the same id. If you name your directory `researcher`, your version wins over the bundled one — useful for taking a built-in and editing it in place.

## 2. Write `SOUL.md` — the identity

`SOUL.md` is first-person prose. It defines who the agent is and how it speaks. The registry loads it as the system-prompt baseline; the framework then layers memory context and personality metadata on top.

Keep it concrete. Six paragraphs is plenty. No marketing voice ("Welcome!", "I'll help you unlock..."). No emoji. Active voice over passive.

```bash
cat > ~/.ethos/personalities/strategist/SOUL.md <<'EOF'
# Strategist

I am a strategic advisor. My job is long-horizon planning and prioritisation. I help you decide what to commit to, what to defer, and what to cut entirely.

I think in terms of leverage. Some actions compound across months; some are one-time costs that look productive but do not move the trajectory. I name which is which when I see it.

I ask clarifying questions before I give advice. I would rather take one extra turn to ground a recommendation than offer five plausible-sounding options.

I am direct about tradeoffs. I do not pretend a decision is easier than it is. I say what each option costs as well as what it earns.

When I do not know something, I say so. When the answer depends on a value judgement only you can make, I name the judgement and ask which way you lean.

I structure plans into three layers: what to do this week, what to do this quarter, what to do this year. I do not load the weekly layer with quarterly work — that is how plans break.
EOF
```

A few rules that make `SOUL.md` productive:

- **First person.** "I do X" beats "The strategist does X". The model assumes the voice more reliably and refers to itself with the right pronoun.
- **Behaviour, not skills.** "I cite sources" is behaviour. "Knows everything about strategy" is a skill claim and a hallucination magnet — the model will fabricate to live up to it.
- **Concrete refusals.** "I do not pad responses" is enforceable in tone. "I write clearly" is a vibe.
- **Length is a budget.** Every token here ships on every turn, on every session, forever. Keep it tight — the engineer's `SOUL.md` is under 200 tokens for a reason.
- **Read it as the agent.** Open it later and ask "would I want this read aloud at me at every turn?". If a paragraph is filler, cut it.

The shipped researcher and engineer ETHOS files are good reference material — read them at `extensions/personalities/data/researcher/SOUL.md` and `extensions/personalities/data/engineer/SOUL.md` in the repo for tone.

## 3. Write `config.yaml` — the wiring

`config.yaml` is a flat `key: value` subset of YAML. Dotted keys (`fs_reach.read`, `safety.approvalMode`) encode nested structure without indentation. Most fields are optional; only `name` is worth setting by hand the first time.

```bash
cat > ~/.ethos/personalities/strategist/config.yaml <<'EOF'
name: Strategist
description: Long-horizon planning and prioritisation advisor.
model: claude-opus-4-7
capabilities: planning, prioritisation, decision-support
EOF
```

What each field does:

- **`name`** — human label printed in pickers and `/personality list`. Pick something readable.
- **`description`** — one-line role summary. Shown in `/personality list` and the `--help` output for `ethos personality`.
- **`model`** — overrides the global default model for this personality only. Opus is a deliberate choice for strategy work; Sonnet would be faster and cheaper at the cost of depth. The full provider/model pairing is in [config.yaml](../reference/config-yaml.md).
- **`capabilities`** — free-form tags consumed by the skill ingestion filter and the personality picker. Tags do not change behaviour by themselves; they are routing hints.

Memory is always per-personality — each personality reads and writes its own `MEMORY.md` at `~/.ethos/personalities/<id>/MEMORY.md`. No configuration field is needed.

For the full field list, including `provider`, `streamingTimeoutMs`, `fs_reach`, `mcp_servers`, `plugins`, `budgetCapUsd`, `context_layering`, `skill_evolution`, and the nested `safety` block, see [Personality config reference](../reference/personality-yaml.md).

Two fields you will likely add later:

- `fs_reach.read` and `fs_reach.write` — per-personality filesystem allowlists for the `read_file` / `write_file` [tools](../../getting-started/glossary.md#tool). When unset, the default scope is `~/.ethos/personalities/<self>/` and the current working directory. Tightening this is the right move once you start handing the personality real files.
- `budgetCapUsd` — per-session spending cap. Step 8 below adds one.

## 4. Write `toolset.yaml` — the [tool](../../getting-started/glossary.md#tool) allowlist

`toolset.yaml` is a flat list of tool names. The registry filters the LLM's visible tool catalog to exactly this list. A tool not listed here is invisible to the model and rejected at execution time (`DefaultToolRegistry.toDefinitions(allowedTools)` enforces both halves).

A strategist needs to read primary sources, capture decisions, and search prior conversations. It should not write code or run shell commands.

```bash
cat > ~/.ethos/personalities/strategist/toolset.yaml <<'EOF'
- web_search
- web_extract
- read_file
- search_files
- memory_read
- memory_write
- session_search
EOF
```

What each grants:

| Tool | What it does |
|---|---|
| `web_search` | Query a web search index and return result snippets. |
| `web_extract` | Fetch a URL and return its main-text content. |
| `read_file` | Read a file under the personality's [fs_reach](../../getting-started/glossary.md#fs-reach). |
| `search_files` | Grep across files under fs_reach. |
| `memory_read` | Read this personality's memory files (`MEMORY.md` and `USER.md`). |
| `memory_write` | Append, replace, or remove lines in those memory files. |
| `session_search` | FTS5-search prior sessions for relevant context. |

What we deliberately left out:

- `write_file`, `patch_file`, `terminal`, `run_tests` — strategist plans, it does not execute. The toolset boundary is the enforcement; a prompt instruction is not.
- `web_crawl` — overkill for the role; the agent can request individual extracts when it needs depth.

Tool names that do not exist in the registry are silently inert. There is no penalty for misspelling — but the agent will not get the tool. From inside the TUI, `/tools` lists the tools the active personality can actually see; from the readline REPL, run `ethos chat`, switch to the personality, and ask `what tools do you have?` — the agent reads its catalog from the system prompt.

### Toolset hygiene

Two patterns to follow as you build more personalities:

- **Start narrow, widen on need.** A toolset of five tools the agent uses is better than ten the agent might use. Every extra tool widens the LLM's reasoning surface and the chance it picks the wrong one. Add tools when the agent says it can't do something it should.
- **Mirror the role in the toolset.** A reviewer that has `write_file` is mis-typed. A researcher that has `terminal` is mis-typed. The toolset is the contract — if you wouldn't trust this role with this capability, do not list it.

You can audit any personality's effective toolset by switching to it and asking the agent directly:

```
/personality strategist
You > list the tools you can call. one per line, with one phrase on what each does.
```

The reply is read straight from the system prompt the framework built. Any tool you expected to see that is missing means a typo in `toolset.yaml`; any tool the agent claims that is not in the file is a hallucination — the registry will reject the call when the agent tries.

## 5. Switch to the new personality

If `ethos chat` is not already running, open it:

```bash
ethos chat
```

Inside chat, switch:

```
/personality strategist
```

The header chip updates to `Strategist`. Send a probe message in the voice you wrote:

```
You > i have three projects competing for the next two weeks. which should i ask about first?
```

A working strategist asks a clarifying question (per the `SOUL.md`) rather than guessing. If you see a generic "here are five frameworks!" answer, the personality did not load — check the chip in the header and `/personality list` for typos in the directory name.

If `/personality strategist` errors with `Unknown personality`, the directory either does not exist or has the wrong path. The registry expects `~/.ethos/personalities/<id>/`. Listing helps:

```bash
ls -la ~/.ethos/personalities/strategist/
```

You should see all three files. If `SOUL.md` is missing, the personality loads but speaks in the framework default; if `config.yaml` is missing, the personality is rejected and not listed.

## 6. Hot-reload — edit identity while chat is running

The registry caches each personality directory by the mtimes of its three files. On every [turn](../../getting-started/glossary.md#turn), `FilePersonalityRegistry.loadFromDirectory` checks the fingerprint; if any file changed on disk, it re-reads them before the prompt is built.

Test it. Without exiting chat, open `SOUL.md` in your editor and add one line:

```diff
 I am a strategic advisor. My job is long-horizon planning and prioritisation. I help you decide what to commit to, what to defer, and what to cut entirely.

+I name the mental model I am using when I give advice. "Eisenhower" for urgent-vs-important sorts. "Opportunity cost" for trade-offs. "Sunk cost" when I am asking you to abandon something. Naming the model makes the reasoning checkable.
+
 I think in terms of leverage. ...
```

Save the file. Send the next turn in the same chat session:

```
You > rank those three projects by leverage. show your reasoning.
```

The reply names the mental model in the first line — the edit landed without a restart. Hot-reload covers all three files: change a tool in `toolset.yaml` and the next turn sees the new catalog; change `model` in `config.yaml` and the next turn uses it.

The fingerprint is per-directory; only personalities whose files changed are reloaded. Cost is one `stat` per file on each turn — cheap enough to run unconditionally.

Practical use cases for hot-reload:

- Tune voice live. Send a message, edit one line, send the next. Iterate until the agent sounds right.
- Restrict the toolset after the fact. Remove `web_search` from `toolset.yaml`, save, send a follow-up — the agent now has no web access.
- Swap the model on suspicion of an issue. Edit `model:`, send a probe, decide whether the regression is the model or the prompt.

## 7. Prove per-personality memory isolation

[Memory](../../getting-started/glossary.md#memory) and sessions are different layers. Sessions are the per-conversation log in SQLite, keyed by `cli:<cwd-basename>`. Memory is two markdown files — `MEMORY.md` (per-personality at `~/.ethos/personalities/<id>/MEMORY.md`) and `USER.md` (per-user at `~/.ethos/users/<userId>/USER.md`) — that the agent reads at the start of every session and updates after every turn.

Every personality has its own `MEMORY.md`. The strategist's memory lives at `~/.ethos/personalities/strategist/MEMORY.md` and the researcher's at `~/.ethos/personalities/researcher/MEMORY.md`. They never share a file.

Watch it happen.

First, ask the strategist to record something memorable:

```
You > remember that i prefer quarterly horizons over annual ones.
```

The agent confirms, and (under the hood) `MarkdownFileMemoryProvider.sync` appends a line to the strategist's memory file. Verify it:

```bash
cat ~/.ethos/personalities/strategist/MEMORY.md
```

You should see the new line. Now switch to the researcher and ask:

```
/personality researcher
You > what do you remember about my planning horizon preference?
```

The researcher does not see it. Its memory provider reads `~/.ethos/personalities/researcher/MEMORY.md` — a different file entirely. Switch back:

```
/personality strategist
You > what was my planning horizon preference?
```

The strategist remembers — its memory is its own. Each personality's `MEMORY.md` lives in its own directory, and that isolation is automatic.

A few practical notes:

- The per-personality memory file is created lazily on the first write. Until then, `cat` returns `No such file or directory`.
- Memory is plain markdown. You can read, grep, diff, and commit it. Edit it by hand if you want — the agent will read your edits on the next turn.
- Memory updates surface as `MemoryUpdate[]` entries (`add` / `replace` / `remove`). The framework applies them after `agent_done` fires, so they are visible from the next turn onward.
- Memory is rolling context. The [memory model](../explanation/memory-model.md) page covers `prefetch`/`sync`, retention, and the trade-offs between markdown and vector backends.

## 8. Set a per-session budget cap

A strategist on Opus is expensive per turn. Cap it at the personality level so a runaway session refuses gracefully rather than billing you.

Add one line to `config.yaml`:

```yaml
budgetCapUsd: 0.50
```

Save. The change picks up on the next turn — no restart. Inside chat:

```
/budget
```

You see:

```
Session spend: $0.04321
Cap          : $0.50000
```

When the cap is crossed, the next turn refuses with a `BUDGET_EXCEEDED` error. `/budget reset` clears the counter and lets you continue.

The cap is session-scoped — `/new` starts a fresh count. If you want a daily or monthly cap, that lives elsewhere (provider-side billing limits, observability retention policies in [config.yaml](../reference/config-yaml.md#retention)).

## 9. List the user personalities you have built

```
/personality list
```

Output:

```
Built-ins: researcher · engineer · reviewer
System:    personality-architect · team-architect
User personalities: ~/.ethos/personalities/<id>/
```

The TUI version of the same command (or `ethos personality list` from outside chat) prints both the built-ins and the user-created ones with their descriptions:

```bash
ethos personality list
```

You should see `strategist` listed with the description you wrote.

To make `strategist` the default personality for new sessions:

```bash
ethos personality set strategist
```

This writes `personality: strategist` to `~/.ethos/config.yaml`. The next `ethos chat` starts in strategist without an explicit switch.

## 10. Duplicate a built-in as a starting template

Writing `SOUL.md` from a blank file is harder than editing. Future personalities are usually easier to start from a copy:

```bash
ethos personality duplicate engineer engineer-paired
```

This copies the engineer's three files into `~/.ethos/personalities/engineer-paired/` with a fresh id. You can then edit any of the three to specialise the role — a paired engineer with stricter `safety.approvalMode: smart` and a tighter `budgetCapUsd`, for example — without losing the base toolset.

Common duplicate-and-customise patterns:

- `researcher-domain` — restrict `fs_reach` to one project tree, tighten `web_search` to a domain allowlist via the `safety.network.allow` block.
- `engineer-paired` — flip `safety.approvalMode` to `smart` so the agent confirms destructive tool calls before running them.
- `reviewer-strict` — start from `reviewer`, remove every write tool, narrow `fs_reach.write` to nothing.

The full safety block lives in [Personality config reference](../reference/personality-yaml.md#safety).

## 11. Tighten the filesystem allowlist (optional, recommended)

By default, a personality's `read_file` and `write_file` tools can reach `~/.ethos/personalities/<self>/` and the current working directory. For a personality you trust to run anywhere, that is fine. For one bound to a specific project, narrow the scope.

Add to `config.yaml`:

```yaml
fs_reach.read: ${ETHOS_HOME}/personalities/${self}, ${ETHOS_HOME}/skills, ${HOME}/notes
fs_reach.write: ${ETHOS_HOME}/personalities/${self}, ${HOME}/notes
```

Substitutions are resolved at turn construction:

- `${ETHOS_HOME}` → `~/.ethos`
- `${self}` → the personality's id (`strategist`)
- `${CWD}` → the current working directory the agent is operating from

A read or write outside the allowlist raises a `BoundaryError` at the tool boundary; surfaces translate it into a tool error the agent can see and recover from. The agent does not silently fail — it reads the error and explains what it tried to do.

`fs_reach` is enforced for the agent's file tools (`read_file`, `write_file`, `patch_file`, `search_files`). It is distinct from the `Storage` interface's per-personality boundary, which constrains the framework's own I/O. Both layers exist; only `fs_reach` is something you tune at the personality level.

## 12. What does NOT belong on a personality

The personality schema is intentionally frozen. The following categories do NOT belong in `config.yaml`:

- **Voice modes / TTS engine settings** — operator concerns, set in `~/.ethos/config.yaml`. (Which *voice* the personality speaks in is identity and does belong here — that is the `voice` block.)
- **Emotion / mood / sentiment tags** — prompt-engineering concerns; put them in `SOUL.md`.
- **Per-channel UI affordances** (button text, response templates) — adapter concerns.
- **Default skill content** — skills are their own files, not personality fields.

If you find yourself wanting to add a free-form field, the right answer is usually a skill (markdown file under `~/.ethos/skills/`) or an adapter config (in `~/.ethos/config.yaml` at the top level). The personality stays small on purpose — every field on the schema has a behavioural consequence, and the frozen surface lets the field count be a CI gate.

## 13. Common patterns for the next few personalities

Once you have one custom personality working, the second is faster. A few shapes that show up repeatedly:

- **A read-only reviewer.** Start with `reviewer`, duplicate to `reviewer-strict`, remove every write tool, set `safety.approvalMode: manual`, narrow `fs_reach.write` to nothing. The agent can read and reason but cannot edit.
- **A project-bound engineer.** Duplicate `engineer` to `engineer-<project>`, set `fs_reach.read` and `.write` to that project's tree, attach a project-specific `safety.network.allow` list. The agent cannot accidentally touch unrelated code.
- **A specialist that takes orders from a supervisor.** Build the specialist with a tight toolset and a minimal `SOUL.md`, then reference it from a mesh manifest (see [Teams and meshes](../../building/explanation/teams-and-meshes.md)). The specialist is callable from a coordinator personality.

There is no rule that says you must use all three user-facing built-ins. Many teams end up with two custom personalities — a researcher-style one for exploration and an engineer-style one for execution — and use the rest as references. Two system personalities (personality-architect, team-architect) are also available for meta-level tasks. Start narrow; broaden when you feel the friction of a missing role.

## What you learned

- A personality is three files at `~/.ethos/personalities/<id>/`: identity (`SOUL.md`), wiring (`config.yaml`), allowlist (`toolset.yaml`).
- `config.yaml` is flat YAML; the parser ignores unknown keys. The full field list is in the [Personality config reference](../reference/personality-yaml.md).
- The registry hot-reloads on file mtime — edit any file, send the next turn, the change is live.
- Memory is always per-personality — each personality reads and writes its own `MEMORY.md` automatically.
- `budgetCapUsd` caps the per-session spend and refuses the next turn when crossed; `/budget reset` releases the counter.
- `ethos personality duplicate <src> <dst>` is the cheap way to start a new personality from a working one.

## Next step

Your personality runs locally inside `ethos chat`. The next tutorial puts it in front of real users on Telegram — one bot token, one daemon, one channel adapter, and a first reply in production.

- [Deploy your first Telegram agent](./first-deploy-telegram.md) — from BotFather to a replying bot.
- [Personality config reference](../reference/personality-yaml.md) — every field on `config.yaml`, including `fs_reach`, `safety`, `context_layering`, and `skill_evolution`.
- [Memory model](../explanation/memory-model.md) — how `prefetch` and `sync` interact with the rest of the turn cycle.
- [What is a personality?](../explanation/what-is-a-personality.md) — the design rationale behind making personality a structural component.
