Ethos — AI Agent Codebase Guide
Behavioral guidelines
These rules apply to every task in this repo.

1. Think before coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

State your assumptions explicitly. If uncertain, ask.
If multiple interpretations exist, present them — don't pick silently.
If a simpler approach exists, say so. Push back when warranted.
If something is unclear, stop. Name what's confusing. Ask.
2. Simplicity first
Minimum code that solves the problem. Nothing speculative.

No features beyond what was asked.
No abstractions for single-use code.
No "flexibility" or "configurability" that wasn't requested.
No error handling for impossible scenarios.
If you write 200 lines and it could be 50, rewrite it.
3. Surgical changes
Touch only what you must. Clean up only your own mess.

Don't "improve" adjacent code, comments, or formatting.
Don't refactor things that aren't broken.
Match existing style, even if you'd do it differently.
Remove imports/variables/functions that your changes made unused.
Every changed line should trace directly to the user's request.
4. Goal-driven execution
Define success criteria. Loop until verified.

"Add validation" → write tests for invalid inputs, then make them pass.
"Fix the bug" → write a test that reproduces it, then make it pass.
Always run pnpm check (typecheck + lint + test) before declaring done.
Always run pnpm lint before pushing. CI fails on lint errors; catching them locally is one command. If lint reports fixable issues, run pnpm lint:fix and re-check before git push. Don't push code that hasn't been linted.

5. Surface conflicts, don't average them
If two existing patterns in the codebase contradict, don't blend them. Pick one (the more recent or more tested), explain why, and flag the other for cleanup. Average code that satisfies both rules is the worst code.

6. Ask before adding to code you don't understand
"Looks orthogonal to me" is the most expensive phrase in this codebase. If you can't articulate why existing code is structured the way it is, ask before adding adjacent code.

7. Follow the constitution
[ARCHITECTURE.md](./ARCHITECTURE.md) is the structural source of truth for this codebase. It defines the layer model, dependency direction, frozen schemas, safety rules, and the laws the validator enforces. Read it before:

- Adding or moving any package, extension, or app.
- Adding a workspace dependency, especially one that crosses layers.
- Changing a contract interface under `packages/types/`.
- Touching any `safety-*` module.
- Modifying a frozen schema (personality, plugin contract, storage, agent event, etc.).
- Introducing raw `node:fs` calls in any module that participates in a personality boundary.
- Adding `console.*` calls in library code.

If your change conflicts with the constitution, either refactor to fit or open a constitutional amendment per [ARCHITECTURE.md §VI](./ARCHITECTURE.md). Do not introduce constitutional violations to land a feature faster — the cost compounds.

8. Git Safety
Never commit directly to main without explicit user confirmation. Never delete files or run destructive git operations (push, reset --hard, branch -D, checkout --, clean -f) without confirmation. When asked to "fix" or "clean up," stop and confirm scope before taking destructive actions. Approval for one destructive action is not approval for the next — confirm each time.

9. Plan vs Implementation
When the user asks to update, refine, or revise a plan document, ONLY edit the plan file — do not begin implementing the code changes described in the plan. Wait for an explicit "now implement" instruction before writing implementation code. The plan/ directory is gitignored — do not create worktrees for plan-only edits.

10. Verification Before Claims
Before reporting a phase or task as complete, re-verify by running `pnpm test && pnpm typecheck && pnpm lint`. When reviewing code from sub-agents, verify each claimed bug against the actual source before accepting or acting on it — sub-agent reviews have hallucinated bugs in the past. Do not claim "tests pass" or "lint clean" from memory; re-run.

11. Main session orchestrates; sub-agents execute
The main session does not write or edit files. Every code or doc change — even a one-line typo, a single-file rename, a single-language tweak — is delegated to a sub-agent via the Agent tool. The main session's job is: understand the request, draft a self-contained brief, review the result against the brief, report to the user.

- Applies to: Edit, Write, MultiEdit, and any Bash command that mutates the repository (git operations that change state, mv, rm, package installs, code generation that produces files).
- Does NOT apply to: read-only inspection (Read, Grep, Glob, `ls`/`cat`/`find`/`git status`/`git diff`/`git log` via Bash) and read-only verification (`pnpm test`, `pnpm typecheck`, `pnpm lint` — they do not mutate source).
- Exception: edits to AGENTS.md, CLAUDE.md, and other meta files that define agent operating rules may be made in the main session, since they govern the orchestration loop itself.

Why: the main session's context fills with conversation; sub-agents get clean, scoped context for the actual change. Mistakes contained to a sub-agent do not pollute the main session's understanding of the codebase.

What this is
Ethos is a TypeScript agent framework where personality is architecture. A personality (SOUL.md + toolset.yaml + config.yaml) is a structural component — not a system prompt string — that shapes tool access, memory filtering, model routing, and communication style simultaneously.

The CLI (ethos) gives you an interactive agent that persists sessions across restarts, loads built-in or custom personalities, and streams LLM responses with tool events.

Tech stack
Runtime	Node 24, TypeScript 6 strict
Dev runner	tsx (handles extensionless imports, no build step in dev)
Bundler	tsup (production builds only)
Package manager	pnpm workspaces
Lint / format	Biome 2 (single quotes, 2-space indent, 100-char line width)
Tests	vitest 4
LLM	@anthropic-ai/sdk, openai
SQLite	@ethosagent/sqlite (node:sqlite shim, WAL + FTS5)
Monorepo layout
packages/
  types/            @ethosagent/types     zero-dep interface contracts
  core/             @ethosagent/core      AgentLoop, ToolRegistry, HookRegistry, PluginRegistry

extensions/
  llm-anthropic/    @ethosagent/llm-anthropic       AnthropicProvider + AuthRotatingProvider
  llm-openai-compat/@ethosagent/llm-openai-compat   OpenAICompatProvider (OpenRouter/Ollama/Gemini)
  session-sqlite/   @ethosagent/session-sqlite      SQLiteSessionStore (WAL + FTS5)
  memory-markdown/  @ethosagent/memory-markdown     MarkdownFileMemoryProvider
  personalities/    @ethosagent/personalities       FilePersonalityRegistry + 5 built-ins

apps/
  ethos/            @ethosagent/cli       CLI entry point

plan/               Architecture notes, 29-phase roadmap (see PLAN.md), plus IMPROVEMENT.md tracking corrections
Path aliases in tsconfig.json point all @ethosagent/* imports to ./src/ source directly — no build step required in dev.

Core design principles
Interface contracts first — all extension points typed in @ethosagent/types. Core never imports concrete implementations.
Injection at construction — AgentLoop receives every component via AgentLoopConfig. Nothing reaches for globals.
No runtime deps in @ethosagent/types — zero imports, zero deps. Every package can import from it safely.
Extensionless TypeScript imports — import { X } from './foo' (no .js). tsx handles resolution in dev; tsup bundles for prod.
Key files
File	What it does
packages/types/src/index.ts	Barrel — every interface in the system lives here
packages/core/src/agent-loop.ts	The 12-step AsyncGenerator<AgentEvent> turn cycle
packages/core/src/tool-registry.ts	executeParallel() with per-call budget splitting
packages/core/src/hook-registry.ts	Void / Modifying / Claiming hook execution models
apps/ethos/src/wiring.ts	Assembles AgentLoop from ~/.ethos/config.yaml
apps/ethos/src/commands/chat.ts	Readline REPL — streaming output + slash commands
extensions/session-sqlite/src/index.ts	WAL + FTS5, rowid tie-breaking for ordered history
extensions/personalities/src/index.ts	mtime-cached personality loader, loadFromDirectory()
AgentEvent types
AgentLoop.run() is an AsyncGenerator<AgentEvent>. Event types:

type AgentEvent =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start';     toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress';  toolName: string; message: string; percent?: number }
  | { type: 'tool_end';       toolCallId: string; toolName: string; ok: boolean; durationMs: number; error?: string }  // error set only when ok: false
  | { type: 'usage';          inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'halt';           kind: 'budget' | 'watcher'; rule: string; toolName?: string; count?: number; message: string }  // early safety stop; a normal done still follows
  | { type: 'error';          error: string; code: string }
  | { type: 'done';           text: string; turnCount: number }
Hook registry
Three execution models — pick based on what the hook does:

Model	Method	Semantics
Void	fireVoid	All handlers run in parallel via Promise.allSettled. Failures are swallowed (fail-open). Use for side effects: logging, analytics, notifications.
Modifying	fireModifying	Handlers run sequentially. Results are merged — first non-null value per key wins. Use when handlers need to amend the prompt or override args.
Claiming	fireClaiming	Handlers run sequentially. Stops at first { handled: true }. Use for routing decisions: which platform handles this message.
All three return () => void cleanup functions from register*().

before_ticket_complete (claiming) — fired by the kanban_complete tool before the running → done transition, with { taskId, summary, acceptanceCriteria? }. A handler returning { handled: true, reason } rejects the completion: the ticket goes to needs_revision (with reason in the audit trail) instead of done. Opt-in in standalone deployments — no handler registered (or no HookRegistry wired) means fireClaiming returns { handled: false } and completion proceeds unchanged. In team deployments (config `teamName` set), Phase 7 default-wires an eval-harness verifier handler (`createCompletionVerifier` in `@ethosagent/tools-kanban`, registered in `packages/wiring/src/compose-tools.ts`) that scores the summary against acceptanceCriteria in a separate LLM pass — fail-closed on verifier errors, and it does not skip on the assignee's autonomyTier. The original assignee can re-claim a needs_revision ticket and retry; the re-claim counts against the task's max_retries budget.

Tool-progress audience boundary (Phase 30.2)
Tools call ctx.emit({ type: 'progress', toolName, message, audience? }) to surface progress. The audience field is the gate:

Default ('internal') — consumed by the framework only (logs, telemetry, dev TUI). Channel adapters (telegram, discord, slack, whatsapp, email) and apps/ethos/src/commands/chat.ts MUST NOT surface it.
'user' — explicit per-event opt-in by the tool author. Used for long-running operations where silent latency would be confusing (read_file reading >1MB, multi-step bash). The framework never opts in for the tool.
The same gate applies to the tool_progress AgentEvent. Surface code (CLI chat, channel adapters) renders only events with audience: 'user'.

Channel adapter contract
Every outbound channel message — including streaming finals and edits — flows through a single dedup path in the gateway: MessageDedupCache keyed by (sessionId, sha256(content)) with a 30s TTL. Adapters call adapter.send(); the gateway gates the call with cache.shouldSend(sessionId, content) and silently drops duplicates.

Adapters do NOT roll their own dedup. A new adapter does not need an idempotency layer. If you find adapter-local dedup logic, it's a bug. A new adapter MUST populate `InboundMessage.botKey` from the token/credentials it was constructed with. Use `deriveBotKey()` from `packages/core/src/bot-key.ts` (re-exported by `@ethosagent/core`, with a config-shaped wrapper in `packages/config/src/index.ts`) to derive a stable default when no explicit `id` is configured.
Configuration: GatewayConfig.outboundDedupTtlMs (default 30_000). Set to 0 to disable, or set the env var ETHOS_DEDUP_LEGACY=1 for the hard-off rollback hatch (one-release escape valve; remove in next minor).
Session boundaries: /new and /personality clear the previous session's dedup keys so the same response text can be sent again under the fresh session key.
See extensions/gateway/src/dedup.ts and the tests in extensions/gateway/src/__tests__/dedup.test.ts.

Dedup stops DOUBLE sends; the delivery ledger (`@ethosagent/delivery-ledger`, wired via `GatewayConfig.deliveryLedger`) stops LOST ones. Five reply paths — non-streaming final, errored/interrupted final, hook-claimed (`gateway_message`) reply, the streaming terminal edit, and a synthesized voice note — write a `pending` obligation BEFORE the platform call and mark it `delivered` only when `DeliveryResult.ok === true`. "Resolved without throwing" is NOT confirmation: every adapter catches platform failures and returns `{ok:false}`, so that definition would mark the exact failures the ledger exists to catch as delivered. `Gateway.sweepPendingDeliveries()` runs after `adapter.start()` in the gateway command and redelivers whatever is still `pending`, filtered to `botKey ∈ this.bots` and claimed atomically so peer processes sharing a ledger file each deliver an obligation exactly once. Redelivery bypasses `shouldSend()` and calls `cache.record()` afterwards. Every obligation carries the `threadId` its reply belonged to (schema v2, nullable), so a redelivery returns to the sub-conversation rather than the root chat — the lane key already treats a thread as a distinct conversation, and on Slack or Telegram-with-topics a root-chat redelivery is the wrong place in front of the wrong audience-of-attention. A row with no thread redelivers with `threadId` undefined, never `''` or `'null'`. Delivery is at-least-once by design, and per-adapter honesty varies — Telegram's chunked send reports `{ok:true}` on a partially delivered multi-chunk message. A voice reply is `kind: 'voice'` (schema v3): `content` holds the spoken text, `artifactRef` names the synthesized audio in the gateway's `VoiceArtifactStore`, and redelivery re-sends THOSE bytes rather than re-synthesizing — a second TTS pass is a different recording. Confirming a voice obligation deletes its artifact; `Gateway.pruneVoiceArtifacts()` abandons undelivered ones past a cutoff and enforces a total-size cap with oldest-first eviction. Slash-command acks and the background-job wake notice are deliberately NOT covered.

In multi-bot deployments, the gateway holds a `Map<botKey, AgentLoop>` — one loop per configured bot. The lane key is `${platform}:${botKey}:${chatId}` (not `${platform}:${chatId}` as in single-bot mode). Every adapter stamps `InboundMessage.botKey` so the gateway can route to the right loop. Adapters that do not support `botKey` (Discord, Email) fall back to the `defaultBotKey` in single-bot deployments; in multi-bot deployments their messages are dropped with an observability event. The per-bot botKey must be stable across restarts — use the optional `id:` field in config, or accept the sha256-derived default.

Storage abstraction
All filesystem reads and writes under ~/.ethos/ go through the Storage interface from @ethosagent/types. New code must NOT import from node:fs/promises (or node:fs) for ~/.ethos/ access — wire a Storage in via the constructor.

Implementation	Where it lives	When to use
FsStorage	@ethosagent/storage-fs	Production wiring (CLI, web-api, gateway)
InMemoryStorage	@ethosagent/storage-fs	Tests — populate fixtures via write(), no tmpdir scaffolding
ScopedStorage	@ethosagent/storage-fs	Decorator — enforces a per-personality read/write path allowlist
Allowed exceptions (these stay raw node:fs):

extensions/session-sqlite/, extensions/memory-vector/ — SQLite via @ethosagent/sqlite opens raw paths and manages WAL/SHM natively
extensions/job-store/ — SQLiteJobStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir (same rationale as session-sqlite/memory-vector)
extensions/delivery-ledger/ — SQLiteDeliveryLedger opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its atomic redelivery claim is a conditional UPDATE inside a transaction, which no Storage interface can express
extensions/session-cards/ — SQLiteCardStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its per-session `seq` derivation is a MAX()+1 read inside the insert's transaction, which no Storage interface can express (same rationale as job-store/delivery-ledger)
apps/ethos/src/error-log.ts — sync crash logger; must flush before process exit
apps/ethos/tsup.config.ts and other build-time tooling
extensions/skills/src/skill-compat.ts statSync — walks $PATH, not ~/.ethos/
extensions/gateway/src/media.ts lstatSync — symlink-refusal on an arbitrary tool-produced outbound-media path (W3.2 exfiltration guard), not ~/.ethos/; Storage follows symlinks
extensions/gateway/src/transcode.ts — ffmpeg transcodes FILES, not buffers, so the stage materializes scratch input/output paths under os.tmpdir() and unlinks them in a finally. Never ~/.ethos/: the synthesized artifact that IS persisted goes through Storage via `VoiceArtifactStore`. Same carve-out extensions/voice-providers/'s command-tts already has, for the same reason
extensions/tools-code/src/shim/js-shim.ts — textual false positive: the `node:fs` import lives inside a String.raw literal (the container-side shim client source delivered at exec time, tools-as-code-api Lane A); the module itself performs no host filesystem access
apps/web-api/src/services/documents.service.ts lstat — symlink-refusal on the operator-supplied Documents path; same rationale as gateway/media.ts. ScopedStorage confines the path, but Storage follows symlinks and has no lstat, so a symlink inside the workdir resolves outside it while passing the prefix test on the link path. Every path segment is lstat'd, not just the leaf, because a symlinked PARENT escapes with a non-symlink leaf
apps/web-api/src/routes/documents.ts createReadStream — the download route streams bytes; Storage.readBytes would buffer a whole artifact into the server heap
packages/core/src/scoped/scoped-fs.ts lstatSync/readlinkSync — symbolic containment for `fs_reach` (gap G11). This IS the boundary check, so it cannot route through the thing it guards: Storage follows symlinks and has no lstat, which is exactly why the previous lexical-only prefix match let a symlink planted inside an allowed prefix resolve outside it. Walks every segment below the matched prefix, not just the leaf, because a symlinked PARENT escapes with a non-symlink leaf. Deliberately synchronous — async would force the whole ScopedFs contract open for no security gain
packages/storage-fs/src/scoped-storage.ts lstatSync/readlinkSync — the same check on the Storage side. Already inside the storage-fs prefix carve-out ("it IS the fs adapter"), but called out here because the two implementations are duplicated on purpose — core cannot import storage-fs at runtime (kernel layer boundary, ARCHITECTURE.md §II) — and they MUST change together. Each file carries a pointer to the other
Error contract: read/exists/mtime return null for missing paths (common case, not exceptional). Everything else throws. ScopedStorage throws BoundaryError (also exported from @ethosagent/types) when a path is outside the allowlist; surfaces translate it into a user-facing tool error.

Atomicity: use writeAtomic for any file where a partial write would corrupt state (config, keys, audit logs). It's a separate method, not an option, to prevent the "did the writer remember?" footgun.

See plan/storage_abstraction.md for the full migration plan (4 phases) and the Storage interface spec.

Adding a new LLM provider
Create extensions/llm-<name>/src/index.ts — implement LLMProvider from @ethosagent/types
Create extensions/llm-<name>/package.json — depend on @ethosagent/types: workspace:*
Add path alias to root tsconfig.json → "@ethosagent/llm-<name>": ["./extensions/llm-<name>/src"]
Wire it in apps/ethos/src/wiring.ts under a new config.provider value
LLMProvider.complete() must return AsyncIterable<CompletionChunk>. Map provider-specific streaming events to the CompletionChunk discriminated union (7 variants in packages/types/src/llm.ts).

Adding a new tool
Tools live in extensions/tools-* packages and register with DefaultToolRegistry at wiring time. To add one:

Implement Tool<TArgs> from @ethosagent/types
execute(args, ctx) must return Promise<ToolResult> — { ok: true, value: string } or { ok: false, error, code }
Set toolset to group the tool (e.g. 'file', 'web', 'terminal')
Set maxResultChars to limit output — executeParallel trims and appends [truncated] if exceeded
Declare isAvailable?() if the tool requires env vars or external services
Wire it in apps/ethos/src/wiring.ts so it's registered on startup
Adding a personality
Drop a directory in ~/.ethos/personalities/<id>/:

<id>/
├── SOUL.md        ← first-person identity (who am I, how do I speak)
├── config.yaml     ← name, description, model, memoryScope
└── toolset.yaml    ← flat list of allowed tool names
config.yaml is simple key: value (no nested YAML). Parsed by parseConfigYaml() in extensions/personalities/src/index.ts.

FilePersonalityRegistry.loadFromDirectory() is mtime-cached — it re-reads a personality only when one of its four fingerprinted files (config.yaml / SOUL.md / toolset.yaml / mcp.yaml) changes on disk; a no-change refresh is ~4 stat() calls per personality dir with no read()/re-parse. Hot-reload is wired at the surfaces that resolve a personality, not inside the loop: the gateway refreshes every loop registry before it dispatches a turn and at the top of the `/personality` handler (via the optional `personalityDirectory` seam on GatewayConfig, assembled in apps/ethos/src/commands/gateway.ts); web-api's PersonalitiesService refreshes before list/get/characterSheet, and the chat/completions services refresh the loop registry before each turn (`refreshPersonalities` from createAgentLoop's return, threaded through createWebApi); the gateway/serve cron registries reload before each firing. A personality dropped into or edited under ~/.ethos/personalities/ is therefore usable on the next turn/command in every process — no restart. The seams are optional: absent (tests, standalone) → no refresh, and `/personality <unknown>` is validated against the just-refreshed registry so an unknown id is refused instead of silently falling back to the default.

Verify what you built with ethos personality show <id> — it prints the generated character sheet (identity, routing, memory scope, toolset, MCP servers, plugins, fs_reach). renderCharacterSheet() in @ethosagent/personalities is the single generator; the Web Personalities tab renders the same artifact via the personalities.characterSheet RPC.

What does NOT belong on PersonalityConfig (Phase 30.8, amended)
The schema is frozen. The line is IDENTITY vs SETTING, not visible vs invisible.

How a personality PRESENTS itself is identity, and is in scope: which voice it speaks in (voice.tts_voice), and how its call is drawn (voice.call_style). A personality is not only its tools and its plugins — it is also how it looks and feels, and a framework whose agents are all interchangeable grey is not showing you a team. These land as SUB-KEYS of the identity blocks that already exist (today: voice), never as new top-level fields, and never as a metadata passthrough.

Still NOT personality concerns — they belong in skills, in display.* / voice.* in ~/.ethos/config.yaml, or in per-channel adapter config:

voice MODES, VAD tuning, endpointing, barge thresholds — tuning, not identity
emotion / mood / sentiment tags
label or response templates
per-channel UI affordances (one personality rendering differently on Slack than on Telegram)
operator and deployment concerns — transport, credentials, provider rosters, endpoints, anything an operator sets once for the machine
untyped metadata passthroughs — a typed contract does not get an escape hatch meaning "anything"
The test: could two deployments of the SAME personality reasonably disagree about it? Then it is a setting and belongs to the operator. Would changing it make this feel like a different agent? Then it is identity.

skin, verbosity and busy-input mode stay removed. This amendment does not re-add them; per-personality display overrides return only as specific, argued keys on an identity block, not as a general licence. Adding a top-level field to PersonalityConfig still requires the personality-schema-change label, two-maintainer approval, and bumping .personality-field-count in the same commit. The mechanical CI gate (packages/types/src/__tests__/personality-field-count.test.ts) fails if the count drifts — a presentation sub-key must not move it. See CONTRIBUTING.md for the full rule, and docs/content/building/explanation/personality-governance.md for why.

Session key convention
CLI sessions use cli:<cwd-basename> as the session key. Different working directories get separate conversation histories. /new in chat appends :${Date.now()} to force a fresh session.

SQLite getMessages(sessionId, { limit }) returns the most-recent limit messages in chronological order (using rowid DESC in the inner query, then reversing). This is intentional — the LLM sees the latest context, not the oldest.

Memory
Memory is a scope-bound key/value store. Every read and write carries an opaque `scopeId`; the provider routes storage accordingly. Conventional scope prefixes:

| Prefix | Set by | Storage root |
|---|---|---|
| `personality:<id>` | Personality wiring | `~/.ethos/` |
| `team:<id>` | Team wiring | `~/.ethos/teams/<id>/memory/` |

**Personality scope** ships two default keys:
- `MEMORY.md` — rolling project context, updated each session.
- `USER.md` — persistent user profile across sessions and personalities.

**Team scope** ships an arbitrary topic set — one markdown file per topic (e.g. `architecture.md`, `decisions.md`, `onboarding.md`).

The canonical contract is `MemoryProvider` in `@ethosagent/types`. See ARCHITECTURE.md §VII for the frozen-schema roster.

`MemoryProvider.sync()` applies `MemoryUpdate[]`:

- `action: 'add'` → appends to the end of the key's content.
- `action: 'replace'` → overwrites the entire key.
- `action: 'remove'` with `substringMatch` → removes lines containing the substring.
- `action: 'delete'` → removes the key entirely (team scope).

`prefetch()` returns `null` if all keys are empty or absent — the system prompt is built without a memory section.

Memory tool reference
Six tools ship in `@ethosagent/tools-memory`. They are registered at wiring time and gated by personality toolset.

**Personality memory** (toolset: `memory`)

| Tool | Required params | Optional params | Behaviour |
|---|---|---|---|
| `memory_read` | — | `store: 'memory' \| 'user' \| 'both'` (default: `'both'`) | Reads `MEMORY.md`, `USER.md`, or both via `prefetch()`. Returns formatted content or an empty notice. |
| `memory_write` | `store: 'memory' \| 'user'`, `action: 'add' \| 'replace' \| 'remove'`, `content` | `substring_match` | Writes to `MEMORY.md` (`store='memory'`) or `USER.md` (`store='user'`). For `action='remove'`, uses `substring_match` if supplied, otherwise uses `content` as the match string. |
| `session_search` | `query` | `limit` (default 10, max 50) | Full-text search over session history. Returns timestamped snippets. |

**Team memory** (toolset: `team_memory`, requires `ctx.teamId`)

On first team boot, wiring auto-seeds two empty bootstrap topics — `onboarding.md` and `decisions.md` — so the team memory directory is never empty when an agent first looks at it (see `seedTeamMemory` in `packages/wiring/src/index.ts`). At session start, a lazy index injector (`createTeamMemoryIndexInjector`, same file) injects just the topic names (not content) into the system prompt; agents load each topic on demand via `team_memory_read`.

| Tool | Required params | Optional params | Behaviour |
|---|---|---|---|
| `team_memory_read` | `key` | — | Reads one topic file (`key` + `.md` suffix appended automatically). Keys must be alphanumeric, hyphens, underscores. |
| `team_memory_write` | `action: 'add' \| 'replace' \| 'remove' \| 'delete'`, `key` | `content`, `substring_match` | Writes to a team topic file. `add`/`replace` require `content`; `remove` strictly requires `substring_match` (returns `input_invalid` if absent — unlike personality `memory_write`, which falls back to `content`); `delete` removes the file entirely. |
| `team_memory_search` | `query` | `limit` (default 5, max 20), `mode: 'keyword' \| 'semantic' \| 'hybrid'` | Keyword search over team memory topics. Returns matching topic files. |

Adding a new memory backend
Mirrors the "Adding a new LLM provider" pattern.

1. Create `extensions/memory-<name>/src/index.ts` — implement `MemoryProvider` from `@ethosagent/types`. The five methods are `prefetch`, `read`, `search`, `sync`, `list` — no more, no fewer.
2. Create `extensions/memory-<name>/package.json` — depend on `@ethosagent/types: workspace:*`.
3. Add path alias to root `tsconfig.json`: `"@ethosagent/memory-<name>": ["./extensions/memory-<name>/src"]`.
4. Wire it in `packages/wiring/src/index.ts` under a new `config.memory` value (current values: `'markdown'`, `'vector'`).
5. The drift gate test (`packages/types/src/__tests__/memory-method-count.test.ts`) asserts exactly five methods. It fails if you add a sixth without bumping the manifest in the same commit — that's intentional schema discipline.

Tool result budget
AgentLoop sets resultBudgetChars: 80_000 by default. ToolRegistry.executeParallel() splits this evenly across concurrent tool calls. Each result is post-trimmed with a [truncated — N chars total] marker if it exceeds the per-call budget.

Tools can declare a lower maxResultChars (e.g. read_file with pagination). The actual budget per call is Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget).

Key conventions
No console.log in library code — only in CLI (apps/ethos/src/). Some console.warn/error lingers in extensions/cron, extensions/plugin-loader, and extensions/tools-mcp; do not add new ones.
All imports are extensionless — import './foo' not import './foo.ts' or import './foo.js'. This is the one hard rule; tsx handles it.
Workspace package.json exports point to ./src/index.ts — so Node 24 can run them directly in dev without a build step.
biome check --write . auto-fixes import order, formatting, and safe lint issues. Run it before committing.
STRICT SQLite tables — both sessions and messages use STRICT mode. All column types must match exactly.
@ethosagent/sqlite (node:sqlite shim) is synchronous — all SessionStore methods wrap it in async but never actually await I/O. Keep query logic tight; no async operations inside the synchronous db.prepare().run() calls.
Personality toolset is enforced — DefaultToolRegistry.toDefinitions(allowedTools) filters what the LLM sees, and executeParallel rejects calls outside the allowlist (tool-registry.ts:57). AgentLoop reads personality.toolset and passes it through (agent-loop.ts:140,265,396). Disallowed tools get a tool_result with is_error: true to keep the Anthropic message contract intact.
Running the project
make prepare        # pnpm install
pnpm dev            # start chat (tsx apps/ethos/src/index.ts)
pnpm check          # typecheck + lint + test
pnpm test           # vitest run
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check .
pnpm lint:fix       # biome check --write .
First time: pnpm dev auto-runs setup if ~/.ethos/config.yaml is missing.

Learnings from building this codebase
Concrete gotchas and non-obvious decisions that emerged during development. Read this before making changes in any of these areas.

SQLite + FTS5: rowid is a pseudo-column
SELECT * does not include rowid. The FTS5 external content table uses triggers that reference new.rowid — this works because rowid is SQLite's implicit integer row ID, distinct from any TEXT PRIMARY KEY you declare. When you need rowid in a subquery result (e.g. for tie-breaking), you must explicitly select it: SELECT *, rowid AS _row FROM messages. The outer query can then ORDER BY _row.

The symptom when you forget: SqliteError: no such column: rowid on the outer ORDER BY.

SQLite: same-timestamp inserts need rowid tie-breaking
getMessages(sessionId, { limit }) returns the most-recent N messages in chronological order. The inner query sorts DESC to pick the tail, the outer reverses to ASC. When multiple messages share the same timestamp (common in tests and fast insert loops), the DESC order is non-deterministic without a secondary key. Always use ORDER BY timestamp DESC, rowid DESC in the inner query and ORDER BY timestamp ASC, rowid ASC in the outer.

STRICT tables in SQLite
Both sessions and messages use STRICT mode. This means column type enforcement is real — inserting a TEXT into an INTEGER column throws immediately instead of silently coercing. Keep all values properly typed when calling .run().

AgentLoop: before_tool_call hook must prevent execution, not just emit events
The hook fires before executeParallel. If you only emit tool_end ok:false but still add the tool to execInputs, the tool runs anyway. The correct pattern: check beforeResult.error → add to a rejected list → exclude from execInputs. Then persist an error tool_result for rejected tools so the LLM history stays consistent (Anthropic requires a tool_result block for every tool_use block in the preceding assistant message).

Anthropic API: every tool_use needs a matching tool_result
When the assistant message contains tool_use content blocks, the following user message must contain tool_result blocks for every one — including rejected or blocked tools. If a hook blocks a tool call, still persist a tool_result with is_error: true and the rejection reason. Missing tool_result blocks cause Anthropic API validation errors.

getMessages returns newest N, not oldest N
The SessionStore.getMessages(sessionId, { limit }) contract returns the most-recent limit messages in chronological order. This is the tail of the history, not the head. The in-memory and SQLite implementations both use a DESC-then-reverse pattern. If you see the agent losing recent context on long conversations, this is the first thing to check.

Anthropic SDK: cache tokens are in message_start, not message_delta
event.message.usage in the message_start event contains cache_read_input_tokens and cache_creation_input_tokens (when prompt caching is active). These fields are not in the SDK's Usage type — cast to access them: event.message.usage as Anthropic.Usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }.

Anthropic SDK: extended thinking needs any cast for params
The thinking and betas fields for extended thinking are not in the SDK's MessageStreamParams type yet. The // biome-ignore lint/suspicious/noExplicitAny pattern is intentional here — don't try to type it more narrowly.

OpenAI tool call streaming: index-keyed, not ID-keyed
OpenAI streams tool calls as deltas on choices[0].delta.tool_calls[index]. The first delta for a given index has the id and name; subsequent deltas only have arguments. Build a Map<number, { id, name, args }> keyed by index. Don't try to key by id — it arrives late and is sometimes empty on early deltas.

SQLite — @ethosagent/sqlite wraps node:sqlite
@ethosagent/sqlite wraps Node 24's built-in node:sqlite (DatabaseSync) with a synchronous API. No native dependencies — no prebuild downloads, no C++ compilation needed. Import: `import Database from '@ethosagent/sqlite'`.

openai package has a zod v3 peer dep — intentionally ignored
openai@4.87+ lists zod@^3 as a peer dependency. Ethos uses zod@4. The zod dep is only used by openai for its structured outputs / .parse() features, which we don't use. It's suppressed via peerDependencyRules.ignoreMissing: ["zod"] in pnpm-workspace.yaml. Don't remove this or pnpm will emit peer conflict warnings on every install.

Workspace package.json exports point to source
All workspace package exports use "import": "./src/index.ts" (not ./dist/index.js). This lets Node 24 + tsx resolve them directly without a build step. The "production" condition points to ./dist/index.js for when you actually build. If you add a new workspace package, follow this pattern.

Biome v2: files.includes uses trailing slash for folder negation
"!dist/" (with trailing slash) ignores the dist directory. "!**/dist/**" also works but "!dist" (no slash) does not — Biome v2 changed this. The pattern is already correct in biome.json; don't "fix" it.

import.meta.dirname for locating built-in data files
extensions/personalities/src/index.ts uses join(import.meta.dirname, '..', 'data') to find the built-in personality data directory. import.meta.dirname is available in Node 21.2+ (and therefore Node 24). Don't replace with fileURLToPath(new URL(..., import.meta.url)) — that's the Node 18/20 workaround and adds noise.

tsx + extensionless imports: why we don't use --experimental-strip-types
Node 24's --experimental-strip-types requires explicit file extensions in imports (.js or .ts). This conflicts with TypeScript's extensionless import convention. tsx handles extensionless imports and tsconfig path aliases correctly. The decision to keep tsx was made explicitly — don't try to migrate to --experimental-strip-types without also adding extensions to every internal import.

Prompt ordering is static-first, dynamic-tail — keep it that way
The system prompt is assembled STATIC-FIRST (injection-defense prelude → SOUL.md → priority-sorted injectors) with DYNAMIC sections at the TAIL (memory snapshot, progressive file-context, team topic index) — see `packages/core/src/agent-loop/stages/context-assembly.ts`. NO per-turn-varying text (dates, timestamps, turn counters) appears anywhere in the prompt. This is what keeps the static prefix byte-identical across turns so prefix caching works — Anthropic cache breakpoints, vLLM `--enable-prefix-caching`, and Ollama keep-alive all reuse the unchanged prefix. Any new injector MUST emit content that depends only on static inputs (personality, platform), or render per-turn/dynamic content as an `append` so it lands in the tail. Don't put a date/clock/counter in an injector. The regression guard is `packages/core/src/__tests__/prompt-prefix-stability.test.ts` — it drives two consecutive turns with unchanged memory and asserts a byte-identical static prefix; if you break the ordering it fails.

Local-serving note: to exploit the stable prefix, run vLLM with `--enable-prefix-caching` and rely on Ollama's keep-alive so the loaded prefix survives between turns.

noNonNullAssertion is enforced by Biome
array[n]! and map.get(key)! are blocked. Preferred patterns:

array[n] ?? fallback — safe default
const val = map.get(key); if (val) { ... } — explicit guard
Extract into a const before using in a filter: const match = update.substringMatch; if (!match) break;

API response type safety
Never cast API response types with `as`. The oRPC typed client infers return types — use those. For SSE events, parse with the Zod schema from `@ethosagent/web-contracts`. For external JSON (localStorage, URL params), use Zod `.safeParse()` with a fallback rather than `as`.

Design system
Always read DESIGN.md before making any visual or UI decision. All font choices, colors, spacing, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval.

The web UI (in development) references DESIGN.md tokens via Antd ConfigProvider. Other surfaces (TUI, VS Code extension, email digests, CLI) consume the same tokens — see DESIGN.md "Cross-surface token mapping" for the per-surface render rules.

When reviewing or writing code that touches UI, flag any deviations from DESIGN.md (slop blacklist, font choices, color hex values, motion durations, "cards earn existence" rule).

Docs system
Documentation work (Docusaurus pages, READMEs, llms.txt, SOUL.md files) is governed by the `/docs` skill at [.agents/skills/docs/SKILL.md](.agents/skills/docs/SKILL.md). The skill auto-suggests for any doc work and defines page kinds, the front-matter contract, voice rules, anti-patterns, and the page-acceptance checklist. Invoke it before touching any doc.

gstack
Available skills: /review, /plan-eng-review, /plan-ceo-review, /plan-design-review, /design-consultation, /browse, /investigate, /careful, /ship, /qa, /retro.
