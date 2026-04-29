# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
