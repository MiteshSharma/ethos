# @ethosagent/memory-vector

`MemoryProvider` backed by a SQLite database of text chunks plus 384-dim sentence embeddings, with cosine-similarity retrieval and an in-process LRU cache.

## Why this exists

The markdown provider works well for small contexts but degrades as `MEMORY.md` grows past a few thousand characters — every turn pays the full token cost. This provider chunks memory at write time, embeds each chunk locally with `Xenova/all-MiniLM-L6-v2`, and at prefetch time returns the top-K chunks most similar to the current query. No external API call required for embeddings; the model runs in-process via `@xenova/transformers`.

## What it provides

- `VectorMemoryProvider` — implements `MemoryProvider`. Also exposes manual management methods (`add`, `showRecent`, `exportAll`, `clear`, `count`, `migrateFromMarkdown`, `close`) that the CLI uses for slash commands.
- `VectorMemoryConfig` — `{ dir?, topK?, embedFn? }`. `embedFn` lets tests skip the model download.
- `ChunkRecord` — public shape of a stored chunk for `showRecent`.

## How it works

A single `STRICT` table `memory_chunks` holds `(id, store, content, embedding BLOB, created_at)` (`src/index.ts:152`). The embedder is a lazy singleton — the model loads on the first `embed()` call and is reused (`src/index.ts:35`).

`chunkText` (`src/index.ts:68`) splits on blank lines, then any paragraph longer than `CHUNK_MAX_CHARS` (500) is sub-split on sentence boundaries with a `CHUNK_MIN_CHARS` (20) floor for the sub-chunks. Short stand-alone paragraphs are kept verbatim — a 12-character user fact is still worth storing.

`prefetch()` (`src/index.ts:168`) checks the LRU first (`Map`, max 50 entries; insertion-order rotation). On miss, if `ctx.query` is provided, it embeds the query, scans every row, computes cosine similarity, sorts, and returns the top `topK`. Without a query it returns the most-recent K rows in chronological order — useful as a fallback context dump. Cosine is computed with pure float arithmetic (`src/index.ts:52`).

`sync()` mirrors the markdown provider's three actions: `add` chunks and inserts, `replace` deletes all rows for the store then inserts, `remove` runs `DELETE ... WHERE store = ? AND content LIKE '%' || ? || '%'`. The cache is fully cleared on every successful sync.

`migrateFromMarkdown()` (`src/index.ts:312`) is a one-shot importer used during user setup. It refuses to run if any chunks already exist, then ingests `MEMORY.md` and `USER.md` from `dir`, renames each consumed file to `*.bak`, and reports how many chunks landed.

Embeddings are stored as raw `Buffer`s of the underlying `Float32Array` bytes. On read, the buffer is wrapped back into a `Float32Array` view at `EMBED_DIM` (384) (`src/index.ts:194`).

## Gotchas

- `better-sqlite3` is native and must be in `pnpm.onlyBuiltDependencies` at the workspace root or pnpm's sandbox will block the install script and the package fails to compile silently.
- Table is `STRICT`. All bind values must match column types exactly — no silent coercion.
- The embedding model (~25MB) downloads on first use and caches in `~/.cache/huggingface`. Provide `embedFn` in tests to avoid it.
- The LRU is keyed on `ctx.query ?? ''`, so when no query is provided every call returns the same cached "most-recent K chunks" entry until `sync()` clears it.
- `migrateFromMarkdown()` renames the source files to `.bak` only if at least one chunk was inserted, and is a no-op when the DB already has any rows.
- `close()` exists for tests. The provider doesn't manage process lifecycle in production — let the DB handle stays open for the run.
- `result.data` from the embedder may be a view into a larger `ArrayBuffer`; copy via `new Float32Array(result.data)` before stashing (`src/index.ts:360`) so persistence isn't accidentally a slice of someone else's buffer.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `VectorMemoryProvider`, chunking, cosine similarity, LRU cache, markdown migration. |
