# Canvas template examples

Canvas is the escape hatch for shapes the eight typed card kinds cannot express — a diverging flow matrix, a bespoke scorecard, a layout only your domain needs. A personality authors the HTML once, then calls `render_ui({ template, data })` with fresh data every turn.

| Example | What it renders |
|---|---|
| [`sector-flow.html`](./sector-flow.html) | Diverging money-flow matrix — sectors down one axis, time buckets across, each cell colored from outflow through neutral to inflow. |

## How to use one

```bash
mkdir -p ~/.ethos/personalities/<personality-id>/ui
cp examples/canvas-templates/sector-flow.html ~/.ethos/personalities/<personality-id>/ui/
```

Add `render_ui` to that personality's `toolset.yaml`. On the next turn the agent sees `sector-flow` in its template catalog and can call:

```json
{ "template": "sector-flow", "libraries": ["echarts@1"], "data": { "buckets": ["Mon", "Tue"], "sectors": ["Banks", "IT"], "cells": [{ "sector": "Banks", "bucket": "Mon", "value": 412 }] } }
```

## The authoring contract

| Rule | Detail |
|---|---|
| **Location** | `<personality-dir>/ui/<name>.html`. The name is the `template` argument — letters, digits, hyphens, underscores, no extension. |
| **Inlining** | `render_ui` reads the file server-side through the personality's storage boundary and ships the bytes inside the card envelope. The browser never touches your filesystem. |
| **Data** | `render_ui({ data })` arrives as the deep-frozen global `window.ethosData`. Keep markup and data separate — the template is static, the data is per-turn. |
| **Theme** | Skin tokens are injected as CSS custom properties: `--ethos-bg`, `--ethos-bg-elevated`, `--ethos-bg-overlay`, `--ethos-border`, `--ethos-border-strong`, `--ethos-text`, `--ethos-text-dim`, `--ethos-text-tertiary`, `--ethos-success`, `--ethos-warning`, `--ethos-error`, `--ethos-info`, `--radius-*`, plus `--ethos-font` and `--ethos-font-mono`. Read them, never hardcode hex — a hardcoded color is wrong in one of the two themes. |
| **Height** | Automatic. An injected `ResizeObserver` reports `document.documentElement.scrollHeight` to the host. Give your content a real height; do nothing else. |
| **Libraries** | Allowlist only, bundled locally: `echarts@1`. Request it via `render_ui({ libraries: ["echarts@1"] })` and it is prepended inline as the global `echarts`. |
| **CSP** | `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;` — no fetch, no XHR, no WebSocket, no remote scripts, stylesheets, fonts or images, no `eval` or `new Function`. Everything the template needs must be in the HTML, an allowlisted library, or `data`. |
| **Caps** | `html` ≤ 65 536 chars, `data` ≤ 32 768 chars serialized, `libraries` ≤ 4 entries. |
| **Catalog description** | The template's first HTML comment (first line, ≤160 chars) is what the agent sees in its template catalog. Write one useful sentence. |

Two things a template must handle, because both happen:

- **`window.ethosData` absent or malformed.** Someone will open the file directly, and a model will eventually pass the wrong shape. Render a plain "no data" message instead of throwing.
- **A personality that declares `fs_reach.read`.** A declared read list *replaces* the defaults, so the personality's own directory drops out of reach and template mode is refused. Add `${ETHOS_HOME}/personalities/${self}/` back to the list.

## Long version

[Author a Canvas template](https://ethosagent.ai/docs/building/how-to/author-a-canvas-template) — the full contract, with `sector-flow.html` as the worked example. For the typed cards you should reach for first, see the [card catalog](https://ethosagent.ai/docs/building/reference/card-catalog).
