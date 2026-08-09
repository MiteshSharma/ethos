---
name: make-html-report
description: Generate a self-contained HTML report file with all CSS inline in a <style> block and no external dependencies. Uses write_file only — no CLI tools required. Output is a single .html file written to the working directory as <slug>.html that can be opened directly in any browser.
version: 1.0.0
author: ethosagent
tags: [document, html, report, export]
required_tools: [write_file]

ethos:
  category: document
  default_personalities: []
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with: []
  surface_metadata:
    invocation_trigger: "user says 'generate an HTML report', 'create a web report', 'export as HTML', 'make a formatted report I can open in a browser'"
    estimated_turns: "1-2"
---

# Make HTML Report

Generate a self-contained HTML report with inline CSS. No installation required — this skill uses `write_file` only. The output is a single `.html` file written to the working directory as `<slug>.html` that opens in any browser without internet access.

## When to use this skill

- User asks for an HTML report, a web-based report, a formatted report to open in a browser, or an export they can view locally.
- User says "make an HTML version of this", "I want to open this in a browser", "generate a report page".
- User needs a document with tables, sections, and readable formatting but does not need PDF.

## When NOT to use this skill

- User explicitly wants a PDF — use `make-pdf`.
- User wants a spreadsheet — use `export-excel` or `export-csv`.
- User wants a chart — use `make-chart` (optionally embed the PNG in the HTML report afterward).
- The output needs to be emailed as an attachment where PDF is more appropriate.

## HTML template contract

All reports must:

1. Use a single `<style>` block in `<head>` — no external stylesheets, no CDN links.
2. Use CSS variables for theming (see palette below).
3. Be responsive (`max-width: 960px; margin: 0 auto` on the body or a wrapper).
4. Include a `<meta charset="UTF-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1.0">`.
5. Include a `<title>` matching the report name.

### Colour palette (CSS variables)

```css
:root {
  --accent:   #2563eb;  /* primary blue — links, headings, borders */
  --bg:       #f8fafc;  /* page background */
  --surface:  #ffffff;  /* card / table background */
  --text:     #1e293b;  /* body text */
  --muted:    #64748b;  /* secondary text, captions */
  --border:   #e2e8f0;  /* dividers, table borders */
  --success:  #16a34a;  /* positive values */
  --danger:   #dc2626;  /* negative values, errors */
}
```

### Minimal starter template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Report Title</title>
  <style>
    :root {
      --accent:  #2563eb;
      --bg:      #f8fafc;
      --surface: #ffffff;
      --text:    #1e293b;
      --muted:   #64748b;
      --border:  #e2e8f0;
      --success: #16a34a;
      --danger:  #dc2626;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      background: var(--bg);
      padding: 32px 16px;
    }
    .wrapper { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 24px; color: var(--accent); margin-bottom: 4px; }
    h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .meta { color: var(--muted); font-size: 12px; margin-bottom: 32px; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    td { border: 1px solid var(--border); padding: 8px 12px; }
    tr:nth-child(even) td { background: var(--bg); }
    .positive { color: var(--success); font-weight: 600; }
    .negative { color: var(--danger); font-weight: 600; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      background: #dbeafe;
      color: var(--accent);
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <h1>Report Title</h1>
    <p class="meta">Generated <!-- date --></p>

    <div class="card">
      <h2>Section</h2>
      <!-- content -->
    </div>
  </div>
</body>
</html>
```

## Workflow

**Step 1: Design the report structure**

From the user's content, identify:
- Report title and generation date.
- Sections (one `<div class="card">` per logical section).
- Tables (rows and columns).
- Any numeric values that need positive/negative colouring (use `.positive` / `.negative` classes).

**Step 2: Write the HTML file**

Use `write_file` to write the complete HTML to a relative path, which resolves inside the working directory:

```
<slug>.html
```

Where `<slug>` is a lowercase-hyphenated identifier derived from the report title (e.g. `q2-summary`, `onboarding-checklist`).

Write the complete document in one pass — do not write partial HTML and patch it.

**Step 3: Confirm to the user**

Tell the user:

> "HTML report created at: `<slug>.html` in the working directory — visible in the Documents tab.
> Open it in any browser — no internet connection needed."

## Anti-patterns

- **Do not link to external CSS frameworks** (Bootstrap, Tailwind CDN) — the file must be self-contained.
- **Do not use JavaScript** unless the user explicitly asks for interactivity — keep reports static.
- **Do not use inline `style=` attributes** for anything the CSS classes already cover — use the defined classes.
- **Do not omit the `<meta charset="UTF-8">`** — non-ASCII characters (accented letters, currency symbols) will render incorrectly without it.
- **Do not deviate from the colour palette** without a user request — consistency across reports matters.

## Hard rules

- All generated files go to the working directory. Always write a relative path — never write outside the working directory.
- Always tell the user the exact output path and that they can open it in any browser.
- All CSS must be inline in a single `<style>` block — no `<link>` tags, no CDN, no `@import url(...)`.
- Always include `<meta charset="UTF-8">` and a descriptive `<title>`.
- The slug must be lowercase, hyphen-separated, and contain no spaces or special characters.
