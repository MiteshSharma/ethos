# Extensions

Concrete implementations of the contracts in `@ethosagent/types`. Core (`packages/core`) never imports from this directory — every extension is wired into `AgentLoop` from `apps/ethos/src/wiring.ts` (or via `@ethosagent/plugin-loader` at runtime).

## Index

### LLM providers
- [llm-anthropic](./llm-anthropic) — Anthropic Messages API + auth-key rotation.
- [llm-openai-compat](./llm-openai-compat) — Any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, Gemini compat shim, DeepSeek, …).

### Session + memory
- [session-sqlite](./session-sqlite) — `SessionStore` on `better-sqlite3` (WAL + FTS5).
- [memory-markdown](./memory-markdown) — `MemoryProvider` over flat `MEMORY.md` / `USER.md`.
- [memory-vector](./memory-vector) — `MemoryProvider` over chunked SQLite + local 384-dim embeddings.

### Personality stack
- [personalities](./personalities) — `PersonalityRegistry` with five built-ins; mtime-cached loader.
- [skills](./skills) — `ContextInjector`s for skills, project files (`AGENTS.md`/`CLAUDE.md`/`SOUL.md`), and memory guidance.
- [skill-evolver](./skill-evolver) — Reads eval output and asks the LLM to draft new/rewritten skills into a `pending/` queue.
- [plugin-loader](./plugin-loader) — Discovers and activates third-party plugins from `~/.ethos/plugins/`, `./.ethos/plugins/`, and `node_modules`.

### Tools
- [tools-file](./tools-file) — `read_file`, `write_file`, `patch_file`, `search_files`.
- [tools-terminal](./tools-terminal) — `terminal` shell tool + dangerous-command guard hook.
- [tools-web](./tools-web) — `web_search` (Exa) + `web_extract` with SSRF guard.
- [tools-browser](./tools-browser) — Headless Chromium via Playwright; ARIA-snapshot driven `@e{n}` refs.
- [tools-code](./tools-code) — `run_code` (Docker-sandboxed), `run_tests`, `lint`.
- [tools-cron](./tools-cron) — Six tools wrapping the `@ethosagent/cron` scheduler.
- [tools-delegation](./tools-delegation) — `delegate_task`, `mixture_of_agents`, `route_to_agent`, `broadcast_to_agents`.
- [tools-mcp](./tools-mcp) — Adapts external MCP servers as `mcp__<server>__<tool>`.
- [tools-memory](./tools-memory) — `memory_read`, `memory_write`, `session_search`.

### Platforms
- [platform-discord](./platform-discord) — Discord Gateway WebSocket via `discord.js`.
- [platform-slack](./platform-slack) — Slack Socket Mode via `@slack/bolt`.
- [platform-telegram](./platform-telegram) — Telegram long-poll via `grammy`.
- [platform-email](./platform-email) — IMAP poll + SMTP send, threaded by subject.

### Infrastructure
- [acp-server](./acp-server) — JSON-RPC 2.0 server (stdio / HTTP / WebSocket) exposing `AgentLoop`.
- [agent-mesh](./agent-mesh) — File-backed registry of running agents (capabilities, heartbeats, routing).
- [gateway](./gateway) — Bridges `PlatformAdapter` inbound into `AgentLoop`; lanes, dedup, slash commands, shutdown.
- [sandbox-docker](./sandbox-docker) — `docker run --rm` wrapper with caps dropped, network off, memory capped.
- [cron](./cron) — File-locked cron scheduler (`~/.ethos/cron/jobs.json`, 60 s tick).

### Operational tooling
- [batch-runner](./batch-runner) — Run `AgentLoop` over many tasks with checkpointing.
- [eval-harness](./eval-harness) — Score `AgentLoop` against a labeled dataset (exact / contains / regex / llm-judge).
- [claw-migrate](./claw-migrate) — Migrate `~/.openclaw/` → `~/.ethos/`.

---

## Adding a new extension

1. Create `extensions/<name>/` with `package.json` (`@ethosagent/<name>`, `workspace:*` deps on `@ethosagent/types` etc.) and `src/index.ts`.
2. Implement the contract you need from `@ethosagent/types` (`LLMProvider`, `SessionStore`, `MemoryProvider`, `PersonalityRegistry`, `Tool<TArgs>`, `ContextInjector`, `PlatformAdapter`, hook handlers, …).
3. Add a path alias to the root `tsconfig.json` so `@ethosagent/<name>` resolves to `./src` in dev.
4. Wire it in `apps/ethos/src/wiring.ts` (or expose it as a plugin via `@ethosagent/plugin-loader`).
5. **Write a README following the template below.** The README is how other contributors orient — without it, your extension is invisible to the next person reading the repo.

---

## README template

Every extension README follows the structure below. Sections marked **required** must be present in every README. Optional sections are included only when they apply to the extension.

````markdown
# @ethosagent/<package-name>

<one-sentence summary of what this is — what contract it implements, what it does>

## Why this exists                         (required)

2–4 sentences. Answer three questions:
- What problem does this solve?
- How does it fit into Ethos? (Which contract from `@ethosagent/types` does it implement?
  Which other extensions or core registries depend on it?)
- What would be missing without it?

Don't explain what Ethos is — link to the root `CLAUDE.md` if needed. Focus on
this extension's contribution.

## What it provides                        (required for service / library packages)
                                           OR
## Tools provided                          (required for `tools-*` packages)

For service / library packages, a bullet list of public exports:
- `ClassOrFunctionName` — one-line description of its role.
- `TypeName` — what it represents.

For tool packages, a table:

| Tool name      | Toolset    | Purpose |
|----------------|------------|---------|
| `tool_name_1`  | `file`     | One-line description. |
| `tool_name_2`  | `file`     | One-line description. |

If the tool package also exports non-tool things (a hook factory, a helper),
list them as a bullet list after the table.

## How it works                            (required)

2–5 short paragraphs covering the mechanics:
- Lifecycle: when is it constructed, when does it run, when does it tear down?
- Streaming / state: how does data flow through it?
- External dependencies: env vars, native modules, daemons, network calls.
- Anything non-obvious from reading `src/index.ts` linearly.

Reference real files and line numbers when calling out non-obvious behavior:
`src/foo.ts:42`. Future contributors will jump straight there.

Don't restate what the code says — name *why* it does what it does. The "what"
is in the source; the README is the place for the "why".

## Configuration                           (optional — only if the extension takes
                                           env vars or non-trivial constructor config)

Env vars and config keys required to enable / configure the extension. Use a table:

| Field          | Required | Notes |
|----------------|----------|-------|
| `API_KEY`      | yes      | Where to get it. |
| `pollInterval` | no       | Default value, units. |

## On-disk layout                          (optional — only if the extension reads
                                           or writes structured directories)

Show the directory tree the extension expects or produces:

```
~/.ethos/<thing>/<id>/
  some-file.yaml      # what it contains
  another.md          # what it contains
```

## Usage                                   (optional — only for extensions with
                                           a CLI or programmatic entry point worth
                                           showing in isolation)

CLI invocation or short programmatic snippet. Most extensions don't need this —
they're wired by `apps/ethos/src/wiring.ts` and never invoked directly.

## Gotchas                                 (required if any non-obvious behavior
                                           exists — for nearly every extension,
                                           this means yes)

Bullet list of things that will surprise a contributor reading the source for
the first time. Pull from your own investigation AND from the "Learnings from
building this codebase" section in the root `CLAUDE.md`.

Examples of what belongs here:
- Silent fallbacks ("Markdown parse errors silently retry as plain text").
- Hardcoded constants that look configurable.
- Bugs that are known and intentional, or known and unfixed.
- Cross-package coupling that isn't obvious from imports
  (e.g. "`pending/` is skipped by `@ethosagent/skills` so drafts here are inert").
- Gotchas in dependencies (e.g. `better-sqlite3` needs `pnpm.onlyBuiltDependencies`).

Skip the section only if there really are none.

## Files                                   (required)

| File                          | Purpose |
|-------------------------------|---------|
| `src/index.ts`                | Public surface — what's exported. |
| `src/<other>.ts`              | What it contains. |
| `src/__tests__/`              | Test coverage (just list the directory; no need to enumerate every test). |
````

---

## Style rules

- **Concise, technical, no marketing fluff.** No emojis. No "powerful", "robust", "blazing fast", "seamless".
- **Match the tone of the root `CLAUDE.md`.** Short paragraphs. Direct sentences. Useful detail.
- **Don't invent features.** If the code doesn't do something, don't claim it does. Read the source before writing.
- **Reference real names from source.** Class names, function names, constants, file paths. Use `src/foo.ts:42` for line refs.
- **Aim for under 150 lines per README.** Larger architectural extensions (`agent-mesh`, `gateway`, `acp-server`) may run a bit longer when warranted.
- **Update the README when behavior changes.** A README that lies is worse than no README.
