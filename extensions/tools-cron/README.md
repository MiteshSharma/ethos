# @ethosagent/tools-cron

Six LLM-callable tools that let an agent create, list, pause, resume, delete, and immediately run scheduled jobs managed by `@ethosagent/cron`.

## Why this exists

The `@ethosagent/cron` package is the scheduler service — it owns `jobs.json` and the 60-second tick. This package is the thin tool surface the LLM sees. Splitting them keeps the scheduler usable from non-LLM contexts (CLI, daemons, tests) while still giving personalities a way to schedule work via natural language.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `create_cron_job` | `cron` | Schedule a recurring prompt with a 5-field cron expression, optional personality, delivery target, and missed-run policy. |
| `list_cron_jobs` | `cron` | List every job with status, schedule, next/last run, and missed-run policy. |
| `delete_cron_job` | `cron` | Permanently remove a job by id. |
| `pause_cron_job` | `cron` | Mark a job paused without deleting it. |
| `resume_cron_job` | `cron` | Reactivate a paused job and recompute its next run time. |
| `run_cron_job_now` | `cron` | Fire a job immediately, outside its normal schedule, and return the output. |

## How it works

`createCronTools(scheduler)` (`src/index.ts:8`) returns the six `Tool` objects, each closing over the same `CronScheduler` instance. The scheduler is constructed in `apps/ethos/src/wiring.ts` and shared with the cron service so tool-driven mutations and tick-driven runs operate on the same `jobs.json`.

`create_cron_job` validates the cron expression with `isValidCronExpression` from `@ethosagent/cron` before calling `scheduler.createJob` (`src/index.ts:73-89`), then formats the next run time with `Date.toLocaleString()` for the model to echo back. `run_cron_job_now` caps output at 10 KB via `maxResultChars` (`src/index.ts:226`); other tools return short status strings.

`list_cron_jobs` formats each job through `formatJob` (`src/index.ts:251`) — a multi-line markdown block keyed off the same fields the scheduler persists in `jobs.json`.

## Gotchas

- Tools assume the caller's `CronScheduler` is already started; this package never calls `scheduler.start()`.
- Job ids are derived from `name` via `slugify` inside `@ethosagent/cron` — two jobs with names that slugify to the same id will conflict on create.
- `pause_cron_job` / `resume_cron_job` swallow errors as `String(err)` rather than the `err.message` extraction used by `create_cron_job`; expect `"Error: …"` prefixes in those error strings.
- All schedules are interpreted in the host's local time (the description text says so) — there is no `timezone` option.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Six tool factories + `formatJob` helper, all returned by `createCronTools(scheduler)`. |
