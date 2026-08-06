---
sidebar_position: 7
title: Kanban
description: A durable SQLite-backed task substrate any personality can opt into, with FTS5 search and an append-only audit trail.
kind: reference
audience: developer
slug: kanban-tools
updated: 2026-05-17
---

# Kanban — Durable Task Substrate

The kanban primitive is a durable, SQLite-backed task tracker that any personality can opt into via its `toolset.yaml`. Tasks survive process restarts. Comments, run history, and an audit log are preserved.

It is intentionally **not** a coordination layer — there is no dispatcher, no role-based authorization, no `@mention` notifications, no web UI. Those layer on top in the team-supervisor (Plan B). Plan A is just the substrate.

## When to use it {#when-to-use-it}

| Need | Use this |
|---|---|
| "Remember 3 things this turn" | `todo_*` (in-memory, single-session, single-personality) |
| "Track work that survives a restart" | `kanban_*` (this page) |
| "Coordinate across multiple personalities" | Plan B — team-supervisor (layers on this) |

The two toolsets exist on purpose. `todo_*` is a scratch list and resets between sessions. `kanban_*` is a board that outlives the conversation.

## Opting in {#opting-in}

Add the tools you want to a personality's `toolset.yaml`:

```yaml
- kanban_create
- kanban_create_goal
- kanban_list
- kanban_show
- kanban_update_status
- kanban_comment
- kanban_complete
- kanban_block
- kanban_unblock
- kanban_heartbeat
- kanban_link
- kanban_assign
- kanban_archive
```

The wiring layer constructs a `KanbanStore` lazily — it only runs when at least one tool in the active personality's toolset starts with `kanban_`.

The DB path defaults to `~/.ethos/personalities/<personality-id>/kanban.db` — one board per personality. Plan B's team manifests override this with `kanbanDbPath` to point at a shared team board.

The built-in `task-tracker` personality has all 13 tools enabled and is the simplest way to try it out:

```bash
ethos chat --personality task-tracker
```

## Schema (Plan A v1) {#schema}

Five STRICT-mode SQLite tables plus an FTS5 virtual table for search:

| Table | Purpose |
|---|---|
| `tasks` | One row per task — title, body, status, priority, assignee, workspace mode, idempotency key, current run pointer |
| `task_comments` | Append-only thread of human/agent commentary per task |
| `task_links` | `(parent_id, child_id)` edges expressing "X must finish before Y" |
| `task_runs` | Per-run lifecycle: started/ended timestamps, outcome, summary, heartbeat |
| `task_events` | Append-only audit trail — every mutation through the store inserts a row |
| `task_fts` | FTS5 shadow table over title + body + concatenated comments |

The runtime invariants enforced at the store layer:

- **Idempotency.** `create({ idempotencyKey })` returns the existing task if the key matches — never creates a duplicate. The key is lookup-by-key only; reusing it with different content gives you back the original task, not an update.
- **Append-only comments.** No update/delete API; the FTS triggers honor this contract.
- **Cycle prevention.** `link(parent, child)` rejects a link that would close a cycle, including via transitive ancestors.
- **One open run per task.** A partial unique index on `task_runs(task_id) WHERE ended_at IS NULL` enforces this at the database level.
- **Auto-cancel on bypass.** Setting `status` away from `running` via `kanban_update_status` (instead of `kanban_complete` / `kanban_block`) auto-cancels the open run with outcome `cancelled`. Status and run state cannot diverge.
- **Audit completeness.** Every mutation inserts a `task_events` row (`created`, `status_changed`, `commented`, `assigned`, `linked`, `unlinked`, `run_started`, `run_completed`, `heartbeat`, `archived`).

## Statuses {#statuses}

```
todo → ready → running → done
                  ↓
              blocked  (call kanban_unblock to re-route back into todo/ready)
                  ↓
              archived  (soft-delete; audit trail preserved)
```

Plan A does not enforce transitions — callers may set any status. Plan B's dispatcher adds the auto-promotion rules (`todo → ready` when parents close, `scheduled → ready` when time passes).

## Tool surface {#tool-surface}

All tools live in the `kanban` toolset and cap output at 20 000 chars.

| Tool | Args | Returns |
|---|---|---|
| `kanban_create` | `title, body?, assignee?, priority?, parents?, workspace_mode?, scheduled_for?, idempotency_key?` | `{ task_id, status }` |
| `kanban_create_goal` | `title, description?, priority?, idempotency_key?` | `{ task_id, status }` — creates a top-level GOAL (assignee=null). Sugar around `kanban_create`; child sub-tasks are created via `kanban_create` with `parents=[goal_id]`. |
| `kanban_list` | `assignee?, status?, parent_id?, q?, limit?` | array of task summaries (default 100, max 1000). `q` is an FTS5 query over title + body + comments. |
| `kanban_show` | `task_id` | task + comments + last 10 runs + last 20 events |
| `kanban_update_status` | `task_id, status, reason?` | updated task (auto-opens/cancels runs on `running` transitions) |
| `kanban_comment` | `task_id, body` | `{ comment_id }` |
| `kanban_complete` | `task_id, summary` | updated task — ends current run, status=done |
| `kanban_block` | `task_id, reason` | updated task — ends current run, status=blocked, reason recorded atomically as both run summary and comment |
| `kanban_unblock` | `task_id` | updated task — `ready` if all parents are `done`; `todo` otherwise. Refuses to run if the task is not currently `blocked`. |
| `kanban_heartbeat` | `task_id, note?` | bumps `last_heartbeat_at` on the open run |
| `kanban_link` | `parent_id, child_id` | rejects cycles; idempotent on re-link |
| `kanban_assign` | `task_id, assignee` | updated task; pass `null` to unassign |
| `kanban_archive` | `task_id` | updated task — status=archived; closes any open run as `cancelled` first |

## Forward reference: teams (Plan B) {#forward-reference-teams}

Plan B layers governance on this substrate without touching the tool implementations:

- A **dispatcher** in `team-supervisor` auto-promotes `todo → ready` when parents close and `scheduled → ready` when time passes.
- A **role gate** registered via the `before_tool_call` hook restricts which personality can call which tool.
- A **team manifest** at `~/.ethos/teams/<name>/team.yaml` points `kanbanDbPath` at `~/.ethos/teams/<name>/board.db`, giving every team member access to the same board.
- A **notify loop** turns `@mention` patterns in comments into routing events.

None of those require schema changes — the columns `workspace_mode`, `workspace_path`, `scheduled_for`, and `current_run_id` are pre-positioned for Plan B.

## Source {#source}

- [`extensions/kanban-store`](https://github.com/ethosagent/ethos/tree/main/extensions/kanban-store) — schema, migrations, repository. Pure data layer.
- [`extensions/tools-kanban`](https://github.com/ethosagent/ethos/tree/main/extensions/tools-kanban) — the 13 tool wrappers + `createKanbanTools` factory.
- [`extensions/personalities/data/task-tracker/`](https://github.com/ethosagent/ethos/tree/main/extensions/personalities/data/task-tracker) — built-in personality with all 13 tools enabled.
