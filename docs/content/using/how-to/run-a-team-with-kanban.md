---
sidebar_position: 6
title: Run a team with a shared kanban board
description: Stand up a multi-personality team whose work is captured on a durable kanban board the coordinator manages and the dispatcher routes.
kind: how-to
audience: user
slug: run-a-team-with-kanban
time: 15 min
updated: 2026-05-11
---

Set up an Ethos team whose coordinator captures human goals as durable tasks, whose dispatcher routes ready work to assignees over the mesh, and whose audit trail and run state survive process restarts.

## Task

Stand up a multi-personality Ethos team backed by a durable shared kanban board.

## Result

A running team supervisor, a populated `~/.ethos/teams/<name>/board.db`, and a coordinator that decomposes the next multi-part request into linked tasks without manual dispatch.

## Prereqs

- Ethos installed and `ethos chat` working solo. (See [Quickstart](../quickstart).)
- A working LLM provider configured (the coordinator and members all hit it).
- A team manifest authored at `~/.ethos/teams/<name>.yaml` or `./team.yaml` — see step 1.

## 1. Author the team manifest

Create `~/.ethos/teams/analytics.yaml`. The crucial Plan B fields are `dispatch_mode: coordinator`, one member with `role: coordinator`, and the rest defaulting to `role: member`:

```yaml
name: analytics
description: Quarterly analytics roadmap team.
domain_capabilities: [analytics, planning]
dispatch_mode: coordinator
coordinator: coordinator
members:
  - personality: coordinator
    role: coordinator
  - personality: data-engineer
    role: member
  - personality: researcher
    role: member
  - personality: reviewer
    role: member
kanban:
  stale_ms: 90000     # heartbeat threshold before the dispatcher marks a task blocked
  poll_ms: 1000       # dispatcher polling cadence (in-process events drive the fast-path)
```

`ethos team start` rejects the manifest if `dispatch_mode: coordinator` is set without exactly one `role: coordinator` member matching the top-level `coordinator` field. That is intentional — without it the kanban role gate would silently disappear and any member could create coordinator-only tasks.

## 2. Start the team

```
ethos team start analytics
```

The supervisor spawns each member on an auto-allocated port, opens `~/.ethos/teams/analytics/board.db`, and starts the dispatcher loop. The dispatcher is doing three things every tick:

- Promoting `todo` tasks whose parents are all `done` to `ready`.
- Promoting `scheduled` tasks whose time has passed to `ready`.
- Claiming `ready` tasks with a `running` assignee, opening a `task_run`, and POSTing the task body to that assignee's `/rpc` endpoint.

It also reclaims stalled runs: any open run with no heartbeat in `kanban.stale_ms` becomes `blocked` so it surfaces on the board instead of disappearing.

## 3. Hand the coordinator a goal

```
ethos chat --team analytics
> Build a Q3 analytics roadmap. Have data-engineer scope pipelines,
  researcher do market scan, reviewer pressure-test.
```

The coordinator's rewritten SOUL.md is explicit about this pattern: a multi-part request becomes `kanban_create_goal` for the top-level intent, then `kanban_create` for each sub-task with `parents` and `assignee` set. A typical trace:

```
[ coordinator: kanban_create_goal(title="Q3 Analytics Roadmap") → g_4f2          ]
[ coordinator: kanban_create(title="Scope pipeline work",                         ]
[                            assignee="data-engineer", parents=["g_4f2"])  → t_a1 ]
[ coordinator: kanban_create(title="Market scan: AI agent space",                ]
[                            assignee="researcher",    parents=["g_4f2"])  → t_b1 ]
[ coordinator: kanban_create(title="Pressure-test plan",                          ]
[                            assignee="reviewer",      parents=["g_4f2","t_a1","t_b1"]) → t_c1 ]
```

The coordinator does not call `route_to_agent` here. Durable work goes to the board; the dispatcher owns routing. `dispatch_team` and `route_to_agent` stay in the coordinator's toolset for the rare case where the coordinator needs N quick results synthesized inside one turn — but those are not the default.

## 4. Watch work flow

Within one second the dispatcher claims `t_a1` and `t_b1` (their parent `g_4f2` is the goal and has no dependencies of its own; both are immediately ready). `t_c1` waits in `todo` because two of its parents are still in flight.

Each assignee receives a prompt from the dispatcher:

```
## Task t_a1: Scope pipeline work
<task body>

When you finish, call `kanban_complete` with a one-line summary.
If you get stuck, call `kanban_block` with the reason.
Heartbeat with `kanban_heartbeat` if the work takes longer than a minute.
Task id: `t_a1` — pass this exact id to the kanban tools.
```

`engineer`, `researcher`, and `reviewer` ship with the kanban participation tools (`kanban_show`, `kanban_list`, `kanban_comment`, `kanban_update_status`, `kanban_complete`, `kanban_block`, `kanban_unblock`, `kanban_heartbeat`). The role gate enforces that only the task's assignee can call the closer-tools, but any team member can comment and list.

## 5. Check status without leaving chat

```
> status?

[ coordinator: kanban_list(parent_id="g_4f2") + kanban_show(g_4f2) ]
[ coordinator → user: "Pipeline scope: 60% done (3 comments).      ]
[                      Market scan: just finished. Pressure-test:  ]
[                      queued."                                    ]
```

The coordinator quotes the board rather than paraphrasing — that is by design. The board is the source of truth.

## 6. Survive a restart

```
ethos team stop analytics
ethos team start analytics
```

Any `running` task whose worker was killed mid-flight lands in `blocked` on the next dispatcher tick (its open run goes stale within `kanban.stale_ms`). The coordinator (or you, via `kanban_unblock`) can re-queue it. The audit trail, comments, runs, and links all persist.

## Verify

- `ls -la ~/.ethos/teams/analytics/board.db` — board file exists after `ethos team start`.
- `sqlite3 ~/.ethos/teams/analytics/board.db 'SELECT count(*) FROM tasks'` — non-zero after the coordinator processes the goal.
- `sqlite3 ~/.ethos/teams/analytics/board.db "SELECT kind, count(*) FROM task_events GROUP BY kind"` — at least `created`, `linked`, `status_changed`, and (after work runs) `run_started`, `run_completed`.
- `ethos team status analytics` — every member shows `running` with a recent probe time.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| `team.yaml is invalid — dispatch_mode=coordinator requires exactly one member with role=coordinator` | The manifest omits the role field on the coordinator member. | Add `role: coordinator` to the member whose personality matches the top-level `coordinator` field. Plan B fails closed here — the role gate would otherwise silently disappear. |
| `member with role=coordinator (X) does not match top-level coordinator (Y)` | Role and `coordinator` field disagree. | Pick one. Update either the member's `personality` or the top-level `coordinator` so they match. |
| Coordinator replies but no tasks appear on the board | Either no member's toolset includes `kanban_*` (the wiring lazy-builds the store only when an active personality wants kanban) or the coordinator personality lost its kanban tools. | Confirm `~/.ethos/personalities/coordinator/toolset.yaml` (or the built-in equivalent) still has `kanban_create_goal` and friends. |
| Dispatcher fires once and never again | Member status flipped to `failed` or `degraded`. | Run `ethos team status` to confirm; check `~/.ethos/logs/team/<name>/<member>.log` for crash output. |
| Task stays `running` forever | The assignee personality is missing the closer tools (`kanban_complete` / `kanban_block` / `kanban_heartbeat`). | Add the closer tools to that personality's `toolset.yaml`. Built-in `engineer`, `researcher`, and `reviewer` ship with them. |
| `ethos team destroy <name>` refuses to run | The team is still running. | Stop it first: `ethos team stop <name>` then re-run destroy with `--yes`. |

## See also

- [Work with a team](work-with-a-team.md) — the team scope in the web dashboard: Overview, ledger, board actions
- [Kanban primitive (Plan A — solo)](../../building/reference/kanban-tools) — what the team board is built on
- [Teams and meshes](../../building/explanation/teams-and-meshes) — supervisor, port allocation, dispatch modes
- [`ethos team` CLI reference](../reference/cli) — every subcommand including the new `destroy`
