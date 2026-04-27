# @ethosagent/skill-evolver

Reads eval-harness JSONL output, identifies underperforming or missing skills, and asks an LLM to draft rewrites and new skill files into a `pending/` review queue.

## Why this exists

Skills are markdown files injected into the system prompt by `@ethosagent/skills`. Once you start scoring real task runs through the eval harness (`ethos eval`), you have data on which skills help and which don't — but no automated way to act on it. `skill-evolver` closes that loop: it scores each skill by average task score, surfaces low performers for rewrite, finds high-scoring tasks where *no* skill was active (a sign of a missing skill), and uses an `LLMProvider` to draft replacements.

Drafts always land in `skills/pending/` — never overwriting live skills directly. The user reviews and approves via `ethos evolve --approve <name>` or `--approve-all`.

## What it provides

- `SkillEvolver` class — orchestrates the read-analyze-prompt-write pipeline.
- `analyzeEvalOutput(records, skillsDir, config)` — pure function that turns parsed eval records into an `EvolutionPlan` (rewrite candidates + new-skill candidates + per-skill stats).
- `parseEvalJsonl` — strict JSONL parser; throws on malformed lines or missing `task_id` / `role` / `content`.
- `loadEvolveConfig(path)` — reads JSON config with sane defaults from `DEFAULT_EVOLVE_CONFIG`.
- `renderRewritePrompt`, `renderNewSkillPrompt`, `parseRewriteResponse`, `parseNewSkillResponse` — prompt templating and response parsers (XML-tag-based: `<skill>...</skill>`, `<filename>...</filename>`).

## How it works

`analyzeEvalOutput` (`src/analyze.ts:146`) groups eval records by `task_id`, drops errored or unscored tasks, then computes per-skill statistics by attributing each task's score to every skill listed in its `skill_files_used` array (the same field `SkillsInjector` writes into `ctx.meta`). A skill becomes a *rewrite candidate* when it has at least `minRunsBeforeEvolve` runs (default 10) and an average score below `rewriteThreshold` (default 0.6). A *new skill candidate* exists when at least `minPatternCount` (default 3) tasks scored above `newSkillPatternThreshold` (default 0.8) with no skill active — capped at 20 tasks per bundle to keep the prompt focused.

`SkillEvolver.evolve()` (`src/evolver.ts:31`) walks both candidate lists, rendering one prompt per candidate via `prompts.ts` and calling `llm.complete()` with `maxTokens: 2048, temperature: 0.2`. Responses are parsed with strict regex matchers — `parseRewriteResponse` requires `<skill>...</skill>` (or `NO_REWRITE` to skip), `parseNewSkillResponse` requires both `<filename>...</filename>` and `<skill>...</skill>` (or `NO_PATTERN`). Filenames must match `^[a-z0-9]+(?:-[a-z0-9]+)*\.md$` — anything else is rejected as `invalid-filename`.

`pickAvailableName()` (`src/evolver.ts:85`) prevents collisions by suffixing `-2`, `-3`, ... if the LLM-proposed filename is already used by an existing skill or already queued in `pending/`. After 100 attempts it falls back to a timestamp suffix.

The skill-format guide embedded in both prompts (`src/prompts.ts:21`) tells the LLM that skills should be 80-300 words, imperative ("When asked to X, do Y"), free of meta-commentary, and free of frontmatter — matching what `SkillsInjector` actually expects.

## On-disk layout

```
~/.ethos/skills/                  # live skills loaded by SkillsInjector
  some-skill.md
  another-skill.md
  pending/                        # written here by SkillEvolver, ignored by SkillsInjector
    rewritten-skill.md
    new-pattern-skill.md

<eval-output>.jsonl               # input — one JSON record per row, fields: task_id,
                                  # turn, role, content, score?, skill_files_used?, error?

evolve.config.json (optional)     # { rewriteThreshold, newSkillPatternThreshold,
                                  #   minRunsBeforeEvolve, minPatternCount }
```

## Gotchas

- `parseEvalJsonl` is strict — any malformed line throws with the line number. There is no skip-on-error mode.
- A task is only included in stats if its `assistant` row has a numeric `score` *and* no `error`. Tool rows are recorded but not summarized.
- Skills with `runs < minRunsBeforeEvolve` are never rewritten regardless of how badly they score — this prevents thrashing on noisy data.
- The `pending/` directory is created with `mkdir({ recursive: true })` — but `SkillsInjector` explicitly skips any subdirectory named `pending` (`extensions/skills/src/skills-injector.ts:122`), so drafts never accidentally leak into a live prompt.
- LLM temperature is fixed at 0.2 and `maxTokens` at 2048 — neither is currently configurable. Skills longer than ~2048 output tokens will be truncated mid-`<skill>` and then dropped as `malformed-output`.
- `callLLM` only consumes `text_delta` chunks from `LLMProvider.complete()` — thinking, tool calls, and other chunk types are silently discarded.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Barrel — exports the public API. |
| `src/evolver.ts` | `SkillEvolver` class — read eval, plan, prompt LLM, write to `pending/`. |
| `src/analyze.ts` | `parseEvalJsonl`, `analyzeEvalOutput`, `loadEvolveConfig`, defaults. |
| `src/prompts.ts` | `renderRewritePrompt`, `renderNewSkillPrompt`, response parsers, format guide. |
| `src/types.ts` | `EvolveConfig`, `EvalRecord`, `TaskSummary`, `SkillStats`, `EvolutionPlan`, etc. |
| `src/__tests__/` | Tests for analyze, evolver pipeline, and prompt rendering / parsing. |
