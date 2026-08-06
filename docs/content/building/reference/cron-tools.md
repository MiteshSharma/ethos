---
title: Cron tool
description: "Action-dispatch cron tool — create, list, get, read_run, update, pause, resume, run, remove. Wiring contract, scheduler sharing, and personality opt-in."
kind: reference
audience: developer
slug: cron-tools
updated: 2026-05-21
---

# Cron tool

A single action-dispatch `cron` tool lets any personality schedule recurring work. The `action` field dispatches to `create`, `list`, `get`, `read_run`, `update`, `pause`, `resume`, `run`, or `remove`. The tool registers against the same `CronScheduler` instance the operator-driven `ethos cron` CLI uses, so jobs created via either path land in the same store and fire through the same engine.

## Source {#source}

Factory: [`extensions/tools-cron/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-cron/src/index.ts) (`createCronTool(scheduler)`). Scheduler implementation: [`@ethosagent/cron`](https://github.com/ethosagent/ethos/tree/main/packages/cron). Wiring at [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts) — registers the tool when `cronScheduler` is passed in via `CreateAgentLoopOptions`.

## Availability {#availability}

The tool is registered on the agent's tool registry **only when** a `CronScheduler` is wired through to `createAgentLoop`. Two callers do this today:

| Caller | Behaviour |
|---|---|
| `ethos gateway` | Always wires a scheduler. Every personality bound to a configured bot has the cron tool available if it lists `cron` in `toolset.yaml`. |
| `ethos serve` | Always wires a scheduler. The web Cron tab and agent-callable cron tool share the same scheduler instance. |
| `ethos chat` / CLI one-off | No scheduler — cron jobs created in an ephemeral process can't persist past exit. The tool isn't registered. |

A personality that lists `cron` in `toolset.yaml` but runs in a context without a scheduler gets an "unknown tool" error at call time. That's intentional — calling `cron` from a CLI chat would silently create jobs that never fire.

## Personality opt-in {#opt-in}

Add the tool to the personality's `toolset.yaml`:

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- cron
```

## Actions {#actions}

### `create` {#create}

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human-readable label (e.g. `"Morning Briefing"`). |
| `schedule` | string | yes | Standard 5-field cron expression — minute hour day month weekday. All times are local. Validated via `isValidCronExpression`. |
| `prompt` | string | yes | The prompt the agent runs on each firing. |
| `missed_run_policy` | `'run-once' \| 'skip'` | no | What to do if the scheduler was down when the job's scheduled time passed. `run-once` fires the missed slot on next start; `skip` waits for the next normal occurrence. Default: `skip`. |

Always pins the job to the caller's personality (`ctx.personalityId`). Returns an error if no personality context is available.

### `list` {#list}

| Field | Type | Required |
|---|---|---|
| `personality` | string | no |

Returns every job in the store (optionally filtered by personality) with id, name, schedule, status, next-run timestamp, and prompt summary.

### `get` {#get}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Returns full job detail plus recent run timestamps.

### `read_run` {#read-run}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `at` | string | yes |

Reads the output of a specific historical run, identified by the ISO-8601 timestamp from `get`.

### `update` {#update}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `name` | string | no |
| `schedule` | string | no |
| `prompt` | string | no |

At least one of `name`, `schedule`, or `prompt` must be provided. **Not yet implemented** — returns `not_available`. Will be wired in Phase C.

### `pause` {#pause}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Marks the job paused. The scheduler stops firing it but the row stays in the store.

### `resume` {#resume}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Unpauses. The next-run time is recomputed from the schedule.

### `run` {#run}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Fires the job's prompt immediately, outside its normal schedule. Returns the output. The next scheduled firing is not affected.

### `remove` {#remove}

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |

Permanently removes the job. Cannot be undone. Use `pause` for a reversible stop.

## Recursion guard {#recursion-guard}

When a cron job fires, the `runJob` closure passes `toolsetOverride` to `AgentLoop.run()`, filtering out the `cron` tool from the effective toolset. This prevents cron-spawned sessions from scheduling further cron jobs (infinite recursion).

## Wiring contract {#wiring}

Callers thread the scheduler through `CreateAgentLoopOptions.cronScheduler`:

```ts
// packages/wiring/src/index.ts CreateAgentLoopOptions
cronScheduler?: CronScheduler;
```

When present, the wiring registers `createCronTool(scheduler)` on the AgentLoop's tool registry. The tool registry's per-personality filter then exposes the tool only if the personality's `toolset.yaml` includes `cron`.

## Capability rationale {#capabilities}

`capabilities: {}` — no framework-level gate. The scheduler is operator-injected; without one, no tool registration happens. The store is per-machine (under `~/.ethos/cron/`). Jobs created by the agent are visible to the operator via `ethos cron list` immediately.

**Cron creates durable side effects** (recurring runs cost provider tokens; output may notify channels). Treat the personality opt-in as the safety boundary.

## Errors {#errors}

| `code` | When | Operator fix |
|---|---|---|
| `not_available` | Tool listed in toolset but no scheduler wired (e.g. `ethos chat` profile) | Run from `ethos gateway` or `ethos serve` |
| `not_available` | `update` action called (not yet implemented) | Wait for Phase C |
| `input_invalid` | Cron expression failed `isValidCronExpression` | Fix the 5-field syntax |
| `input_invalid` | Missing required field for the action | Provide it |
| `input_invalid` | `create` called without personality context | Ensure a personality is active |
| `execution_failed` | `run` and the agent's run produces an error | Investigate the prompt or model |

## Examples {#examples}

### Morning briefing {#example-morning-briefing}

```text
cron({
  action: "create",
  name: "Morning briefing",
  schedule: "0 8 * * 1-5",
  prompt: "Summarise overnight Slack alerts, the deploy log, and pending PRs."
})
```

### List all jobs {#example-list}

```text
cron({ action: "list" })
```

### Get job detail with run history {#example-get}

```text
cron({ action: "get", id: "morning-briefing" })
```

### Read a specific run's output {#example-read-run}

```text
cron({ action: "read_run", id: "morning-briefing", at: "2026-05-21T08:00:00.000Z" })
```

### Pause and resume {#example-pause-resume}

```text
cron({ action: "pause", id: "morning-briefing" })
cron({ action: "resume", id: "morning-briefing" })
```

### Run immediately {#example-run}

```text
cron({ action: "run", id: "morning-briefing" })
```

### Remove {#example-remove}

```text
cron({ action: "remove", id: "morning-briefing" })
```

## See also {#see-also}

- [`@ethosagent/cron` package](https://github.com/ethosagent/ethos/tree/main/packages/cron) — the scheduler implementation.
- [`send_message` reference](messaging-tools.md) — pair with `cron` to schedule cross-channel notifications.
- [CLI reference](../../using/reference/cli.md) — `ethos cron list / pause / resume / delete / run / create` for the operator-driven side of the same store.
