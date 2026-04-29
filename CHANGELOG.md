# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Personality isolation — Phase 1.1 + 2.1 (MCP + plugin gating).**
  Personalities now declare default-deny access lists for MCP servers and plugins
  via two new `PersonalityConfig` fields (`mcp_servers`, `plugins`). Without an
  explicit allowlist, a personality has no access to any MCP tool or plugin hook,
  tool, or injector — closing the cross-personality plugin leak gap.
  ([personality_isolation.md](./plan/personality_isolation.md))

  Key changes:

  - **`PersonalityConfig`** (Phase 1.1 / 2.1) — two new optional fields:
    `mcp_servers?: string[]` and `plugins?: string[]`. Both are default-deny:
    absent or empty means no access. `.personality-field-count` bumped 14→16.

  - **`ToolRegistry.toDefinitions` / `executeParallel`** — new `filterOpts:
    ToolFilterOpts` parameter adds a second gating layer beyond the name-based
    `allowedTools` list. `allowedMcpServers` blocks `mcp__<server>__*` tools
    whose server isn't listed; `allowedPlugins` blocks tools registered by
    unlisted plugins.

  - **`HookRegistry.fireVoid` / `fireModifying` / `fireClaiming`** — new
    `allowedPlugins?: string[]` parameter. Built-in handlers (no `pluginId`)
    always fire. Plugin handlers only fire when their plugin id appears in the
    list. `undefined` = no filter (gateway hooks that predate personality context).

  - **`PluginApiImpl`** — `registerInjector()` now records injector→pluginId
    provenance in a shared `injectorPluginIds: Map<ContextInjector, string>` so
    `AgentLoop` can gate context injectors per personality.

  - **`AgentLoop`** — builds `allowedPlugins` and `allowedMcpServers` once per
    turn from the active personality, then threads them through all 7 hook
    fire sites, both tool registry calls, and the injector iteration loop.

  - **Test coverage** — 27-path commitment fulfilled: tool registry (5 paths +
    executeParallel gating), hook registry (8 paths × 3 fire types + REGRESSION
    fail-open), PluginApiImpl injectorPluginIds tracking (2 paths), AgentLoop
    integration (1 path: hook fires for personality A, not B).

  - **Documentation** — `docs/content/personality/create-your-own.md` updated
    with `mcp_servers` and `plugins` field descriptions.

- **Personality isolation — Phases 1.2 + 2.2 + 3.3 + 4 (CLI surfaces + session continuity).**

  CLI surfaces:
  - `ethos personality mcp <id>` lists all configured MCP servers with attachment
    status (✓ = attached). `--attach <name>` / `--detach <name>` update
    `mcp_servers` in `config.yaml` and confirm via registry.update().
  - `ethos personality plugins <id>` shows the global plugin pool with per-plugin
    attachment status. `--attach <plugin-id>` / `--detach <plugin-id>` shortcuts.
  - `ethos plugins` (new top-level command) renders a full plugin × personality
    matrix table. Warns when ≥1 plugin is installed but not attached anywhere.
  - `ethos cron list --personality <id>` filters the job list by personality.
  - `ethos cron show <id>` (new subcommand) displays full job detail including
    which personality runs it.

  `extensions/personalities/src/index.ts`:
  - `loadPersonalityFromDir` parses `mcp_servers` and `plugins` from
    `config.yaml` as space-separated lists.
  - `renderConfigYaml` serialises both fields back to `config.yaml`.
  - `update()` merges `mcp_servers` and `plugins` in the patch apply path.

  Session continuity (Phase 4):
  - Two tests in `apps/ethos/src/__tests__/session-continuity.test.ts` lock
    Decision D1: switching `personalityId` on the same `sessionKey` reuses the
    same session — no fork, no new session row.
  - `docs/content/personality/what-is-a-personality.md` — new
    "The conversation thread stays continuous" section and isolation rules table.

- **Personality isolation — Phases 1.3 + 2.3 + 3.4 (Web UI surfaces).**

  Schema:
  - `PersonalitySchema` (web-contracts) gains `mcp_servers` and `plugins`
    (nullable arrays — null means not configured).
  - `PersonalityUpdateInput` accepts `mcp_servers` and `plugins` patches.
  - `personalities.service.ts` `toWire()` exposes both fields.

  Per-personality detail modal (new tabs in `apps/web/src/pages/Personalities.tsx`):
  - **MCP tab** — Checkbox list of all configured MCP servers; toggling a
    checkbox and clicking Save calls `personalities.update({ mcp_servers })`.
  - **Plugins tab** — Switch per installed plugin (optimistic toggle +
    auto-rollback on error). Alert when zero plugins are attached.

  Global Plugins page (`apps/web/src/pages/Plugins.tsx`) revamped:
  - **Matrix tab** — Antd Table, rows = plugins, cols = personalities. Each
    cell is an Antd Checkbox (optimistic, auto-rollback). "Installed but not
    attached" Alert (`--warning` / `#F59E0B`) when ≥1 plugin has zero
    attachments. Below 900px: pivots to per-plugin Collapse accordion.
  - **MCP Servers tab** — gains "Attached to" column showing which
    personalities have each server in their `mcp_servers` allowlist.

  Cron page (`apps/web/src/pages/Cron.tsx`):
  - Personality filter Select in the toolbar. Client-side filter; clears
    back to "All personalities" via `allowClear`.

- **Personality isolation — Risk #2 + Risk #3 (MCP boot warning + cron-personality drift guard).**

  Risk #2 (MCP boot warning):
  - `packages/wiring/src/index.ts` — after `McpManager.connect()`, compares the
    active personality's `mcp_servers` allowlist against the globally configured
    MCP servers. When configured servers exist but none are attached, emits a
    `log.warn()` hint: `"MCP: 0 of N server(s) attached to "<id>". Run 'ethos
    personality mcp <id> --attach <name>' to enable."` Avoids silent confusion
    where MCP tools are registered but hidden by the personality filter.

  Risk #3 (cron-personality drift guard) — three sites:
  - **Trigger-time** (`apps/ethos/src/commands/cron.ts` `makeScheduler.runJob`):
    if a job's `personality` field is set, lazily loads the personality registry
    (cached across ticks) and throws `EthosError({ code:
    'CRON_PERSONALITY_MISSING' })` when the id is not found. The scheduler logs
    the structured error on its next tick rather than silently using the default.
  - **Create-time** (`apps/ethos/src/commands/cron.ts` `cron create`): if
    `--personality <id>` is passed, validates the id against the registry before
    creating the job. Unknown id prints a red error and exits early — prevents
    bad references from being persisted.
  - **Delete-time** (`extensions/web-api/src/rpc/personalities.ts` delete
    handler): before deleting the personality, lists cron jobs and emits a
    `console.warn` for any that still reference the deleted id. Deletion
    proceeds — dependent jobs will fail gracefully via the trigger-time guard.
  - **`CRON_PERSONALITY_MISSING`** added to `EthosErrorCode` union in
    `packages/types/src/errors.ts`.

- **Personality isolation — Phase 3.2 + 4.3 (cron migration + cross-plan test).**

  Phase 3.2 (cron OpenClaw migration):
  - `ClawMigrator` now detects `cron/jobs.json` in the OpenClaw source directory
    (`detected.cron` field added to `MigrationPlan`).
  - New `'cron-migrate'` CopyKind: reads the source `jobs.json`, backfills
    `personality` on every job that doesn't already declare one using the
    resolved plan personality (the same value written to `config.yaml`), and
    writes the patched array to `~/.ethos/cron/jobs.json`. Jobs that already
    have a personality field are preserved unchanged.
  - 5 tests: detect / no-detect / backfill from config / fallback when config
    has no personality / skip when dest exists / dry-run no-write.

  Phase 4.3 (cross-plan integration test — locks MCP gating contract):
  - Two new tests in `packages/core/src/__tests__/tool-registry.test.ts`:
    1. `toDefinitions` with `allowedMcpServers: []` makes MCP tools invisible —
       a skill that requires `mcp__linear__get_issue` is inert for a personality
       with an empty MCP allowlist. Catches drift between this plan's MCP filter
       and `extension_plan.md`'s skill filter.
    2. `executeParallel` blocks MCP tool calls at execution time even when the
       LLM calls the tool by name — belt-and-suspenders against the same drift.

### Changed

- **Storage abstraction (internal refactor — no user-visible behaviour change).**
  Every read and write under `~/.ethos/` now flows through a single `Storage`
  interface (`@ethosagent/types`). See `plan/storage_abstraction.md` for the
  full migration plan.

  Key changes by phase:

  - **Phase 1** — New `@ethosagent/storage-fs` workspace package ships three
    implementations: `FsStorage` (production), `InMemoryStorage` (tests — no
    tmpdir scaffolding needed), and `ScopedStorage` (path-allowlist decorator).
    60-test conformance suite covers all three.

  - **Phase 2** — Eight root extensions migrated: `personalities`,
    `memory-markdown`, `skills`, `cron`, `plugin-loader`, `tools-mcp`,
    `agent-mesh`, and the tier-2 batch (`claw-migrate`, `skill-evolver`,
    `eval-harness`, `batch-runner`, `memory-vector`). `apps/ethos/src/config.ts`
    now accepts `Storage` as a parameter; `wiring.ts` threads a single
    `FsStorage` instance through the process.

  - **Phase 3** — Eight duplicated repositories under
    `extensions/web-api/src/repositories/` deleted; web-api routes now call
    the canonical extensions directly (`FilePersonalityRegistry`,
    `CronScheduler`, `MarkdownFileMemoryProvider`, `SkillsLibrary`, `AgentMesh`,
    `scanInstalledPlugins`). Three web-only repositories survive
    (`web-token`, `allowlist`, `sessions`); three more survive with `Storage`
    injection (`config`, `evolver`, `platforms`).

  - **Phase 4** — Per-personality filesystem boundary enforced. New
    `PersonalityConfig.fs_reach` field declares read/write path allowlists
    (supports `${ETHOS_HOME}`, `${self}`, `${CWD}` substitutions). `AgentLoop`
    wraps the base `Storage` in `ScopedStorage` on every turn; `tools-file`
    routes all reads and writes through `ctx.storage`; a `BoundaryError` from
    `ScopedStorage` surfaces as a tool error rather than an unhandled rejection.
    Closes the `personality_isolation.md` Tier 1 #1 integrity gap — a
    personality with `read_file` can no longer read another personality's
    `MEMORY.md`. ([personality_isolation.md](./plan/personality_isolation.md))

  - **CI gate** — New test `apps/ethos/src/__tests__/no-raw-fs.test.ts`
    enforces that library code (`packages/`, `extensions/`) does not import
    `node:fs` or `node:fs/promises` outside the documented allowlist. Prevents
    regression to the pre-abstraction state.

  Allowed exceptions (permanent, documented in the CI test):
  - `packages/storage-fs/` — the `FsStorage` implementation itself
  - `extensions/session-sqlite/`, `extensions/memory-vector/` — SQLite via
    `better-sqlite3` (WAL/FTS5/ACID semantics require raw paths)
  - `extensions/cron/src/index.ts` — exclusive-create file lock (`wx` flag)
  - `extensions/claw-migrate/src/index.ts` — byte-for-byte binary `copyFile`
  - `extensions/web-api/src/routes/static.ts` — web static-file serving (not
    a `~/.ethos/` operation)
  - `extensions/skills/src/skill-compat.ts` — `statSync` for `$PATH` binary
    detection (not a `~/.ethos/` operation)
