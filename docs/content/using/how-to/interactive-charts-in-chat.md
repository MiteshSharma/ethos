---
title: Interactive charts in chat
description: Give a personality the charts skill so it can answer with a real chart in the web app, and understand the fence, the spec version, and the fallbacks.
kind: how-to
audience: user
slug: interactive-charts-in-chat
time: 10 min
updated: 2026-08-08
---

Ask "which region grew fastest?" and get a chart you can hover, not a table you have to read. The agent writes a fenced block of plain JSON; the web app draws it.

## Task

Give a [personality](../../getting-started/glossary.md#personality) (the directory of files that decides an agent's tools, memory, and model) the `charts` [skill](../../getting-started/glossary.md#skill) (a markdown file that teaches the agent one procedure), so its answers can render as interactive charts in the web app.

## Result

The personality's character sheet names the renderer it may use, and a ```` ```echarts ```` fence in its replies draws a chart in the web app. Everywhere else — the CLI, Telegram, Discord, email — the same message shows the fence as a code block.

## Prereqs

- The web app running (`ethos serve`). Charts render in the SPA; no other surface draws them.
- A personality you can edit, or one of the built-ins.

## 1. Give the personality the charts skill

The skill lives in the bundled library at `skills/document/charts/SKILL.md`. Copy it into the personality's own `skills/` directory:

```bash
mkdir -p ~/.ethos/personalities/<personality-id>/skills
cp skills/document/charts/SKILL.md ~/.ethos/personalities/<personality-id>/skills/charts.md
```

No restart is needed — personality directories are re-read on the next turn.

## 2. Write the fence (or let the agent)

The skill is the source of truth for the format — read `skills/document/charts/SKILL.md` rather than a copy of it here. In short: one fence tagged `echarts`, body is a single JSON object, no JavaScript anywhere.

````
```echarts
{ "title": { "text": "Errors by service" },
  "xAxis": { "type": "category", "data": ["auth", "api"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [12, 31] }] }
```
````

Most of the time you write nothing: the agent has read the skill and emits the fence itself when a comparison, trend, or distribution is easier to see than to read.

## Verify

```bash
ethos personality show <personality-id>
```

The Capabilities section gains one line:

```
## Capabilities
- Renders: echarts@1 (interactive charts — via charts skill)
```

That line and the web app's renderer read the same derivation, so if the line is present the chart will draw. If it is absent, the skill is not in this personality's resolved skill set — check the path and the file's `ethos.renders` block.

Then ask for a chart in the web app:

```
you > chart last quarter's revenue by region
```

The reply renders as a chart in a bordered container. In `ethos chat` the same reply prints the JSON.

## What `echarts@1` actually versions

`echarts@1` names **the Ethos spec version — a documented subset of ECharts options** — not the npm package version. The two move independently:

| Level | Owned by | Changes when |
|---|---|---|
| Spec version (`echarts@1`) | The `charts` skill | A new subset is taught. It is `echarts@2`, never `echarts@1.1` — spec versions are small integers, and the grammar rejects semver on purpose. |
| Library version (`echarts` 6.x) | The web app | The app upgrades its pinned dependency. Skills never notice; the spec-1 subset keeps rendering. |

This is the answer to *why did my chart stop rendering*. An npm upgrade does not break your specs. A spec bump does — and when it happens the skill declares both versions during migration (`renders: ['echarts@1', 'echarts@2']`), and a surface that maps only spec 1 names the mismatch in a one-line notice instead of drawing the wrong picture.

## Why a skill cannot ship a renderer

Skills **declare** a capability; they never **ship** the code that provides it. `ethos.renders: ['echarts@1']` is a claim the surface checks against its own hardcoded registry of first-party, version-pinned, code-split renderers. No JavaScript from any skill directory ever executes in a surface, and nothing in `~/.ethos/` can register a renderer.

The fence body is data, not a program. It is `JSON.parse`d, run through an allowlist filter that strips function-shaped strings, remote references, and markup-bearing values, then handed to the charting library — never evaluated. A renderer name the surface does not map is simply not drawn.

So the worst a hostile skill can do is emit a fence that falls back to a code block. That is the whole blast radius, and it is why installing a third-party skill does not widen your attack surface.

## The fallbacks are the design

Every one of these shows the reader the fence text — the same thing a CLI user sees:

| Situation | What renders |
|---|---|
| Personality lacks the charts skill | Code block |
| The surface has no chart renderer (CLI, Telegram, Discord, email) | Code block |
| Declared spec version the surface does not map (`echarts@2` today) | Code block plus a one-line notice naming both versions |
| Body is not valid JSON, or nothing survives the allowlist filter | Code block |
| The message is still streaming (fence not yet closed) | Code block, upgraded once the fence closes |

None of these is a failure state. A spec written the way the skill teaches — small, titled, with named series — reads as legible content in every one of them. That is why the skill insists on `title.text`.

## When to use `make-chart` instead

Use [`make-chart`](use-skills.md) when the recipient needs an artifact rather than a view: a PNG to attach, an image in an email or a Telegram message, a file on disk for a report. `charts` is for interactive chat surfaces and produces no file. The two skills are complementary; a personality can hold both.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| No `Renders:` line on the character sheet | The skill is not in this personality's resolved skill set | Confirm the file is at `~/.ethos/personalities/<personality-id>/skills/charts.md` and its front-matter has `renders: ['echarts@1']` under `ethos:` |
| Character sheet shows the line, chat shows a code block | Not the web app, or the message predates the skill being added | Charts render only in the SPA; already-rendered messages are not re-rendered when a personality gains the skill |
| Chart draws but colours look wrong | The spec set its own `color` | Omit `color` and let the design tokens theme it; the chart follows light/dark and the active skin |
| Heatmap draws monochrome | `visualMap` is missing | A heatmap needs `visualMap` with `min` and `max` — it is the only series type that requires a companion key |
| Chart briefly appears as a code block, then draws | Expected — the fence upgrades once it closes | Nothing to fix |

## See also

- [Use skills](use-skills.md) — how skills are installed, resolved, and filtered per personality.
- [What is a personality?](../explanation/what-is-a-personality.md) — why output capability derives from the skill set rather than a config field.
- [Personality config reference](../reference/personality-yaml.md) — what does and does not belong on the personality schema.
- [Use the web dashboard](use-web-dashboard.md) — the surface that draws the charts.
