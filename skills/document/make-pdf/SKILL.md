---
name: make-pdf
description: Convert Markdown or HTML content to a PDF file using md-to-pdf. Writes content to a temp Markdown file in the working directory, then runs md-to-pdf to produce a PDF alongside it. Output is A4 with standard margins. Useful for generating reports, summaries, or any document the user wants to print or share as a PDF.
version: 1.0.0
author: ethosagent
tags: [document, pdf, export, markdown]
required_tools: [terminal, write_file]

ethos:
  external_cli_alternatives:
    - md-to-pdf
  category: document
  default_personalities: []
  prerequisites:
    external_cli: [md-to-pdf]
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with: []
  surface_metadata:
    invocation_trigger: "user says 'generate a PDF', 'export as PDF', 'save this as a PDF', 'create a PDF report'"
    estimated_turns: "2-4"
---

# Make PDF

Convert Markdown or HTML content to a PDF file. The content is written to a temp Markdown file and rendered to PDF via `md-to-pdf`. Output lands in the working directory as `<slug>.pdf`.

## When to use this skill

- User asks to generate a PDF, export content as PDF, save a report as PDF, or create a printable document.
- User has a Markdown or HTML document and wants a portable, shareable PDF version.
- User says "make this into a PDF", "PDF of this summary", or "I want to send this as a PDF".

## When NOT to use this skill

- User wants an HTML report — use the `make-html-report` skill instead.
- User wants a spreadsheet — use `export-excel` or `export-csv`.
- User already has a PDF and wants to read or modify it — this skill only creates PDFs from Markdown/HTML.
- The content isn't prose or structured text (e.g. raw binary data).

## Workflow

**Step 1: Write the content to a temp Markdown file**

Use `write_file` to write the Markdown content to a relative path, which resolves inside the working directory:

```
<slug>.md
```

Where `<slug>` is a short, descriptive, lowercase-hyphenated identifier for the document (e.g. `weekly-report-2026-06`, `project-summary`). Do not use spaces or special characters.

**Step 2: Check if `md-to-pdf` is installed**

```bash
which md-to-pdf 2>/dev/null || echo "not found"
```

**Step 3a: If found — proceed to Step 4.**

**Step 3b: If not found — attempt install**

```bash
npm install -g md-to-pdf
```

If the install fails (no npm, no network, permission denied), stop and tell the user:

> "This skill requires md-to-pdf to be installed. Run: `npm install -g md-to-pdf`
> If npm is unavailable, ask your system administrator to install it."

Do not proceed further.

**Step 4: Convert to PDF**

```bash
md-to-pdf <slug>.md --pdf-options '{"format":"A4","margin":{"top":"20mm","bottom":"20mm","left":"15mm","right":"15mm"}}'
```

`md-to-pdf` writes the output file alongside the input file, replacing `.md` with `.pdf`. The output path is:

```
<slug>.pdf
```

**Step 5: Confirm to the user**

Tell the user:

> "PDF created at: `<slug>.pdf` in the working directory — visible in the Documents tab."

## Anti-patterns

- **Do not guess a slug** — derive it from the document title or user's request. If the user says "generate a PDF of the Q2 report", the slug is `q2-report`.
- **Do not write the Markdown to an absolute path** — a bare relative path is what puts it in the working directory; anywhere else is outside the personality's write reach.
- **Do not embed absolute paths in the Markdown content** — use relative references or inline all images as base64 if the PDF needs them.
- **Do not attempt conversion on empty or near-empty Markdown** — add meaningful content before invoking `md-to-pdf`.

## Hard rules

- All generated files go to the working directory. Always write a relative path — never write outside the working directory.
- Always tell the user the exact output path after completion.
- If `md-to-pdf` install fails, show the fallback message verbatim — do not proceed.
- The slug must be lowercase, hyphen-separated, and contain no spaces or special characters.
