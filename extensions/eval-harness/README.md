# @ethosagent/eval-harness

Score an `AgentLoop` against a labeled dataset using one of four scorers (exact, contains, regex, llm-judge), emitting Atropos records compatible with the batch-runner pipeline.

## Why this exists

Once a personality is wired up, the only honest question is "does it actually answer correctly". This package pairs prompts with expected outputs, runs them through the same `AgentLoop` the CLI uses, applies a scorer, and writes results to JSONL. Downstream `skill-evolver` reads that output to decide what to rewrite. Without this layer, evaluating a personality means eyeballing chat logs.

## What it provides

- `EvalRunner` — concurrent eval driver, returns `{ total, passed, failed, avgScore }`.
- `parseExpectedJsonl(src)` — parses `{ id, expected, match? }` records into a `Map<string, EvalExpected>`.
- `exactMatchScorer` — trimmed string equality.
- `containsScorer` — case-insensitive substring (default).
- `regexScorer` — case-insensitive `RegExp` test against the expected pattern; invalid regex scores 0.
- `llmJudgeScorer(llm)` — asks an `LLMProvider` to reply `1` or `0`; requires `llmProvider` in options.
- `EvalExpected`, `EvalRunOptions`, `EvalStats`, `Scorer` — typed contracts.

## How it works

`EvalRunner.run()` truncates the output file, fans tasks out under a local `Semaphore(concurrency)`, and accumulates `passed` / `failed` / `scoreSum` as each task finishes (`src/runner.ts:61`). Sessions are keyed `eval:<id>` so eval runs never cross-pollinate with chat or batch sessions.

`runTask()` drains `loop.run()` and only collects three event types it cares about: `text_delta` (the response under test), `usage` (token cost), and `context_meta` whose `data.skillFilesUsed` is captured into the `skill_files_used` field on the Atropos record (`src/runner.ts:114`). That last field is what `skill-evolver` later joins against to attribute pass/fail to specific skill files.

Scorer selection is per-task. If the expected record sets `match`, that wins; otherwise `defaultScorer` from options applies (`src/runner.ts:97`). The `llm` scorer constructs a single `Message` asking the judge LLM to reply `1` or `0` against criteria, with `maxTokens: 5, temperature: 0` to keep judging cheap and deterministic (`src/scorers.ts:22`).

The output JSONL embeds a `score` (0 or 1), the `scorer` name used, and `skill_files_used` on every assistant record. Errors during the run are caught and surfaced as `error` on the assistant record with `score: 0`.

## Usage

CLI:

```
ethos eval run tasks.jsonl --expected expected.jsonl --scorer llm --concurrency 5
```

Add `--evolve` to chain into `skill-evolver` after scoring; `--auto-approve` promotes pending skills without review. See `apps/ethos/src/commands/eval.ts`.

`expected.jsonl` format:

```json
{"id": "q1", "expected": "Paris", "match": "contains"}
{"id": "q2", "expected": "^[0-9]{4}$", "match": "regex"}
{"id": "q3", "expected": "Reply explains entropy clearly", "match": "llm"}
```

Programmatic:

```ts
import { EvalRunner, parseExpectedJsonl } from '@ethosagent/eval-harness';

const runner = new EvalRunner(loop, {
  concurrency: 3,
  outputPath: 'out.eval.jsonl',
  defaultScorer: 'contains',
  llmProvider, // required only if any task uses 'llm'
});
const stats = await runner.run(tasks, parseExpectedJsonl(src));
```

## Gotchas

- Unlike `batch-runner`, there is no checkpoint — every run re-truncates the output and re-runs every task.
- The `llm` scorer judges yes/no by checking if the response starts with `1`. A judge that rambles before answering scores 0.
- Tasks without an entry in `expectedMap` get `score: 0` silently — they are not flagged.
- Score is binary in v1 (0 or 1). `avgScore` is therefore the pass rate. Partial credit is not modeled.
- The `Writer` and `Semaphore` here are local copies, not imported from `batch-runner`. Don't refactor them away — keeping eval-harness's pipeline independent is intentional.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Barrel export. |
| `src/types.ts` | `EvalExpected`, `EvalRunOptions`, `EvalStats`. |
| `src/runner.ts` | `EvalRunner`, `parseExpectedJsonl`, local `Writer` + `Semaphore`. |
| `src/scorers.ts` | `exactMatchScorer`, `containsScorer`, `regexScorer`, `llmJudgeScorer`. |
