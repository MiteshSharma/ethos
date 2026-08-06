---
title: "Team tools"
description: "Kanban, team-memory, and delegation tools for agents in a team context. Coordinators get management tools; specialists get work tools."
kind: reference
audience: developer
slug: team-tools
updated: 2026-07-10
---

The team toolset is what an Ethos [personality](../../getting-started/glossary.md#personality) reaches for when it is running inside a team — `ctx.teamId` is set, a coordinator drives the board, and members claim work off it. Three toolsets ship: **kanban** for the durable task board, **team_memory** for shared knowledge, and **delegation** for spawning sub-agents and routing work across the [mesh](../../getting-started/glossary.md#mesh).

Role gates decide who can call what. The coordinator gets the management surface (create, link, assign, archive); members get the work surface (complete, block, heartbeat on their own tasks); everyone can read, comment, and search. The gate is the `before_tool_call` hook implemented in [`extensions/tools-kanban/src/role-gate.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-kanban/src/role-gate.ts) — only registered when both a team manifest and a role are active. Solo personalities never see it.

This page is the umbrella reference. For schema-level kanban detail (statuses, store invariants, FTS5 search semantics), see [Kanban tools](./kanban-tools.md). For the team-memory user workflow, see [Share knowledge across a team with team memory](../../using/how-to/use-team-memory.md).

## Source {#source}

- Kanban tools: [`extensions/tools-kanban/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-kanban/src/index.ts)
- Team memory: [`extensions/tools-memory/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-memory/src/index.ts)
- Delegation: [`extensions/tools-delegation/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-delegation/src/index.ts)
- Role gate: [`extensions/tools-kanban/src/role-gate.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-kanban/src/role-gate.ts)

## Kanban tools {#kanban}

Toolset `kanban`. Thirteen tools backed by a STRICT-mode SQLite store with FTS5 search and an append-only audit trail. Tasks survive process restarts.

| Tool | Purpose | Role gate |
|---|---|---|
| `kanban_create_goal` | Create a top-level goal — a parent task with no assignee, whose children are the actual work. | coordinator only |
| `kanban_create` | Create a sub-task. Supports `parents`, `idempotency_key`, `acceptance_criteria`, `max_retries`. | coordinator only |
| `kanban_assign` | Set or clear `assignee` (personality id or `human:<name>`). | coordinator only |
| `kanban_link` | Add a `parent → child` edge. Cycles rejected. | coordinator only |
| `kanban_archive` | Soft-delete a task. Preserves audit trail. | coordinator only |
| `kanban_update_status` | Move a task to a new status (`todo`, `ready`, `running`, `blocked`, `done`, `archived`, `scheduled`, `failed`, `needs_revision`). | coordinator or current assignee |
| `kanban_complete` | End the open run as `completed`, status → `done`. Fires the [`before_ticket_complete` hook](#before-ticket-complete). | assignee only |
| `kanban_block` | End the open run as `blocked`, status → `blocked`. Reason is recorded as both run summary and a comment, atomically. | assignee only |
| `kanban_unblock` | Flip a blocked task back to `ready` (parents all done) or `todo` (parents still pending). | assignee only |
| `kanban_heartbeat` | Bump `last_heartbeat_at` on the open run; write a heartbeat audit event. | assignee only |
| `kanban_list` | List tasks. Filters: `assignee`, `status`, `parent_id`, `q` (FTS5 over title + body + comments), `limit`. | any member |
| `kanban_show` | Full view of one task: comments, last 10 runs, last 20 events. | any member |
| `kanban_comment` | Append a comment. No edits — additional comments only. | any member |

For statuses, transitions, store invariants, idempotency semantics, and the schema, see [Kanban tools](./kanban-tools.md).

## Team memory tools {#team-memory}

Toolset `team_memory`. Three tools over a per-team [memory scope](../../getting-started/glossary.md#memory-scope) (`team:<id>`). Topic files live at `~/.ethos/teams/<team>/memory/<topic>.md`. Every tool requires `ctx.teamId` to be set; calls outside a team context return `not_available`.

| Tool | Purpose | Role gate |
|---|---|---|
| `team_memory_read` | Read one topic file. `key` is alphanumeric, hyphens, or underscores; `.md` suffix is added automatically. | any member |
| `team_memory_write` | Update a topic. `action: 'add' \| 'replace' \| 'remove' \| 'delete'`. `add`/`replace` require `content`; `remove` requires `substring_match`; `delete` removes the topic file entirely. | any member |
| `team_memory_search` | Search team memory topics. Modes: `keyword` (default), `semantic`, `hybrid`. Returns matching topic files. | any member |

For the operator-facing workflow — initial topic set, prefetch semantics, and write patterns — see [Share knowledge across a team with team memory](../../using/how-to/use-team-memory.md).

## Delegation tools {#delegation}

Toolset `delegation`. Six tools — two for in-process sub-agent spawning, four for HTTP routing across the mesh. The two patterns serve different shapes:

- **Sub-agent spawn** (`delegate_task`, `mixture_of_agents`) runs another agent inside the same process. Cheap; bounded by `MAX_SPAWN_DEPTH = 3`. Use for clearly separable sub-work where a fresh context or a specialist personality helps.
- **Mesh routing** (`list_team`, `route_to_agent`, `dispatch_team`, `broadcast_to_agents`) calls remote agents over HTTP JSON-RPC at registered mesh endpoints. Use when work belongs to a different specialist running in its own process — often spawned by `ethos serve` with `--mesh`.

| Tool | Purpose | Role gate |
|---|---|---|
| `delegate_task` | Spawn one sub-agent (same process, fresh session, optionally a different personality). Returns its full text output. Max depth 3. | any member |
| `mixture_of_agents` | Spawn up to 5 sub-agents in parallel with different prompts or personalities; optionally synthesise their outputs with a final pass. | any member |
| `list_team` | List live mesh peers — agent id, personality, capabilities, host, port, active sessions. Use before dispatch planning. | any member |
| `route_to_agent` | Route one task to the best available mesh peer advertising a given `capability`. Picks the least-loaded match, retries up to 2 alternate peers on failure. Does not fall back to local execution. | any member |
| `dispatch_team` | Fan out multiple capability-scoped tasks across the mesh in parallel (max 12). Per-task retries and timeouts. | any member |
| `broadcast_to_agents` | Send the same prompt to every live mesh agent. Useful for parallel reviews or multi-perspective gathering. | any member |

The delegation tools require the personality's `network` capability — without it they return `not_available`. Mesh tools also require at least one peer registered in the active mesh (`ethos serve --mesh <name>` from each peer).

## The `before_ticket_complete` hook {#before-ticket-complete}

The completion path through `kanban_complete` is interception-aware. Before the running → done transition commits, the tool fires the [claiming hook](./hook-registry.md#claiming-hooks) `before_ticket_complete`. A handler returning `{ handled: true, reason }` rejects the completion: the ticket goes to `needs_revision` (with `reason` in the audit trail and a comment) instead of `done`. The assignee can re-claim and retry; the re-claim counts against the task's `max_retries` budget.

This is **opt-in** in standalone (single-personality) deployments. No handler registered — or no `HookRegistry` wired into the kanban tools at all — means `fireClaiming` returns `{ handled: false }` and completion proceeds unchanged. Since Phase 7, team deployments (config `teamName` set) default-wire a verifier handler — an eval-harness scoring pass over the completion summary against the ticket's acceptance criteria — so the review state is non-skippable there.

Signature:

```ts
import type { ClaimingHooks } from '@ethosagent/types';

type Payload = ClaimingHooks['before_ticket_complete'][0];
// { taskId, summary, acceptanceCriteria?, autonomyTier? }

type Result = ClaimingHooks['before_ticket_complete'][1];
// { handled: boolean; reason?: string }
```

When a handler rejects, the kanban tool also fires the void hook `after_ticket_revision` with `{ taskId, summary, acceptanceCriteria?, reason, assignee, autonomyTier?, successRatio? }` for observability and reputation tracking.

The full type lives in [`packages/types/src/hooks.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/hooks.ts). For the hook registry's three execution models and how claiming differs from void and modifying, see [HookRegistry reference](./hook-registry.md).

## See also {#see-also}

- [Kanban tools](./kanban-tools.md) — schema, statuses, store invariants, FTS5 semantics.
- [HookRegistry reference](./hook-registry.md) — every hook point, execution models, and registration API.
- [Run a team with a shared kanban board](../../using/how-to/run-a-team-with-kanban.md) — operator how-to that wires these tools together.
- [Share knowledge across a team with team memory](../../using/how-to/use-team-memory.md) — operator workflow for the `team_memory_*` toolset.
- [Teams and meshes](../explanation/teams-and-meshes.md) — why team context, role gates, and the mesh layer are separate.
