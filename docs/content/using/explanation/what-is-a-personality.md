---
title: "Why is personality the unit, not a system prompt?"
description: "A personality is a directory of three files that atomically swaps prompt, tools, MCP token scope, and model — not a prompt string."
kind: explanation
audience: user
slug: what-is-a-personality
updated: 2026-08-14
---

## Context

Most agent frameworks let you set a "persona" by editing the system prompt. You write "you are a careful reviewer", paste it into a string field, and the agent's voice changes. Its tools do not. Its memory does not. Its model does not. The agent is still the same general-purpose engine wearing a different label.

A [personality](../../getting-started/glossary.md#personality) in Ethos is different. It is a directory at `~/.ethos/personalities/<id>/` with three files in it. Switching to it does not just change how the agent talks. It atomically swaps multiple dimensions of the agent's behaviour — prompt, tools, MCP token scope, and model. You cannot "set the reviewer personality but keep the engineer's write tools" — that combination is not expressible.

The rest of this page explains why the unit is a directory, what changes when you switch, and what the design refuses to put inside that directory.

## Discussion

### A personality is three files, not a string

The directory contains exactly three load-bearing files. Anything else in it is incidental.

```
~/.ethos/personalities/<id>/
├── SOUL.md        first-person identity — who am I, how do I speak
├── config.yaml     name, description, model, fs_reach, mcp_servers, ...
└── toolset.yaml    flat list of allowed tool names
```

`SOUL.md` is the agent speaking in the first person. Not a description of a persona — the agent itself. "I am a methodical research assistant. I cite primary sources. I flag uncertainty rather than smoothing over it." Loaded as the system prompt baseline.

`config.yaml` is plain `key: value`. It names the personality, declares which model handles its turns, optionally restricts filesystem reach, and optionally allowlists MCP servers and plugins. The full field list is in the [personality config reference](../reference/personality-yaml.md).

`toolset.yaml` is a flat list of [tool](../../getting-started/glossary.md#tool) names. The agent literally cannot call a tool that is not in this list — `DefaultToolRegistry.toDefinitions(allowedTools)` filters what the LLM ever sees, and `executeParallel` rejects calls outside the allowlist. The restriction is not advisory.

A minimal `config.yaml`:

```yaml
name: Reviewer
description: Critical, evidence-based reviewer that raises concerns directly.
model: claude-sonnet-4-6
```

A minimal `toolset.yaml`:

```yaml
- read_file
- search_files
- session_search
```

That is the entire surface for a working personality. The agent reads `SOUL.md` to know who it is, `config.yaml` to know which model and routing, and `toolset.yaml` to know what it can call. Three files in, working agent out.

### The three dimensions that move together

Switching personalities in chat — `/personality engineer` to `/personality reviewer` — changes all of them at once:

| Dimension | What changes | Source of truth |
|---|---|---|
| System prompt | Identity, voice, what the agent is *for* | `SOUL.md` |
| Tool access | Which actions the LLM can request | `toolset.yaml` |
| MCP token scope | Per-personality OAuth tokens and MCP tool policy | `mcp_servers` in `config.yaml`, tokens at `~/.ethos/personalities/<id>/mcp/<name>/access_token` |
| Model routing | Which LLM handles the turn | `model` in `config.yaml` |

You cannot accidentally run the engineer's write-shaped tools under the reviewer's read-only toolset. The reviewer's `toolset.yaml` does not list them. The dimensions are joined at the registry, not at convention. See [Set up MCP for a personality](../how-to/set-up-mcp-for-a-personality.md) for the step-by-step.

```mermaid
flowchart LR
  ETHOS(("◆ ETHOS<br/>ONE IDENTITY<br/>replicate to scale"))
  ETHOS --> SOUL["Identity — SOUL.md"]
  ETHOS --> PCFG["Config + model routing — config.yaml"]
  ETHOS --> TSET["Toolset allowlist — toolset.yaml"]
  ETHOS --> SKL["Skills"]
  ETHOS --> KAN["Kanban board"]
  ETHOS --> AMEM["Agent memory — MEMORY.md"]
  ETHOS --> MCPV["MCP servers"]
  ETHOS --> TLS["Tools — file · web · terminal · memory"]
  SOUL --> PDIR[("[identity]<br/>~/.ethos/personalities/&lt;id&gt;/")]
  PCFG --> PDIR
  TSET --> PDIR
  SKL --> SKDIR[("[identity]<br/>personalities/&lt;id&gt;/skills/")]
  KAN --> KDB[("[identity]<br/>personalities/&lt;id&gt;/kanban.db")]
  AMEM --> MDIR[("[identity]<br/>personalities/&lt;id&gt;/MEMORY.md")]
  MCPV --> MCPC[("[identity]<br/>per-personality MCP config<br/>scoped token + tool policy")]
  TLS --> EXT[["[identity · gated]<br/>tools-* extensions — code<br/>allowlisted by toolset.yaml"]]
  ETHOS -. reads / writes .-> SESS["Sessions / history"]
  ETHOS -. reads / writes .-> GCONF["Global config & secrets"]
  SESS --> SDB[("[global]<br/>~/.ethos/sessions.db — SQLite WAL+FTS5<br/>lanes keyed platform:botKey:chatId")]
  GCONF --> GCFG[("[global]<br/>~/.ethos/config.yaml · keys.json · pairing.db")]
  GCONF --> IMAP[("[global] ⏳<br/>~/.ethos/users/identity-map.json<br/>platform + sender → user")]
  ETHOS --> CHAN["Channels / gateway"]
  CHAN -. configured in .-> GCFG
  CHAN --> SLACK["Slack"]
  CHAN --> TG["Telegram"]
  CHAN --> DISC["Discord"]
  CHAN --> MAIL["Email"]
  CHAN --> SOON["WhatsApp · Signal · iMessage<br/>Matrix · SMS · Feishu ⏳"]
  SLACK --> CADP[("[identity × channel]<br/>&lt;storage_root&gt;/&lt;platform&gt;/<br/>thread state · mode overrides")]
  TG --> CADP
  DISC --> CADP
  MAIL --> CADP
  SLACK --> UA[("[identity × channel × user] ⏳<br/>User A — USER.md")]
  SLACK --> UB[("[identity × channel × user] ⏳<br/>User B — USER.md")]
  TG --> UC[("[identity × channel × user] ⏳<br/>User C — USER.md")]
  TG --> UD[("[identity × channel × user] ⏳<br/>User D — USER.md")]
  classDef hub fill:#1f2937,stroke:#e5e7eb,color:#ffffff;
  classDef g fill:#103024,stroke:#22c55e,color:#e5e7eb;
  classDef i fill:#102845,stroke:#3b82f6,color:#e5e7eb;
  classDef c fill:#2a1745,stroke:#a855f7,color:#e5e7eb;
  classDef u fill:#45330f,stroke:#f59e0b,color:#e5e7eb;
  class ETHOS hub;
  class SOUL,PCFG,TSET,SKL,KAN,AMEM,MCPV,TLS,PDIR,SKDIR,KDB,MDIR,MCPC,EXT i;
  class SESS,GCONF,SDB,GCFG,IMAP g;
  class CHAN,SLACK,TG,DISC,MAIL,SOON,CADP c;
  class UA,UB,UC,UD u;
```

The conversation thread does not fork on a switch. The same [session](../../getting-started/glossary.md#session) history is visible to whichever personality is active next. You are one human swapping hats, not two different users opening two different chats.

### Hot-reload, mtime-cached

`FilePersonalityRegistry` re-reads a personality only when one of its three files changes on disk. The loader fingerprints `config.yaml`, `SOUL.md`, and `toolset.yaml` by `mtime`; identical fingerprint means the cached config wins. Calling `loadFromDirectory()` on every turn is cheap when nothing changed and reflects the new content on the next turn when something did.

This is the property that lets you edit `SOUL.md` mid-session, send a follow-up message, and watch the agent's voice change without losing history. The conversation continues; the role updates.

There is one quiet benefit of this design. Tuning a personality is a fast loop — edit, send a message, see the difference, edit again. The cost of iterating on "how should the reviewer phrase findings" is zero process restarts and zero session loss. The personality is a config file, not a stored procedure.

### The schema is frozen

`PersonalityConfig` lives in `packages/types/src/personality.ts` and the field count is mechanically gated. The CI test `packages/types/src/__tests__/personality-field-count.test.ts` parses the interface at test time and fails if the count drifts from `.personality-field-count` at the repo root. Adding a top-level field requires a `personality-schema-change` label, two-maintainer approval, and bumping the count in the same commit.

This is not procedural caution. The schema is the load-bearing surface — it is what defines, end-to-end, what a personality is. Letting it grow uncontrolled would turn the personality directory into a config dump. The friction is there to force a clear answer to a hard question every time the surface expands.

### What does *not* belong on a personality

The categories the schema explicitly refuses:

- Voice modes, VAD tuning, speech parameters, TTS engine settings.
- Emotion, mood, sentiment tags.
- Response templates and label vocabulary.
- Per-channel UI affordances (button labels, card layouts).

Each of these is a real product need; none of them are personality concerns. Response templates belong to skills. UI affordances belong to the surface (web, CLI, Telegram). Voice splits along the same line: *which* voice a personality speaks in is identity and lives in its `voice` block; *when* and *whether* it speaks is the operator's, in `~/.ethos/config.yaml`. Mixing them into the personality directory was the first instinct and has been refused four times — the goal is a tight unit you can reason about, not a god object that accretes every cross-cutting concern.

### The first-person voice in `SOUL.md`

A common pattern in prompt engineering is the third-person description: "You are a careful reviewer who asks for evidence." It works, but it produces an agent that can be reasoned out of its role — "actually, just for this turn, do not ask for evidence". The third-person framing is advice; the model can argue with it.

`SOUL.md` is written in the first person. The agent is not described to itself; the agent speaks as itself. "I am a methodical research assistant. I cite primary sources. I flag uncertainty rather than smoothing over it." The grammatical shape changes the failure mode: the agent is more reluctant to drop its identity mid-turn because it would have to switch grammatical persons to do so.

Keep `SOUL.md` opinionated. A vague identity produces vague behaviour. "I am a critical, evidence-based reviewer" gives the model a stronger anchor than "I review code carefully". Be concrete about what the role refuses to do; the refusals are how a personality stays itself when a user asks it to be something else.

### Isolation enforced, not advised

The personality boundary is not a recommendation. Several mechanisms enforce it at runtime:

- `toolset.yaml` is filtered at the [tool registry](../../getting-started/glossary.md#tool-registry). Tools not in the list are invisible to the LLM and rejected on execution.
- `fs_reach` is enforced by a `ScopedStorage` decorator around the file tools. Paths outside the allowlist throw `BoundaryError`. A researcher's `read_file` cannot peek at the engineer's `MEMORY.md`.
- `mcp_servers` is default-deny. A globally configured MCP server is invisible to a personality unless that personality lists it.
- `plugins` is default-deny. An installed plugin is dormant until at least one personality opts in.
- [Skills](what-is-a-skill.md) are filtered by capability and by environment requirements. A skill declaring `requires.env: [SLACK_BOT_TOKEN]` or `requires.bins: [curl]` in its frontmatter is silently skipped for any personality running in an environment where those are unavailable.
- Memory is always per-personality. Each personality reads and writes `~/.ethos/personalities/<id>/MEMORY.md` automatically — the engineer's running context never leaks into the reviewer's.

The combined effect: switching to the reviewer is not "the same agent with a smaller prompt". It is a different agent that cannot do the things it should not do.

This matters operationally. A prompt-injection attack that tells a reviewer "now edit this file" cannot succeed regardless of how persuasive the injected payload is, because the write tool is not in the toolset and is not in the registry. The model can refuse a request, but more importantly, the framework refuses it before the model even sees the tool. Defence in depth, with the depth being structural.

### The enforcement is at the registry, not in the prompt

A subtle property of how the toolset works: the agent does not "decide" to honour it. The `DefaultToolRegistry.toDefinitions(allowedTools)` call returns only the tool definitions the personality has in its allowlist — the LLM never sees the existence of tools outside that set. The model cannot ask for a tool it cannot see.

A defensive second check runs at execution time. `executeParallel` rejects any tool call whose name is not in the personality's allowlist with `is_error: true`. The mechanism keeps the Anthropic message contract intact — every `tool_use` block needs a matching `tool_result` block — even when the tool is structurally forbidden.

The combined effect: a personality with a five-tool list literally cannot call a sixth tool, regardless of how the prompt is crafted. The boundary is the registry; the prompt is the explanation.

### Why a directory of files, not a row in a database

Three reasons.

You can read it. A personality is plain text. You can `cat SOUL.md`, `grep` your toolsets, `diff` two versions, commit the directory to a repo, and review a personality change in code review. Memory you cannot read is memory you cannot trust; the same logic applies to identity.

You can version it. A team shares personalities by committing them to the repo. The reviewer personality your team uses for code review is in source control next to the code it reviews. There is no separate "personality database" to back up.

You can swap the backend without changing the contract. `PersonalityRegistry` is an interface in `@ethosagent/types`. `FilePersonalityRegistry` is the default; a remote registry, a database-backed one, or a hot-reloading network share are straight implementations. The data model — three files and a toolset — does not change.

### The whole-system property

Personalities are the unit at which several otherwise-disconnected concerns get joined: identity, tool access, MCP token scope, memory layout, model routing. Each of these concerns is its own subsystem, with its own interface in `@ethosagent/types` — `LLMProvider`, `ToolRegistry`, `MemoryProvider`, the registry itself. None of them know about the others.

What ties them together is the personality. The agent loop reads the active personality once at the start of a turn and uses it to parameterise every subsystem call: which model to ask, which tools to expose, which memory directory to read. Subsystems stay decoupled; the personality is the binding point.

This is the practical answer to "why not split the dimensions into separate config files". You can edit each subsystem's behaviour independently — swap the LLM provider, change the session backend, replace the memory provider — and nothing about the personality file format changes. The personality is the *role*, not the wiring.

### What stays the same across a switch

Some things are *not* personality-scoped, on purpose. Switching personalities does not change:

- The current [session](../../getting-started/glossary.md#session) and its history. The thread continues; the next message reaches a different role.
- Your `USER.md`. Who you are is a person fact, not a role fact. `USER.md` is keyed by user (at `~/.ethos/users/<userId>/USER.md`), not by personality.
- LLM credentials. Personalities pick a model; the keys to call the model live in `~/.ethos/config.yaml`.
- The CLI surface and channel adapters. Telegram and Discord do not reload when you switch personalities.

The boundary the personality controls is "what the agent does and says". The boundary it does not control is "who you are and where you are". Those distinctions keep the user in continuous control of the session even while the role shifts.

### The cost of getting personality right

A framework that makes personality cheap to define makes personality easy to multiply. That sounds good and is partly a trap. A personality you defined for a one-off use case is one more thing to maintain, one more entry in `/personality list`, one more directory under `~/.ethos/`. The cost is small, but it is not zero.

The rule of thumb that has held up: a personality earns its place when it answers the key questions distinctly. If it would use the same tools as `engineer` and the same model as `engineer`, with only the prompt differing, it is probably a [skill](../../getting-started/glossary.md#skill) that loads under `engineer` — not a personality of its own. The dimensions test is the gate.

### Personalities can learn from usage

A personality can opt into automatic skill evolution. When `skill_evolution.enabled: true` is set in the personality's `config.yaml`, the skill evolver analyzes tool-call patterns after qualifying turns — those exceeding `skill_evolution.min_tool_calls` and outside `skill_evolution.cooldown_minutes` — and proposes new skills or rewrites existing ones. Proposed skills land in `~/.ethos/skills/.pending/<personalityId>/` for review.

The `engineer` built-in ships with skill evolution enabled by default. This is how a personality adapts to the user's working patterns without the user writing skill files by hand.

Skill evolution does not change the personality's three files. The proposed skills are [skills](what-is-a-skill.md) — standing instructions under the personality, not modifications to the personality itself. The personality stays frozen; its guidance library grows. See the [personality config reference](../reference/personality-yaml.md) for the full set of `skill_evolution.*` fields.

### Glossary first, definition next

`personality` is the canonical term throughout the docs. The glossary entry at [Personality](../../getting-started/glossary.md#personality) defines it tersely. This page is the long form. Other pages link back here when they need to refer to "what a personality really is" rather than just "the personality config".

When you see `~/.ethos/personalities/<id>/` in code or docs, that is what is meant: the directory at that path, with the three files inside it. The `id` is the directory name; it is what `/personality <id>` switches to; it is what `personality.id` reads in code.

### Where the schema sits in the codebase

`PersonalityConfig` is declared in `packages/types/src/personality.ts`. It has zero runtime dependencies — the type-only package can be imported from anywhere in the monorepo without dragging in concrete code. This is the same property that lets `LLMProvider`, `SessionStore`, and `MemoryProvider` be implemented in any package: the contract lives in a place that costs nothing to depend on.

The registry that resolves a personality lives at `extensions/personalities/src/index.ts`. It implements the `PersonalityRegistry` interface, loads from disk via a `Storage` (the abstraction over filesystem I/O), and caches by file fingerprint. Tests use an `InMemoryStorage` to populate fixtures without touching disk; production uses `FsStorage`.

The shape of this layering — interface in `@ethosagent/types`, default implementation in `extensions/`, injection at the wiring layer — is a recurring pattern. The personality is one example of it; the LLM provider, session store, and memory provider are the others. Read one and you have read the shape of all four.

## Trade-offs

**You give up the "one super-agent with knobs" mental model.** Every distinct role is a directory you commit to. Three user-facing roles is three directories, three `SOUL.md` files, three toolsets. The alternative — one agent with a `mode` field and per-mode tool filters — was rejected because the resulting code path is one big branch on the mode flag and the boundaries leak.

**You give up cross-personality memory entirely.** Memory is always per-personality — the reviewer cannot see the engineer's notes. This is the point — opinions about what was reviewed should not leak into what gets built. If you need cross-personality context, read the other personality's `MEMORY.md` directly or wire a shared backend via the `MemoryProvider` interface.

**You give up a single configuration surface.** A personality is a directory of three files, not a YAML field in one config. Three user-facing personalities is nine files. The trade is legibility for compactness: a `cat ~/.ethos/personalities/reviewer/SOUL.md` is a complete answer to "what is the reviewer", and that answer survives `grep`, `diff`, and code review.

**You cannot pick a model per turn.** A personality declares one model. If you want Opus on planning and Sonnet on writing, that is two personalities (`researcher` is Opus, `engineer` is Sonnet) that you switch between, not a knob inside one. The atomic-swap rule makes that legible.

**You pay a small cost on every turn.** The mtime-fingerprinted reload is cheap, but it is not zero. Three `stat` calls per personality per turn. For a registry with twenty personalities, that is sixty stat calls before the model is even asked. On a fast filesystem this is negligible; on a network filesystem it is measurable. The trade is the live-edit story: tuning a personality without restarting beats process restart costs by a large margin.

Alternatives considered:

- A single `personality.yaml` with a `mode` field. Rejected: the dimensions had to move together, and a single config that branches on a mode field is a god object the schema cannot defend.
- Personality as a function in code. Rejected: defeats hot-reload, defeats version control of identity, defeats the "team shares a reviewer" workflow.
- Personality as a row in SQLite. Rejected: not readable, not greppable, requires a migration to add a field, no `diff` story.
- Tool access as a separate file unrelated to the personality. Rejected: the atomic-swap property is the headline. Joining tool access to the personality at the directory level keeps the dimensions visibly coupled; splitting them invites drift where a personality "is" a reviewer but "can" write.
- A merge model where personality overlays change a base personality. Rejected as overengineering for v1. Three user-facing built-ins plus duplicate-and-edit is enough; overlays add a layer that obscures what a personality actually is.

## See also

- [What are the built-in personalities?](built-in-personalities.md) — the three user-facing built-in personalities and what each is for
- [Why MEMORY.md and USER.md?](memory-model.md) — how per-personality memory and per-user identity work together
- [Why are sessions scoped per working directory?](sessions-and-history.md) — what does *not* change when you switch personalities
- [Personality config reference](../reference/personality-yaml.md) — every field in `config.yaml` and `toolset.yaml`
- [Create your first personality](../tutorials/first-personality.md) — author your own from scratch
