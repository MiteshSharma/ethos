---
title: Work with a team
description: Switch the web dashboard into a team scope, chat with the team through its coordinator, read the Overview and supervisor ledger, and act on the board.
kind: how-to
audience: user
slug: work-with-a-team
time: "10 min"
updated: 2026-09-04
---

## Task

Operate a running [team](../../getting-started/glossary.md#team) (a named set of personalities that share a kanban board and a supervisor process) from the web dashboard: enter the team's scope, talk to it, see who is doing what, and clear anything that needs you.

## Result

The dashboard is scoped to one team. Its rail shows the members, its column shows the team panes, the Overview tells you what needs attention, and the Board lets you approve, unblock, reassign, or archive tickets without leaving the browser.

## Prereqs

- A team manifest at `~/.ethos/teams/<team>/team.yaml` — see [Run a team with a shared kanban board](run-a-team-with-kanban.md).
- The dashboard running: `ethos serve --web` ([Use the web dashboard](use-web-dashboard.md)).
- The team's supervisor started with `ethos team start <team>`. A stopped team still appears everywhere below; its panes just say so.

## 1. Pick a scope

The first crumb of the breadcrumb is the scope switcher. At the Library it reads `Independent ▾`; inside a team it reads the team's name. Click it (or focus it and press `Enter`) to open the menu:

| Row | What it is | Where it goes |
|---|---|---|
| **Independent** | Every [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, and model) that belongs to no team | `/personalities` |
| One row per team | The team's ring, its dispatch mode, and `N working` or `stopped`, plus the member count | `/t/<team>/overview` |
| **New team** | The `team-architect` wizard | `/teams/create` |

Two more doors lead to the same place: the Library's **Teams** page (`/teams`), where every row has `Open scope →`, and the command palette (`⌘K`), which lists `Switch to <team>`, `Chat with <team>`, and `<team> › Board`.

## 2. Read what changed

Picking a team changes three things at once:

| Surface | Independent | Team scope |
|---|---|---|
| Rail | Annulus at the top, independent personalities below | The team's ring at the top, members below with the coordinator first and marked as lead |
| Column | Library rows | `Chat` (with `via <coordinator>`), a rule, then `Overview · Board · Structure · Memory · Activity · Channels · Settings`, then `RECENT IN <TEAM>` |
| Home | `/personalities` | `/t/<team>/overview` |

Team chrome stays neutral. Only the Chat pane takes the coordinator's accent, because it is the coordinator's surface.

## 3. Chat with the team

Open **Chat** in the column, or click the rail's team ring and then `Message <team> via <coordinator>` on the Overview.

The team's Chat pane **is** the coordinator's session. Sending a message at `/t/<team>/chat` and sending one from the coordinator's own workspace land in the same [session](../../getting-started/glossary.md#session) (one persisted conversation history), and the sessions listed in the column are the coordinator's. There is no second inbox to keep in sync. The composer says which member answers, and `Open <coordinator>'s workspace →` at the right of the bar takes you to that member's own panes.

A team with no coordinator (a `broadcast` team) has no Chat pane. Message a member directly from the rail instead.

## 4. Scan the Overview

`/t/<team>/overview` is the team's home. Top to bottom:

- **Status line** — five cells: Supervisor (`● Running · up 6h 12m` or `Stopped`), Dispatch (mode, coordinator, poll interval), Board (`3 running · 1 blocked · 1 revision · 11 done`), Trust (`Flat · stale after 30m`), Channel (the bound bot, or `None bound`).
- **Members** — one row per member: mark, name (`coordinator` in mono where applicable), the ticket they are on or `idle · waiting for a ticket`, or `offline` when the supervisor is down. Below it, the team's [memory](../../getting-started/glossary.md#memory) topics as chips.
- **Board, attention first** — tickets grouped `Needs revision`, `Blocked`, `Running`, `Ready`. `todo` and `done` are left off; `Nothing open` means nothing needs you.
- **Supervisor ledger** — the latest 50 lines of what the supervisor did. When the supervisor is stopped, the column says so and shows the command to start it.

Hover any member anywhere — rail avatar, member row, tile, node, or ledger line — and every element that belongs to them lights up across the panes.

### What each ledger line means

Every line is derived from the board's event log. `#id` links to the ticket in the Board drawer.

| Line | Meaning |
|---|---|
| **Dispatch tick** `claimed for <member>` | The dispatcher moved a ready ticket to `running` and handed it to that member. |
| **Stale reclaim** `<member> heartbeat went stale · back to ready` | A running ticket's heartbeat passed the stale limit (or its owner process is gone), so the supervisor put it back in `ready` for someone else. |
| **Verifier rejected** `<reason> · retry n of N` | The member called `kanban_complete`, and the verifier scored the summary against the ticket's acceptance criteria and refused it. The ticket is in `needs_revision`; `n of N` is its retry budget. |
| **Verifier passed** `<member> · <summary>` | A run completed on a ticket with acceptance criteria and the verifier accepted it. A ticket without criteria shows **Completed** instead. |
| **Blocked** `<reason>` | The member blocked its run and said why. |
| **Operator assigned** `to <member> · <status>` | You assigned or reassigned the ticket from the Board. |
| **Operator approved** | You approved a `needs_revision` ticket as done, bypassing the verifier. |
| **Operator archived** | You archived the ticket. |
| **Created** `by <actor>` | The ticket was created, and by whom. |

Heartbeats, comments, and link changes do not appear; the Activity pane (`/t/<team>/activity`) shows the full board activity beside the ledger.

## 5. Act on the board

`/t/<team>/board` is the kanban with one column per status. Click a tile to open its drawer. The actions on offer depend on the ticket's state:

| Ticket state | Actions |
|---|---|
| `needs_revision` | **Approve as done** · Reassign |
| `blocked` | **Unblock** · Reassign |
| `todo`, `ready` | Assign / Reassign · Archive |
| `running` | Reassign |
| `done` | Archive |

- **Approve as done** marks the ticket `done` with the reason `approved by operator, verifier bypassed`. The ledger shows it as **Operator approved**.
- **Unblock** returns the ticket to `ready` so the dispatcher can hand it out again.
- **Reassign** opens a member picker fed by the manifest. Choosing a member assigns the ticket and, for `todo`, `needs_revision`, or `blocked` tickets, moves it to `ready`.
- **Archive** hides the ticket from the board. Toggle `Archived` in the header to see archived tickets.

`+ New task` in the header opens the same create dialog as the Library's Kanban page. `?task=<id>` in the URL opens a ticket's drawer directly; the ledger and the Overview use it for their links.

## 6. Read the Structure

`/t/<team>/structure` draws the team as it is wired: the coordinator on top, members across the middle, and the Board, Team memory, and Channel nodes below.

- A **solid** edge is dispatch: the coordinator hands tickets down it. Its label is the member's current ticket and age, or `idle` / `offline`.
- A **dashed** edge is shared: members reach the team memory through it, and the coordinator reaches the board and the bound channel.
- **Click** a node to open its side sheet: a member's character sheet, current ticket, lifetime `done of total`, and the ledger filtered to them; the memory topics; the channel binding; or the board's dispatch, staleness, trust, and verifier settings.
- **Double-click** a member to enter their workspace.

A member whose personality directory is missing renders with a dashed red border and `personality not found` in its sheet.

## 7. Memory, Channels, Settings

| Pane | URL | What you can do |
|---|---|---|
| Memory | `/t/<team>/memory` | Read the team's topic files (`~/.ethos/teams/<team>/memory/`), `Edit` one, or `+ New topic`. `?topic=<name>` selects. See [Share knowledge across a team](use-team-memory.md). |
| Channels | `/t/<team>/channels` | See which gateway bots are bound to the team, which platform and chat, and who fronts them. `+ Bind channel` goes to Platforms with the team preselected. |
| Settings | `/t/<team>/settings` | Read the manifest as it is on disk, the runtime block (supervisor state, members online, restart guard), and the two commands to copy. Editing the manifest happens in the file for now. |

The Settings pane shows these commands, copyable:

```bash
ethos team start <team>
ethos team stop <team>
```

Starting and stopping stays a CLI action. The supervisor is a process on the machine, not something the browser owns.

## 8. Enter a member's workspace

Every member's workspace keeps its usual panes, prefixed with the team: `/t/<team>/p/<member>/chat`, `/t/<team>/p/<member>/memory`, and so on. The column gains one line, `← <team>`, which returns to the Overview. A personality in no team keeps the plain `/p/<member>/…` form. Managing a personality itself — identity, toolset, memory — is unchanged; see [Use the web dashboard](use-web-dashboard.md).

If the URL names a member who is not in that team, the dashboard redirects to the team's Overview and says so. `/t/<unknown>/…` redirects to `/teams`.

## Verify

1. Open the switcher and pick your team. The URL is `/t/<team>/overview` and the rail shows the members with the coordinator first.
2. Send `Who is on what right now?` from `/t/<team>/chat`. Then open `/t/<team>/p/<coordinator>/chat` — the same exchange is there.
3. On the Board, open a `needs_revision` ticket and click **Approve as done**. Back on the Overview, the ledger's newest line reads **Operator approved**.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| The switcher lists the team but the Overview says `Stopped` and members are `offline` | The supervisor process is not running | Run `ethos team start <team>`; the status line flips to `● Running` on the next refresh. |
| Chat is missing from the column | The team has no coordinator (`broadcast` dispatch) | Message a member from the rail, or declare a coordinator in `team.yaml`. |
| A ticket keeps returning as **Stale reclaim** | The member's run stops heart-beating before it finishes | Raise `kanban.staleMs` in the manifest, or split the ticket. |
| **Verifier rejected** every retry | The summary does not meet the ticket's acceptance criteria | Read the reason in the drawer; either fix the criteria and Reassign, or **Approve as done** if the work is in fact complete. |

## See also

- [Run a team with a shared kanban board](run-a-team-with-kanban.md) — author the manifest and start the supervisor
- [Share knowledge across a team with team memory](use-team-memory.md) — the topic files the Memory pane edits
- [Connect Telegram to a team](connect-telegram-to-team.md) — what the Channels pane lists
