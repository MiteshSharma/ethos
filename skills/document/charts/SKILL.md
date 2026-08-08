---
name: charts
description: Show data as an interactive chart inline in chat by emitting a fenced ```echarts block containing a single pure-JSON ECharts option object. No tools, no files, no install — the chart is the message. Supports bar, line, pie, scatter, and heatmap series against the echarts@1 spec. Surfaces that cannot render it show the JSON as a code block.
version: 1.0.0
author: ethosagent
tags: [document, chart, visualization, interactive, echarts]
required_tools: []

ethos:
  category: document
  renders: ['echarts@1']
  default_personalities: []
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with:
    - skill: make-chart
      role: use instead when the recipient needs a PNG or a file on disk
  surface_metadata:
    invocation_trigger: "user says 'chart this', 'show me a graph', 'plot these numbers', 'visualise this' in an interactive chat surface; agent self-invokes when a comparison, trend, or distribution is easier to see than to read"
    estimated_turns: "1"
---

# Charts

Show data as an interactive chart inline in the conversation. Emit one fenced ` ```echarts ` block containing a single pure-JSON ECharts option object. No tools, no files, no install — the fence is the deliverable.

## When to use this skill

- A **comparison** across categories (revenue by region, errors by service).
- A **trend** over time (weekly signups, latency across releases).
- A **distribution** or relationship (score histogram, price vs. rating).
- The user says "chart this", "plot this", "show me a graph", "visualise this".

Chart when the shape is the point — when seeing it answers a question that reading the numbers does not.

## When NOT to use this skill

- **Two or three numbers.** State them in a sentence. A chart of three bars is a table with extra steps.
- **The recipient needs a file or an image.** Use `make-chart` (Vega-Lite → PNG) — see the comparison below.
- **The data is a lookup, not a shape.** Exact values people will read one at a time belong in a markdown table.
- **The data has no clear chart type.** Ask the user which view they want before emitting anything.

## The fence

One fenced block, language tag `echarts`, body is a single JSON object — the ECharts option. Nothing else inside the fence: no comments, no trailing text, no second object.

````
```echarts
{ "title": { "text": "Errors by service" }, "xAxis": { "type": "category", "data": ["auth", "api"] }, "yAxis": { "type": "value" }, "series": [{ "type": "bar", "data": [12, 31] }] }
```
````

Introduce it in one line of prose before the fence ("Revenue by region:") so the message reads correctly on surfaces that show the JSON instead of the chart.

## Spec 1 — the contract

`echarts@1` is the subset below. It is a contract, not a suggestion: a surface renders only what the spec allows, and strips or falls back on the rest.

| Allowed | Values |
|---|---|
| Series types | `bar`, `line`, `pie`, `scatter`, `heatmap` |
| Data | `dataset` (preferred — `dataset.source` as an array of rows or objects) or inline `series[].data` |
| Top-level keys | `dataset`, `series`, `xAxis`, `yAxis`, `tooltip`, `legend`, `title`, `grid`, `color` |
| Styling | Plain JSON values only — strings, numbers, booleans, arrays, objects |

**No JavaScript anywhere.** No functions, no expressions, no `data.url` or any other remote fetch. Formatter *callbacks* are not spec 1. If you need label formatting, use ECharts' plain-string template form (`"{b}: {c}"`) — that is a JSON string, not code.

Pure JSON is exactly what makes the block safely renderable: the surface runs `JSON.parse` on the fence body and hands the result to its own charting library. It never evaluates it. A spec containing anything that is not data is not rendered — it degrades to a code block.

**Spec versions are ours, not npm's.** `echarts@1` names the Ethos spec version — this documented subset — not the ECharts package version. The surface pins its own library version and may upgrade it without any skill changing. Spec versions are small integers: there is no `echarts@1.1`. A new subset is `echarts@2`.

## Sizing

Omit fixed pixel sizes. No `width`, no `height`, no hard-coded px in `grid`. The surface owns layout and resizes the chart to its container; a fixed size fights it. Percentages and `"containLabel": true` in `grid` are fine.

## Examples

**Bar — complete.** Two series, dataset rows, legend, tooltip:

````
```echarts
{
  "title": { "text": "Revenue by region — Q1 vs Q2 2026" },
  "dataset": {
    "source": [
      ["region", "Q1", "Q2"],
      ["North", 128000, 141000],
      ["South", 94000, 102500],
      ["East", 156000, 149000],
      ["West", 88000, 117000]
    ]
  },
  "xAxis": { "type": "category" },
  "yAxis": { "type": "value", "name": "USD" },
  "tooltip": { "trigger": "axis" },
  "legend": {},
  "grid": { "containLabel": true },
  "series": [
    { "type": "bar", "name": "Q1" },
    { "type": "bar", "name": "Q2" }
  ]
}
```
````

**Line — minimal.** Inline data, one series:

````
```echarts
{
  "title": { "text": "Weekly active users" },
  "xAxis": { "type": "category", "data": ["W1", "W2", "W3", "W4", "W5"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "line", "name": "Active users", "data": [820, 932, 901, 1290, 1330] }]
}
```
````

## Graceful degradation

A surface that cannot render the fence — CLI, Telegram, email, an older client — shows the JSON as a code block. That is the designed fallback, not a failure. Write every spec so it survives it:

- **Always set `title.text`.** It is the one line that tells a reader what they are looking at.
- **Keep specs small.** A screenful of data points, not a thousand. Large inline arrays are unreadable as text and slow to render.
- **Name things.** `series[].name`, `yAxis.name`, and dataset header rows make the raw JSON self-describing.

## `charts` vs `make-chart`

Complementary, not competing. Both are current.

| Use `charts` | Use `make-chart` |
|---|---|
| Interactive chat surfaces (web, desktop) | The recipient needs a PNG or a file on disk |
| The chart is the message — inline, no artifacts | Email, or any non-interactive surface |
| Zero tools, one turn | The image goes into a document, report, or attachment |

If the user might want both, say so and ask — do not emit a fence and a PNG for the same data by default.

## Anti-patterns

- **Do not put a function in the JSON.** Not as a value, not as a string that looks like one. It will be stripped or the whole block will fall back.
- **Do not set `width` or `height`.** The surface sizes the chart.
- **Do not use `data.url` or any remote reference.** All data is inline.
- **Do not emit more than one JSON object per fence**, and do not wrap the option in an extra key.
- **Do not use a series type outside spec 1.** Unknown types do not render.
- **Do not chart three numbers.** Say them.

## Hard rules

- The fence language tag is exactly `echarts`.
- The fence body is one JSON object and nothing else — it must satisfy `JSON.parse`.
- Only the spec-1 keys and series types above.
- Every spec sets `title.text`.
- Data is always inline. Never a URL, never a file path.
