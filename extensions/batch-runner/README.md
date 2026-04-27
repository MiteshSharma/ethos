# @ethosagent/batch-runner

Run an `AgentLoop` against many tasks in parallel with bounded concurrency, atomic checkpointing, and JSONL output in the Atropos schema.

## Why this exists

The interactive REPL handles one prompt at a time. Evals, dataset generation, and offline experiments need to push thousands of prompts through the same `AgentLoop` without losing progress on a crash. This package is the smallest piece that does that: a semaphore-bounded fan-out, a serialized JSONL writer, and a checkpoint file rewritten after every task so a SIGTERM mid-run resumes cleanly. `eval-harness` and `ethos batch` both build on it.

## What it provides

- `BatchRunner` — drives an `AgentLoop` over a `BatchTask[]`, returns `BatchStats`.
- `parseTasksJsonl(src)` — strict line-by-line parser; requires `id` + `prompt`, optional `personalityId`.
- `readCheckpoint` / `writeCheckpoint` — atomic JSON checkpoint helpers.
- `AtroposRecord`, `AtroposUsage`, `BatchTask`, `BatchRunOptions`, `BatchStats`, `CheckpointState` — typed contracts.
- `ATROPOS_SCHEMA_VERSION` — current value `'1.0'`; consumers must reject unknown versions.

## How it works

`BatchRunner.run()` reads the checkpoint, filters out task ids already in `completedTaskIds` or `failedTaskIds`, and fans out the remainder under a `Semaphore(concurrency)` (`src/runner.ts:44`). Each task gets its own session key `batch:<id>` so histories don't leak across the cohort.

For every task `BatchRunner.runTask()` writes a `user` Atropos record, drains `loop.run()` collecting `text_delta`, `tool_start`, `tool_end`, and `usage` events, then writes one `assistant` record (with `tool_calls` if any) and optionally a `tool` record with the parallel results (`src/runner.ts:78`). Errors are caught and persisted as an `assistant` record with an `error` field — failed tasks land in the `failedTaskIds` list rather than crashing the run.

`AtroposWriter` chains every `appendFile` through a single `Promise<void>` so concurrent tasks can't interleave bytes mid-line (`src/atropos-writer.ts:6`). On a fresh run (no checkpoint records) it truncates the output file to avoid stale records bleeding through.

`writeCheckpoint` writes to `<path>.tmp` then renames over the destination (`src/checkpoint.ts:15`). A SIGTERM during the write leaves either the previous checkpoint or the new one intact — never a half-written JSON. The runner installs a `SIGTERM` handler that flips a `stopping` flag so in-flight tasks finish but no new ones start (`src/runner.ts:38`).

## Usage

CLI:

```
ethos batch tasks.jsonl --concurrency 5 --output out.jsonl --checkpoint cp.json
```

Defaults derive `<input>.output.jsonl` and `<input>.checkpoint.json` from the input path. See `apps/ethos/src/commands/batch.ts`.

Programmatic:

```ts
import { BatchRunner, parseTasksJsonl } from '@ethosagent/batch-runner';

const tasks = parseTasksJsonl(await readFile('tasks.jsonl', 'utf-8'));
const runner = new BatchRunner(loop, {
  concurrency: 3,
  outputPath: 'out.jsonl',
  checkpointPath: 'cp.json',
  defaultPersonalityId: 'researcher',
});
const stats = await runner.run(tasks, (done, total) => process.stdout.write(`\r${done}/${total}`));
```

## Gotchas

- Resuming a run never re-truncates the output — appending continues. If you change the task set between runs, delete the checkpoint first.
- `failedTaskIds` are not retried on resume. Remove them from the checkpoint to retry.
- The Atropos `turn` field is currently always `0` (single-turn batch). Multi-turn support would require numbering and is not implemented.
- `Semaphore` enforces in-flight cap, not arrival order — task completion order is non-deterministic.
- `tool_progress` events are intentionally not recorded; they are presentational.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Barrel export. |
| `src/types.ts` | `AtroposRecord`, `BatchTask`, `CheckpointState`, schema version. |
| `src/runner.ts` | `BatchRunner`, `parseTasksJsonl`. |
| `src/semaphore.ts` | Tiny FIFO semaphore for concurrency cap. |
| `src/checkpoint.ts` | Atomic tmp-then-rename JSON checkpoint. |
| `src/atropos-writer.ts` | Promise-chained JSONL appender. |
