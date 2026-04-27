# @ethosagent/session-sqlite

`SessionStore` implementation backed by `better-sqlite3` in WAL mode, with FTS5 full-text search over message content.

## Why this exists

Ethos sessions persist across CLI restarts so a `pnpm dev` invocation can pick up exactly where the last one left off. `@ethosagent/core` doesn't bundle a store — it accepts any `SessionStore` from `@ethosagent/types` at construction. This package supplies the production implementation: schema migration on connect, fully typed CRUD, usage accumulation, and BM25-ranked search via an FTS5 external-content table that mirrors the `messages` table through triggers.

## What it provides

- `SQLiteSessionStore` — implements `SessionStore`. Constructor takes a single `dbPath`.

## How it works

`migrate()` (`src/index.ts:31`) creates two `STRICT` tables (`sessions`, `messages`) plus a `messages_fts` virtual table with `content='messages'` and `content_rowid='rowid'`. Three triggers (`messages_ai`, `messages_ad`, `messages_au`) keep the FTS index in sync on insert, delete, and content update. `journal_mode = WAL` and `foreign_keys = ON` are set on every connect.

`getMessages(sessionId, { limit })` (`src/index.ts:246`) returns the *most-recent* `limit` messages in chronological order — i.e. the tail, not the head. The inner query selects `*, rowid AS _row` and orders by `timestamp DESC, rowid DESC`; the outer reverses to `timestamp ASC, _row ASC`. Both halves of the tie-break are required: same-timestamp inserts (common in tests and fast loops) would otherwise be non-deterministic. `_row` must be aliased explicitly because `rowid` is a pseudo-column not exposed by `SELECT *`.

`updateUsage()` builds a column-by-column `col = col + ?` UPDATE (`src/index.ts:275`) so concurrent token-cost increments compose correctly. The `colMap` keeps the SQL column names in lockstep with the `SessionUsage` interface.

`search()` (`src/index.ts:303`) wraps the query in double quotes via `escapeFtsQuery` (treating it as a phrase, escaping internal quotes), joins `messages_fts` to `messages` on `rowid`, and orders by raw `bm25(messages_fts)`. BM25 returns negative scores where lower means more relevant, so the public `score` is flipped (`src/index.ts:338`). The snippet helper grabs ±50/150 chars around the first case-insensitive query match in the content.

The CLI session-key convention `cli:<cwd-basename>` is enforced by callers, not this store — `key` is just `UNIQUE TEXT` here.

## Gotchas

- `rowid` is a SQLite pseudo-column and is *not* included by `SELECT *`. Subqueries that need it for outer ordering must alias it explicitly (`rowid AS _row`) or you'll get `SqliteError: no such column: rowid`.
- Always tie-break by `rowid` when sorting by `timestamp` — millisecond-resolution timestamps collide easily.
- Both tables are `STRICT`. Pass numbers as numbers, strings as strings; SQLite will throw rather than coerce.
- `better-sqlite3` is synchronous. Every `async` method here returns immediately after the sync call. Don't introduce real awaits inside `db.prepare().run()` — it'll only add overhead.
- `better-sqlite3` is a native module. It must appear in `pnpm.onlyBuiltDependencies` at the workspace root, otherwise pnpm's install sandbox blocks the build script silently.
- `escapeFtsQuery` quotes the entire input as one phrase. Multi-term `OR`/`NEAR`/`*` operators won't work — that's deliberate to avoid injection.
- `pruneOldSessions` cascades to messages via `ON DELETE CASCADE`. The triggers handle FTS cleanup automatically through `messages_ad`.
- `tool_calls` are stored as JSON-stringified text inside a `STRICT` column — keep that contract when adding fields.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `SQLiteSessionStore`, schema + FTS5 migration, CRUD, search, row mappers, FTS escaping. |
