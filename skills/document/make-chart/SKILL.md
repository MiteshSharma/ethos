---
name: make-chart
description: Render a Vega-Lite JSON specification to a PNG chart image using the vl2png command from the vega-cli package. Write the spec to <slug>-spec.json in the working directory, install vega-cli and vega-lite if missing, then run vl2png at 2x scale. Supports bar, line, point, area, and other Vega-Lite v5 mark types.
version: 1.0.0
author: ethosagent
tags: [document, chart, visualization, png, vega-lite]
required_tools: [terminal, write_file]

ethos:
  external_cli_alternatives:
    - vl2png
  category: document
  default_personalities: []
  prerequisites:
    external_cli: [vl2png]
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with: []
  surface_metadata:
    invocation_trigger: "user says 'create a chart', 'plot this data', 'generate a bar/line/pie chart', 'visualise this as a PNG'"
    estimated_turns: "2-4"
---

# Make Chart

Render a Vega-Lite JSON specification to a PNG chart image. Write the spec to `<slug>-spec.json`, then run `vl2png` to produce a PNG at `<slug>.png` — both relative paths, resolved inside the working directory. Supports bar, line, point, area, and any other Vega-Lite v5 mark type.

## When to use this skill

- User asks to create a chart, plot data, generate a bar chart / line chart / scatter plot / area chart, or visualise data as an image.
- User wants a PNG or image of a chart to embed in a document or share.
- User says "visualise this", "chart this", "make a graph of this data".

## When NOT to use this skill

- User wants an interactive chart (use an HTML file with Vega-Embed instead).
- User wants a PDF or HTML report — use `make-pdf` or `make-html-report`.
- The data doesn't have a clear chart type — ask the user which type they want before proceeding.
- User wants a pie chart: Vega-Lite uses `"mark": "arc"` with `theta` encoding for pie/donut charts — still valid, but confirm the user is aware it's a donut by default.

## Vega-Lite spec format

Vega-Lite v5 specs are JSON objects. The minimal structure:

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "width": 600,
  "height": 400,
  "data": {
    "values": [
      { "category": "A", "value": 42 },
      { "category": "B", "value": 28 },
      { "category": "C", "value": 61 }
    ]
  },
  "mark": "bar",
  "encoding": {
    "x": { "field": "category", "type": "nominal", "axis": { "labelAngle": 0 } },
    "y": { "field": "value", "type": "quantitative" },
    "color": { "field": "category", "type": "nominal" }
  }
}
```

Common mark types: `"bar"`, `"line"`, `"point"`, `"area"`, `"arc"` (pie/donut), `"rule"`, `"text"`.

Field types: `"quantitative"` (numbers), `"nominal"` (categories), `"ordinal"` (ordered categories), `"temporal"` (dates).

For a line chart, use `"mark": "line"` and set `"x"` to a temporal or ordinal field:

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "width": 600,
  "height": 400,
  "data": {
    "values": [
      { "month": "2026-01", "revenue": 12000 },
      { "month": "2026-02", "revenue": 15400 },
      { "month": "2026-03", "revenue": 11800 }
    ]
  },
  "mark": { "type": "line", "point": true },
  "encoding": {
    "x": { "field": "month", "type": "ordinal" },
    "y": { "field": "revenue", "type": "quantitative", "title": "Revenue ($)" }
  }
}
```

## Workflow

**Step 1: Write the Vega-Lite spec**

Construct the spec from the user's data and chart request. Use `write_file` to write it to a relative path, which resolves inside the working directory:

```
<slug>-spec.json
```

Where `<slug>` is a lowercase-hyphenated identifier derived from the user's request (e.g. `monthly-revenue`, `category-breakdown`).

Always set `"width"` and `"height"` explicitly. A good default is `600 x 400`. For wide charts (many categories), use `800 x 400`.

**Step 2: Check if `vl2png` is installed**

```bash
which vl2png 2>/dev/null || echo "not found"
```

**Step 3a: If found — proceed to Step 4.**

**Step 3b: If not found — attempt install**

```bash
npm install -g vega-cli vega-lite
```

If the install fails (no npm, no network, permission denied), stop and tell the user:

> "This skill requires vega-cli. Run: `npm install -g vega-cli vega-lite`
> If npm is unavailable, ask your system administrator to install it."

Do not proceed further.

**Step 4: Render the PNG**

```bash
vl2png <slug>-spec.json <slug>.png --scale 2
```

The command runs with the working directory as its cwd, so both relative paths resolve there.

`--scale 2` doubles the resolution for crisp rendering on high-DPI displays.

**Step 5: Confirm to the user**

Tell the user:

> "Chart created at: `<slug>.png` in the working directory — visible in the Documents tab."

## Anti-patterns

- **Do not omit `$schema`** — `vl2png` may default to an older schema version and produce incorrect output.
- **Do not pass URLs as `data.url`** — `vl2png` runs locally and cannot fetch remote data. Always use `data.values` with inline data.
- **Do not omit `width` and `height`** — default sizes are small and produce low-quality PNGs.
- **Do not use `--scale 1`** — the output will look blurry on most screens; `--scale 2` is the minimum for quality output.
- **Do not use mark types not in Vega-Lite v5** — check the spec before writing it.

## Hard rules

- All generated files go to the working directory. Always write a relative path — never write outside the working directory.
- Always tell the user the exact output path after completion.
- If `vl2png` install fails, show the fallback message verbatim — do not proceed.
- Always use `data.values` (inline data) in the spec — never `data.url`.
- The slug must be lowercase, hyphen-separated, and contain no spaces or special characters.
