---
title: "Stability tier table"
description: "Every contract namespace with its stability tier and the procedures it exposes."
kind: reference
audience: developer
slug: stability-tier-table
updated: 2026-05-13
---

## Synopsis {#synopsis}

The Ethos control-plane contract assigns each namespace a stability tier. Stable namespaces follow semver -- breaking changes require a major version bump. Experimental namespaces may change in any minor release. This page lists every namespace, its tier, and the procedures it exposes today.

## Tiers {#tiers}

| Tier | Meaning |
|---|---|
| **@stable v1** | API surface is committed. Breaking changes require a major version bump. |
| **@experimental** | API surface may change in any minor release. Pin your SDK version and watch the changelog. |

## Namespace table {#table}

| Namespace | Tier | Procedures |
|---|---|---|
| `sessions` | @stable v1 | `list`, `get`, `fork`, `delete`, `update` |
| `personalities` | @stable v1 | `list`, `get`, `characterSheet`, `create`, `update`, `delete`, `duplicate`, `skillsList`, `skillsGet`, `skillsCreate`, `skillsUpdate`, `skillsDelete`, `skillsImportGlobal` |
| `chat` | @stable v1 | `send`, `abort` |
| `memory` | @stable v1 | `list`, `get`, `write` |
| `meta` | @stable v1 | `capabilities` |
| `tools` | @experimental | `approve`, `deny` |
| `clarify` | @experimental | `respond` |
| `onboarding` | @experimental | `state`, `validateProvider`, `complete` |
| `config` | @experimental | `get`, `update` |
| `cron` | @experimental | `list`, `get`, `create`, `delete`, `pause`, `resume`, `runNow`, `history` |
| `skills` | @experimental | `list`, `get`, `create`, `update`, `delete` |
| `evolver` | @experimental | `configGet`, `configUpdate`, `pendingList`, `pendingApprove`, `pendingReject`, `history` |
| `mesh` | @experimental | `list`, `routeTest` |
| `plugins` | @experimental | `list` |
| `platforms` | @experimental | `list`, `set`, `clear`, `botsListTelegram`, `botsAddTelegram`, `botsRemoveTelegram`, `botsListSlack`, `botsAddSlack`, `botsRemoveSlack` |
| `batch` | @experimental | `list`, `start`, `get`, `output` |
| `eval` | @experimental | `list`, `start`, `get`, `output` |
| `kanban` | @experimental | `list`, `getBoard`, `updateStatus` |
| `apiKeys` | @experimental | `create`, `list`, `revoke` |

## Counts {#counts}

- **Stable namespaces:** 5 (sessions, personalities, chat, memory, meta)
- **Experimental namespaces:** 14
- **Total procedures:** 77

## Notes {#notes}

- The `apiKeys` namespace requires cookie-auth. Bearer-token auth is rejected to prevent privilege escalation.
- The `chat.send` RPC is fire-and-forget -- the agent's response streams over [SSE](./sdk-event-stream.md), not the RPC response.
- The `platforms` namespace includes multi-bot CRUD for Telegram and Slack alongside the base platform operations.
- The `eval` namespace is aliased as `evalNs` internally to avoid collision with JavaScript's `eval` keyword.
- Stability tiers are declared as JSDoc `@stable`/`@experimental` tags in [`packages/web-contracts/src/router.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/router.ts).
