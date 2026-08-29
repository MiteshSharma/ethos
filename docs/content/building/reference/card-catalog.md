---
title: Card catalog
description: "The nine UI card kinds — payload fields, caps, and an emit_card example for each, plus the composition rules and the web/desktop-only boundary."
kind: reference
audience: developer
slug: card-catalog
updated: 2026-08-11
---

A card is a typed, versioned block of structured output that the web and desktop surfaces render natively. Nine kinds exist. Eight are produced by the `emit_card` [tool](../../getting-started/glossary.md#tool) (a function the model can call); the ninth, `canvas`, is produced only by `render_ui`.

Payloads are data-shaped, never presentation-shaped. The model describes what the data *is* — a series, a set of rows, one record — and the client decides how it looks. No colors, no HTML, no chart specs, no URLs travel in a payload.

## Source {#source}

Schemas: [`packages/web-contracts/src/cards.ts`](https://github.com/ethosagent/ethos/tree/main/packages/web-contracts/src/cards.ts). Tools: [`extensions/tools-ui/src/emit-card.ts`](https://github.com/ethosagent/ethos/tree/main/extensions/tools-ui/src/emit-card.ts) and [`extensions/tools-ui/src/render-ui.ts`](https://github.com/ethosagent/ethos/tree/main/extensions/tools-ui/src/render-ui.ts). Both tools carry the toolset `ui`.

## Envelope {#envelope}

Every card travels as `{ kind, specVersion, payload }` on `ToolResult.structured.card`. The tool stamps `kind` and `specVersion`; the model supplies only `payload`. `CARD_SPEC_VERSION` is `1`.

The envelope is validated three times: at the tool (the model gets field-level issue paths and retries), before broadcast (invalid envelopes are stripped from the wire and logged), and on history replay (invalid or unknown `kind` renders a labeled fallback block). `ToolResult.value` is a short ack such as `rendered: data_table: Sector flow` — the payload never echoes into conversation history.

## Surface boundary {#surface-boundary}

Cards render on `web` and `desktop` only. Every channel adapter — Telegram, Discord, Slack, WhatsApp, email — drops the `ui` toolset before the model sees it, and both tools re-check `ctx.platform` as a backstop, returning `ok: false` with `Cards render on the web surface; answer in prose here.`

This is the design, not a gap. Prose is the durable answer on every surface; cards are additive on the two surfaces that can draw them. A turn that emits no card is never blank.

## Composition rules {#composition-rules}

A [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, and model) whose toolset includes `emit_card` or `render_ui` receives these rules in its system prompt, from `createUiGuidanceInjector`:

1. Prose is the durable answer. A card never replaces the explanation.
2. Order within a turn: data cards first, then at most one short prose caption, then `recommend_actions` last.
3. `recommend_actions` is emitted only when a genuine next step exists, and never more than three actions.
4. Match the kind to the shape of the data: a series → `metric_chart`; rows → `data_table`; one record → `detail`; a set of like things → `item_list`.
5. Reach for `render_ui` only for shapes the eight card kinds cannot express.

The injector also lists the personality's own Canvas templates, scanned once at composition time from `<personality-dir>/ui/*.html`.

## text {#text}

For an explanation, a summary, or any prose block that deserves its own container instead of flowing inline.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | no | Max 120 chars. |
| `text` | string | yes | Markdown body. 1–8 000 chars. |

```json
{ "kind": "text", "payload": { "title": "Why this setup", "text": "Volume dried up through the base and expanded on the breakout." } }
```

## code {#code}

For source text the reader will copy: a file, a diff hunk, a query, a config block.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | no | Max 120 chars. Usually the file name. |
| `language` | string | no | Max 32 chars. Highlighting hint, e.g. `typescript`, `sql`. |
| `code` | string | yes | Unfenced source. 1–16 000 chars. |

```json
{ "kind": "code", "payload": { "language": "sql", "code": "select symbol, close from bars where date = current_date" } }
```

## alert {#alert}

For one status fact the reader must not miss — a failure, a completed run, a caveat that changes the answer's meaning.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `severity` | enum | yes | `info` — neutral notice. `success` — the thing worked. `warning` — proceed with care. `error` — it failed. Drives icon and tone; the client never uses color alone. |
| `title` | string | no | Max 120 chars. |
| `message` | string | yes | One or two sentences. 1–500 chars. |

```json
{ "kind": "alert", "payload": { "severity": "warning", "message": "Quotes are 20 minutes delayed — intraday levels are indicative." } }
```

## detail {#detail}

For exactly one entity described by labeled fields: a ticket, an order, a config, a single stock's setup.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | yes | 1–120 chars. What this record is. |
| `status` | string | no | Max 40 chars. One short state word, e.g. `open`, `settled`. |
| `fields` | array | yes | 1–12 entries of `{ label, value }`. `label` 1–60 chars, `value` 1–500 chars, both display text. |

```json
{ "kind": "detail", "payload": { "title": "TITAN", "status": "watchlist", "fields": [{ "label": "Entry", "value": "3412" }, { "label": "Stop", "value": "3280" }] } }
```

## item_list {#item-list}

For a set of like things, each with a stable identity: sessions, files, tickets, symbols. One resource shape per list.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | no | Max 120 chars. |
| `items` | array | yes | 1–50 entries. |
| `items[].id` | string | yes | 1–120 chars. A stable identifier, never a URL — the client turns it into a link. |
| `items[].name` | string | yes | 1–200 chars. Primary label. |
| `items[].status` | enum | no | `ok`, `warn`, `error`, `neutral` — rendered as a status dot. |
| `items[].meta` | string | no | Max 200 chars. One short secondary line. |

```json
{ "kind": "item_list", "payload": { "items": [{ "id": "cli:ethos", "name": "cli:ethos", "status": "ok", "meta": "14 messages" }] } }
```

## data_table {#data-table}

For rows sharing the same columns, when the reader compares down a column. Numbers stay numbers so the client can right-align them and use tabular numerals.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | no | Max 120 chars. |
| `caption` | string | no | Max 300 chars. Short note below the table, e.g. the source. |
| `columns` | array | yes | 1–8 entries of `{ key, label, numeric? }`. `key` and `label` 1–60 chars; `numeric: true` right-aligns the column. |
| `rows` | array | yes | Up to 50 objects keyed by `columns[].key`. Cell values are string, number, or null. |
| `totals` | object | no | One summary row, keyed by `columns[].key`. Same cell types. |

```json
{ "kind": "data_table", "payload": { "columns": [{ "key": "sector", "label": "Sector" }, { "key": "flow", "label": "Net flow", "numeric": true }], "rows": [{ "sector": "Pharma", "flow": 412 }] } }
```

## metric_chart {#metric-chart}

For a measured quantity over an ordered axis — time, buckets, categories. Up to four series that share the same axes and unit.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | no | Max 120 chars. |
| `suggestedViz` | enum | no | `line` (default client choice for ordered x), `bar`, `area`, `scatter`. Advisory only — the client decides the final form. |
| `xLabel` | string | no | Max 60 chars. |
| `yLabel` | string | no | Max 60 chars. Include the unit here. |
| `series` | array | yes | 1–4 entries of `{ name, points }`. `name` 1–60 chars. |
| `series[].points` | array | yes | 1–200 ordered `{ x, y }`. `x` is a category label or a numeric/ISO-date position; `y` is a number. |

```json
{ "kind": "metric_chart", "payload": { "yLabel": "Net flow (Cr)", "series": [{ "name": "FII", "points": [{ "x": "2026-08-08", "y": -1240 }, { "x": "2026-08-11", "y": 380 }] }] } }
```

Series beyond four, or points beyond 200, are rejected at the tool rather than truncated — split the answer instead.

## recommend_actions {#recommend-actions}

For the one to three follow-ups that genuinely advance the conversation. Rendered as pills that inject their `prompt` into the composer. Emit it last in a turn, or not at all.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `question` | string | no | Max 200 chars. What the reader is picking between. |
| `actions` | array | yes | 1–3 entries of `{ label, prompt }`. `label` 1–60 chars (pill text); `prompt` 1–500 chars — the exact text injected into the composer. |

```json
{ "kind": "recommend_actions", "payload": { "question": "Next?", "actions": [{ "label": "Size the trade", "prompt": "Size TITAN at 1% portfolio risk." }] } }
```

## canvas {#canvas}

The ninth kind, and the only one `emit_card` cannot produce. `render_ui` emits it for shapes the eight typed kinds cannot express. The HTML runs in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, under a CSP that blocks all network access.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | string | no | Max 120 chars. Heading shown above the frame. |
| `html` | string | yes | Document body. 1–65 536 chars. Supplied inline as `html`, or read from a template file. |
| `data` | unknown | no | Any JSON value, max 32 768 chars serialized. Injected as the frozen global `window.ethosData`. |
| `libraries` | array | no | Up to 4 entries from the allowlist. Only `echarts@1` in spec 1; unknown names are rejected. |

`render_ui` takes `{ title?, html?, template?, data?, libraries? }` and requires exactly one of `html` or `template`. Template mode reads `ui/<template>.html` from the personality's own directory through its `ScopedStorage` boundary and inlines the bytes server-side.

```json
{ "template": "sector-flow", "libraries": ["echarts@1"], "data": { "buckets": ["Mon"], "sectors": ["Banks"], "cells": [{ "sector": "Banks", "bucket": "Mon", "value": 412 }] } }
```

See [Author a Canvas template](../how-to/author-a-canvas-template.md) for the full template contract.

## Refusals {#refusals}

| `ToolResult.code` | When |
|---|---|
| `not_available` | The platform cannot draw cards; or template mode was used with no personality context, an unresolvable personality directory, no `ScopedStorage`, a missing or empty template file, or a template outside the personality's [`fs_reach`](../../getting-started/glossary.md#fs-reach) (the declared filesystem allowlist). |
| `input_invalid` | Unknown `kind`; payload failed schema validation (`field` carries the zod issue path); both or neither of `html`/`template`; a `template` name containing anything but letters, digits, hyphens, underscores; `html`, `data`, or `libraries` over cap. |
| `execution_failed` | The template file exists and is in reach but could not be read. |

## See also {#see-also}

- [Author a Canvas template](../how-to/author-a-canvas-template.md) — the `ui/*.html` contract, end to end.
- [Tool interface](./tool-interface.md) — the `Tool` and `ToolResult` shapes these tools implement.
- [Interactive charts in chat](../../using/how-to/interactive-charts-in-chat.md) — the fenced-chart path, which predates cards and still works.
- [The audience boundary](../explanation/audience-boundary.md) — why surfaces differ in what they show.
