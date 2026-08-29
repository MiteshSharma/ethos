---
title: "Author a Canvas template"
description: "Write a ui/*.html Canvas template a personality renders with render_ui — the data global, theme variables, library allowlist, CSP limits, and caps."
kind: how-to
audience: developer
slug: author-a-canvas-template
time: "15 min"
updated: 2026-08-11
---

## Task

Write a Canvas template — an HTML file in a [personality's](../../getting-started/glossary.md#personality) own directory (the folder of files that decides its tools, memory, and model) — and render it with `render_ui({ template, data })`.

Reach for Canvas only when the shape does not fit one of the eight typed card kinds. A series is a `metric_chart`; rows are a `data_table`; one record is a `detail`. Canvas is for the rest — a diverging flow matrix, a bespoke brief, a layout only your domain needs. See the [card catalog](../reference/card-catalog.md) first.

## Result

`render_ui({ template: "sector-flow", data })` draws a diverging sector-flow matrix in the web chat, themed to the reader's skin, sized automatically, with no network access of any kind.

## Prereqs

- A personality directory at `~/.ethos/personalities/<personality-id>/` containing `SOUL.md`.
- `render_ui` listed in that personality's `toolset.yaml`.
- The web or desktop surface. Channel adapters drop the `ui` toolset by design.

## Steps

### 1. Put the file where `render_ui` looks

Templates live in `ui/` inside the personality's own directory — alongside `SOUL.md`, not in the asset folder:

```bash
mkdir -p ~/.ethos/personalities/<personality-id>/ui
cp examples/canvas-templates/sector-flow.html ~/.ethos/personalities/<personality-id>/ui/
ls ~/.ethos/personalities/<personality-id>/ui/
```

```
sector-flow.html
```

The file name minus `.html` is the `template` argument. Names may contain letters, digits, hyphens, and underscores only — anything else is rejected before a path is ever joined.

`render_ui` reads the file server-side through the personality's `ScopedStorage` and ships the bytes inside the card envelope, so the browser never touches your filesystem and one personality cannot read another's templates.

### 2. Open with the catalog description

The first HTML comment in the file is what the agent sees when it decides whether to use the template. The scanner takes the first line, trimmed, capped at 160 characters:

```html
<!-- Diverging money-flow matrix: sectors down one axis, time buckets across, each cell colored by net flow from outflow through neutral to inflow. -->
```

The catalog is scanned once, at composition time, and injected into the static prompt prefix. A template added or edited on disk appears on the next turn.

### 3. Read the data from `window.ethosData`

The `data` argument arrives as a deep-frozen global. Keep the markup static and the data per-turn — the template ships once, `data` changes every call:

```html
<script>
(function () {
  var data = window.ethosData;
  if (!data || typeof data !== 'object') {
    document.getElementById('sector-flow').textContent = 'No data.';
    return;
  }
  // ...
})();
</script>
```

Handle the absent and malformed cases explicitly. Someone will open the file directly in a browser, and a model will eventually pass the wrong shape. A blank frame is a bug report; a one-line "no data" message is an answer.

Document the shape you expect in a comment, so the next author — human or model — has it:

```js
/*
 *   {
 *     "unit": "Cr",
 *     "buckets": ["Mon", "Tue"],
 *     "sectors": ["Banks", "IT"],
 *     "cells": [{ "sector": "Banks", "bucket": "Mon", "value": 412 }]
 *   }
 */
```

### 4. Take every color from the theme variables

The host injects the resolved skin as CSS custom properties. Read them; never hardcode a hex value, because a hardcoded color is wrong in one of the two themes.

| Variable | What it is |
|---|---|
| `--ethos-bg`, `--ethos-bg-elevated`, `--ethos-bg-overlay` | Surface backgrounds, base through overlay. |
| `--ethos-border`, `--ethos-border-strong` | Default and emphasized borders. |
| `--ethos-text`, `--ethos-text-dim`, `--ethos-text-tertiary` | Body, de-emphasized, and muted text. |
| `--ethos-success`, `--ethos-warning`, `--ethos-error`, `--ethos-info` | Semantic colors. Status only, never decoration, and never color alone. |
| `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full` | The radius scale, in pixels. |
| `--ethos-font`, `--ethos-font-mono` | The display and monospace stacks. |

In CSS, use them directly. For a library that wants a color value, read the computed property:

```js
var css = getComputedStyle(document.documentElement);
var inflow = css.getPropertyValue('--ethos-success').trim();
```

An empty string back means the template is not running inside a Canvas frame. `sector-flow.html` treats that as another degraded case and renders its message instead of a mis-colored chart.

### 5. Let the host size the frame

Height is automatic. The host injects a `ResizeObserver` on `document.body` that reports `document.documentElement.scrollHeight` back over `postMessage`. Give your content a real height and do nothing else — no height protocol to implement, no manual resize call.

Charts are the one case that needs a number, because a chart canvas has no intrinsic height. Derive it from the data:

```js
root.style.height = sectors.length * 34 + 108 + 'px';
```

### 6. Request a library, if you need one

`libraries` is a versioned allowlist bundled locally by the web app. Spec 1 ships one entry:

| Name | Global | Registered surface |
|---|---|---|
| `echarts@1` | `echarts` | Series: bar, line, pie, scatter, heatmap. Components: dataset, grid, legend, title, tooltip, visualMap. |

Pass it on the call — `render_ui({ template: "sector-flow", libraries: ["echarts@1"], data })` — and the source is prepended inline before your markup. Unknown names are rejected at the tool. There is no CDN, by design.

Many templates need no library at all. The swing-trader `market-brief.html` is plain DOM: `document.createElement` plus `textContent`, no dependency.

### 7. Stay inside the CSP

The frame runs with `sandbox="allow-scripts"` and no `allow-same-origin` — an opaque origin, no cookies, no storage, no reach into the page around it. On top of that:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;
```

| Forbidden | Why |
|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` | `default-src 'none'` — a template cannot phone home. Everything it shows must arrive in `data`. |
| Remote scripts, stylesheets, fonts, images | Same fallback. Fonts are deliberately absent: the frame renders in the stack `--ethos-font` names. Images must be `data:` URIs. |
| `eval`, `new Function` | `script-src` carries no `'unsafe-eval'`. |
| Nonces and hashes | Deliberately not shipped — adding one would disable `'unsafe-inline'` and break every template. |

Inline `<style>`, `style=` attributes, and inline `<script>` all work. That is the whole surface.

### 8. Respect the caps

| Cap | Limit |
|---|---|
| `html` (inline or resolved template) | 65 536 chars |
| `data`, serialized | 32 768 chars |
| `libraries` | 4 entries |
| `title` | 120 chars |

Inline `html` is for one-off shapes the model composes on the spot. A template is the durable form: it is reviewed, it is versioned with the personality, and it costs no prompt tokens per turn.

## Verify

Call the tool from a chat turn on the web surface:

```
render_ui({ template: "sector-flow", libraries: ["echarts@1"], data: { "unit": "Cr", "buckets": ["Mon","Tue"], "sectors": ["Banks","IT"], "cells": [{"sector":"Banks","bucket":"Mon","value":412}] } })
```

```
rendered canvas
```

The frame appears in the turn, themed to your skin, sized to its content. Switch the app between dark and light: every color follows, and nothing in the frame is a fixed hex.

## Troubleshoot

**`Canvas template "<name>" is outside this personality's fs_reach.`**

A declared [`fs_reach.read`](../../getting-started/glossary.md#fs-reach) list (the personality's filesystem allowlist) *replaces* the defaults rather than extending them — so declaring any read path drops the personality's own directory out of reach, and template mode is refused. Add it back. `config.yaml` is flat `key: value`, and `fs_reach.read` is a comma-separated list:

```yaml
fs_reach.read: /tmp/, ${ETHOS_HOME}/personalities/${self}/
```

`${ETHOS_HOME}` and `${self}` are substituted at turn construction. A personality that declares no `fs_reach.read` at all already has its own directory in the defaults and needs no change.

**`Canvas template "<name>" is missing or empty`**

The error names the exact path it tried. Check the file is under `ui/`, ends in `.html`, and is non-empty.

**`Cards render on the web surface; answer in prose here.`**

The turn ran on a channel or the CLI. Both `ui` tools refuse off-surface, and the composition rules are not injected there either.

**The frame renders but the colors are wrong in one theme**

A hardcoded hex slipped in. Grep the template for `#` followed by hex digits; every color belongs to a `--ethos-*` variable.

**The frame is blank**

Open the template file directly in a browser. If it shows a "no data" message, the degraded path works and the problem is the `data` argument. If it shows nothing, the template throws before it renders — its script has no guard around the absent-global case.
