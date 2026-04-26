# Ethos — AI Agent Codebase Guide

## Behavioral guidelines

These rules apply to every task in this repo.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Remove imports/variables/functions that **your** changes made unused.
- Every changed line should trace directly to the user's request.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- Always run `pnpm check` (typecheck + lint + test) before declaring done.

---

## What this is

Ethos is a TypeScript agent framework where **personality is architecture**. A personality (`ETHOS.md` + `skills/` + `toolset.yaml` + `config.yaml`) is a structural component — not a system prompt string — that shapes tool access, memory filtering, model routing, and communication style simultaneously.

The CLI (`ethos`) gives you an interactive agent that persists sessions across restarts, loads built-in or custom personalities, and streams LLM responses with tool events.

---

## Tech stack

| | |
|---|---|
| Runtime | Node 24, TypeScript 6 strict |
| Dev runner | tsx (handles extensionless imports, no build step in dev) |
| Bundler | tsup (production builds only) |
| Package manager | pnpm workspaces |
| Lint / format | Biome 2 (single quotes, 2-space indent, 100-char line width) |
| Tests | vitest 4 |
| LLM | `@anthropic-ai/sdk`, `openai` |
| SQLite | `better-sqlite3` (WAL + FTS5) |

---

## Monorepo layout

```
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

plan/               Architecture notes, 20-phase roadmap
```

Path aliases in `tsconfig.json` point all `@ethosagent/*` imports to `./src/` source directly — no build step required in dev.

---

## Core design principles

1. **Interface contracts first** — all extension points typed in `@ethosagent/types`. Core never imports concrete implementations.
2. **Injection at construction** — `AgentLoop` receives every component via `AgentLoopConfig`. Nothing reaches for globals.
3. **No runtime deps in `@ethosagent/types`** — zero imports, zero deps. Every package can import from it safely.
4. **Extensionless TypeScript imports** — `import { X } from './foo'` (no `.js`). `tsx` handles resolution in dev; `tsup` bundles for prod.

---

## Key files

| File | What it does |
|---|---|
| `packages/types/src/index.ts` | Barrel — every interface in the system lives here |
| `packages/core/src/agent-loop.ts` | The 13-step `AsyncGenerator<AgentEvent>` turn cycle |
| `packages/core/src/tool-registry.ts` | `executeParallel()` with per-call budget splitting |
| `packages/core/src/hook-registry.ts` | Void / Modifying / Claiming hook execution models |
| `apps/ethos/src/wiring.ts` | Assembles `AgentLoop` from `~/.ethos/config.yaml` |
| `apps/ethos/src/commands/chat.ts` | Readline REPL — streaming output + slash commands |
| `extensions/session-sqlite/src/index.ts` | WAL + FTS5, `rowid` tie-breaking for ordered history |
| `extensions/personalities/src/index.ts` | mtime-cached personality loader, `loadFromDirectory()` |

---

## AgentEvent types

`AgentLoop.run()` is an `AsyncGenerator<AgentEvent>`. Event types:

```typescript
type AgentEvent =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start';     toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress';  toolName: string; message: string; percent?: number }
  | { type: 'tool_end';       toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: 'usage';          inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error';          error: string; code: string }
  | { type: 'done';           text: string; turnCount: number }
```

---

## Hook registry

Three execution models — pick based on what the hook does:

| Model | Method | Semantics |
|---|---|---|
| Void | `fireVoid` | All handlers run in parallel via `Promise.allSettled`. Failures are swallowed (fail-open). Use for side effects: logging, analytics, notifications. |
| Modifying | `fireModifying` | Handlers run sequentially. Results are merged — first non-null value per key wins. Use when handlers need to amend the prompt or override args. |
| Claiming | `fireClaiming` | Handlers run sequentially. Stops at first `{ handled: true }`. Use for routing decisions: which platform handles this message. |

All three return `() => void` cleanup functions from `register*()`.

---

## Adding a new LLM provider

1. Create `extensions/llm-<name>/src/index.ts` — implement `LLMProvider` from `@ethosagent/types`
2. Create `extensions/llm-<name>/package.json` — depend on `@ethosagent/types: workspace:*`
3. Add path alias to root `tsconfig.json` → `"@ethosagent/llm-<name>": ["./extensions/llm-<name>/src"]`
4. Wire it in `apps/ethos/src/wiring.ts` under a new `config.provider` value

`LLMProvider.complete()` must return `AsyncIterable<CompletionChunk>`. Map provider-specific streaming events to the `CompletionChunk` discriminated union (7 variants in `packages/types/src/llm.ts`).

---

## Adding a new tool

Tools aren't registered as a package yet (Phase 6). When Phase 6 lands:

1. Implement `Tool<TArgs>` from `@ethosagent/types`
2. `execute(args, ctx)` must return `Promise<ToolResult>` — `{ ok: true, value: string }` or `{ ok: false, error, code }`
3. Set `toolset` to group the tool (e.g. `'file'`, `'web'`, `'terminal'`)
4. Set `maxResultChars` to limit output — `executeParallel` trims and appends `[truncated]` if exceeded
5. Declare `isAvailable?()` if the tool requires env vars or external services

---

## Adding a personality

Drop a directory in `~/.ethos/personalities/<id>/`:

```
<id>/
├── ETHOS.md        ← first-person identity (who am I, how do I speak)
├── config.yaml     ← name, description, model, memoryScope
└── toolset.yaml    ← flat list of allowed tool names
```

`config.yaml` is simple `key: value` (no nested YAML). Parsed by `parseConfigYaml()` in `extensions/personalities/src/index.ts`.

`FilePersonalityRegistry.loadFromDirectory()` is mtime-cached — it re-reads a personality only when `config.yaml` changes on disk. Call it on every turn for hot-reload; it's cheap when nothing changed.

---

## Session key convention

CLI sessions use `cli:<cwd-basename>` as the session key. Different working directories get separate conversation histories. `/new` in chat appends `:${Date.now()}` to force a fresh session.

SQLite `getMessages(sessionId, { limit })` returns the most-recent `limit` messages in chronological order (using `rowid DESC` in the inner query, then reversing). This is intentional — the LLM sees the latest context, not the oldest.

---

## Memory files

`~/.ethos/MEMORY.md` — rolling project context (updated after each session).  
`~/.ethos/USER.md` — who you are (persistent across sessions and personalities).

`MarkdownFileMemoryProvider.sync()` applies `MemoryUpdate[]`:
- `action: 'add'` → appends to the end of the file
- `action: 'replace'` → overwrites the entire file
- `action: 'remove'` with `substringMatch` → removes lines containing the substring

Prefetch returns null if both files are empty or absent — the system prompt is built without a memory section.

---

## Tool result budget

`AgentLoop` sets `resultBudgetChars: 80_000` by default. `ToolRegistry.executeParallel()` splits this evenly across concurrent tool calls. Each result is post-trimmed with a `[truncated — N chars total]` marker if it exceeds the per-call budget.

Tools can declare a lower `maxResultChars` (e.g. `read_file` with pagination). The actual budget per call is `Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget)`.

---

## Key conventions

- **No `console.log` in library code** — only in CLI (`apps/ethos/src/`). Pino logging planned for Phase 20.
- **All imports are extensionless** — `import './foo'` not `import './foo.ts'` or `import './foo.js'`. This is the one hard rule; tsx handles it.
- **Workspace `package.json` exports point to `./src/index.ts`** — so Node 24 can run them directly in dev without a build step.
- **`biome check --write .`** auto-fixes import order, formatting, and safe lint issues. Run it before committing.
- **`STRICT` SQLite tables** — both `sessions` and `messages` use `STRICT` mode. All column types must match exactly.
- **`better-sqlite3` is synchronous** — all `SessionStore` methods wrap it in `async` but never actually await I/O. Keep query logic tight; no async operations inside the synchronous `db.prepare().run()` calls.
- **Personality toolset is advisory** — `DefaultToolRegistry` doesn't filter by toolset yet. Phase 7 (skills + context injectors) will enforce toolset constraints.

---

## Running the project

```bash
make prepare        # pnpm install
pnpm dev            # start chat (tsx apps/ethos/src/index.ts)
pnpm check          # typecheck + lint + test
pnpm test           # vitest run
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check .
pnpm lint:fix       # biome check --write .
```

First time: `pnpm dev` auto-runs setup if `~/.ethos/config.yaml` is missing.

---

## Learnings from building this codebase

Concrete gotchas and non-obvious decisions that emerged during development. Read this before making changes in any of these areas.

### SQLite + FTS5: `rowid` is a pseudo-column

`SELECT *` does not include `rowid`. The FTS5 external content table uses triggers that reference `new.rowid` — this works because `rowid` is SQLite's implicit integer row ID, distinct from any TEXT PRIMARY KEY you declare. When you need `rowid` in a subquery result (e.g. for tie-breaking), you must explicitly select it: `SELECT *, rowid AS _row FROM messages`. The outer query can then ORDER BY `_row`.

The symptom when you forget: `SqliteError: no such column: rowid` on the outer `ORDER BY`.

### SQLite: same-timestamp inserts need `rowid` tie-breaking

`getMessages(sessionId, { limit })` returns the most-recent N messages in chronological order. The inner query sorts `DESC` to pick the tail, the outer reverses to `ASC`. When multiple messages share the same `timestamp` (common in tests and fast insert loops), the `DESC` order is non-deterministic without a secondary key. Always use `ORDER BY timestamp DESC, rowid DESC` in the inner query and `ORDER BY timestamp ASC, rowid ASC` in the outer.

### `STRICT` tables in SQLite

Both `sessions` and `messages` use `STRICT` mode. This means column type enforcement is real — inserting a `TEXT` into an `INTEGER` column throws immediately instead of silently coercing. Keep all values properly typed when calling `.run()`.

### AgentLoop: `before_tool_call` hook must prevent execution, not just emit events

The hook fires before `executeParallel`. If you only emit `tool_end ok:false` but still add the tool to `execInputs`, the tool runs anyway. The correct pattern: check `beforeResult.error` → add to a `rejected` list → exclude from `execInputs`. Then persist an error `tool_result` for rejected tools so the LLM history stays consistent (Anthropic requires a `tool_result` block for every `tool_use` block in the preceding assistant message).

### Anthropic API: every `tool_use` needs a matching `tool_result`

When the assistant message contains `tool_use` content blocks, the following user message must contain `tool_result` blocks for every one — including rejected or blocked tools. If a hook blocks a tool call, still persist a `tool_result` with `is_error: true` and the rejection reason. Missing tool_result blocks cause Anthropic API validation errors.

### `getMessages` returns newest N, not oldest N

The `SessionStore.getMessages(sessionId, { limit })` contract returns the most-recent `limit` messages in chronological order. This is the tail of the history, not the head. The in-memory and SQLite implementations both use a DESC-then-reverse pattern. If you see the agent losing recent context on long conversations, this is the first thing to check.

### Anthropic SDK: cache tokens are in `message_start`, not `message_delta`

`event.message.usage` in the `message_start` event contains `cache_read_input_tokens` and `cache_creation_input_tokens` (when prompt caching is active). These fields are not in the SDK's `Usage` type — cast to access them: `event.message.usage as Anthropic.Usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }`.

### Anthropic SDK: extended thinking needs `any` cast for params

The `thinking` and `betas` fields for extended thinking are not in the SDK's `MessageStreamParams` type yet. The `// biome-ignore lint/suspicious/noExplicitAny` pattern is intentional here — don't try to type it more narrowly.

### OpenAI tool call streaming: index-keyed, not ID-keyed

OpenAI streams tool calls as deltas on `choices[0].delta.tool_calls[index]`. The first delta for a given `index` has the `id` and `name`; subsequent deltas only have `arguments`. Build a `Map<number, { id, name, args }>` keyed by index. Don't try to key by `id` — it arrives late and is sometimes empty on early deltas.

### `better-sqlite3` needs `pnpm.onlyBuiltDependencies`

`better-sqlite3` is a native module that compiles from source when no prebuild matches. It's listed in `pnpm.onlyBuiltDependencies` in the root `package.json`. Without this, pnpm's security sandbox blocks the install script and the package silently fails to compile. Also add `esbuild` to the same list.

### `openai` package has a zod v3 peer dep — intentionally ignored

`openai@4.87+` lists `zod@^3` as a peer dependency. Ethos uses `zod@4`. The zod dep is only used by `openai` for its structured outputs / `.parse()` features, which we don't use. It's suppressed via `pnpm.peerDependencyRules.ignoreMissing: ["zod"]` in the root `package.json`. Don't remove this or pnpm will emit peer conflict warnings on every install.

### Workspace `package.json` exports point to source

All workspace package exports use `"import": "./src/index.ts"` (not `./dist/index.js`). This lets Node 24 + tsx resolve them directly without a build step. The `"production"` condition points to `./dist/index.js` for when you actually build. If you add a new workspace package, follow this pattern.

### Biome v2: `files.includes` uses trailing slash for folder negation

`"!dist/"` (with trailing slash) ignores the dist directory. `"!**/dist/**"` also works but `"!dist"` (no slash) does not — Biome v2 changed this. The pattern is already correct in `biome.json`; don't "fix" it.

### `import.meta.dirname` for locating built-in data files

`extensions/personalities/src/index.ts` uses `join(import.meta.dirname, '..', 'data')` to find the built-in personality data directory. `import.meta.dirname` is available in Node 21.2+ (and therefore Node 24). Don't replace with `fileURLToPath(new URL(..., import.meta.url))` — that's the Node 18/20 workaround and adds noise.

### tsx + extensionless imports: why we don't use `--experimental-strip-types`

Node 24's `--experimental-strip-types` requires explicit file extensions in imports (`.js` or `.ts`). This conflicts with TypeScript's extensionless import convention. `tsx` handles extensionless imports and tsconfig path aliases correctly. The decision to keep `tsx` was made explicitly — don't try to migrate to `--experimental-strip-types` without also adding extensions to every internal import.

### `noNonNullAssertion` is enforced by Biome

`array[n]!` and `map.get(key)!` are blocked. Preferred patterns:
- `array[n] ?? fallback` — safe default
- `const val = map.get(key); if (val) { ... }` — explicit guard
- Extract into a `const` before using in a filter: `const match = update.substringMatch; if (!match) break;`

---

## Design system

Always read [DESIGN.md](./DESIGN.md) before making any visual or UI decision.
All font choices, colors, spacing, motion, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

Phase 26 web UI references DESIGN.md tokens via Antd `ConfigProvider` (see `apps/web/src/lib/theme.ts` once 26.1 lands). Other surfaces (TUI, VS Code extension, email digests, CLI) consume the same tokens — see DESIGN.md "Cross-surface token mapping" for the per-surface render rules.

When reviewing or writing code that touches UI, flag any deviations from DESIGN.md (slop blacklist, font choices, color hex values, motion durations, "cards earn existence" rule).

---

## gstack

Available skills: `/review`, `/plan-eng-review`, `/plan-ceo-review`, `/plan-design-review`, `/design-consultation`, `/browse`, `/investigate`, `/careful`, `/ship`, `/qa`, `/retro`.
