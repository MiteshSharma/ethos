---
name: export-csv
description: Export tabular data as a well-formed CSV file. No installation required — uses write_file only. Always includes a header row, correctly quotes fields containing commas, double-quotes, or newlines, and writes UTF-8. Output is written to the working directory as <slug>.csv.
version: 1.0.0
author: ethosagent
tags: [document, csv, export, data]
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
    invocation_trigger: "user says 'export as CSV', 'save this as CSV', 'download this table as CSV', 'export data to CSV'"
    estimated_turns: "1-2"
---

# Export CSV

Export tabular data as a well-formed CSV file. No installation required — uses `write_file` only. Output is written to the working directory as `<slug>.csv`. Always produces a header row and correctly escapes all field values.

## When to use this skill

- User asks to export data as CSV, save a table as CSV, or download rows as a CSV file.
- User says "give me a CSV", "export this as CSV", "save this table to a file I can open in Excel".
- The data is tabular and the user doesn't need formatting or formulas — just the data.

## When NOT to use this skill

- User needs formulas, multiple sheets, or formatted cells — use `export-excel`.
- User wants a PDF or HTML report — use `make-pdf` or `make-html-report`.
- The data is not tabular (free-form text, nested structures).

## CSV escaping rules

Apply these rules to every field before writing:

| Condition | Rule |
|---|---|
| Field contains a comma (`,`) | Wrap the entire field in double-quotes: `hello, world` → `"hello, world"` |
| Field contains a double-quote (`"`) | Wrap in double-quotes AND escape each inner `"` by doubling it: `say "hi"` → `"say ""hi"""` |
| Field contains a newline (`\n` or `\r\n`) | Wrap the entire field in double-quotes |
| Field contains none of the above | Write as-is — no quotes needed |
| Field is empty | Write as empty string (two consecutive commas: `,,`) — do NOT write `null` or `undefined` |
| Field is a number | Write as-is — no quotes |
| Field is a date | Write in ISO 8601 format: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss` |

The first row is always the header row. Headers follow the same escaping rules.

**Examples:**

```
name,age,city,notes
Alice,30,New York,"Joined in 2024, active user"
Bob,25,London,"Said ""hello"" on first call"
Carol,28,Paris,
```

In the above:
- `"Joined in 2024, active user"` is quoted because it contains a comma.
- `"Said ""hello"" on first call"` is quoted and the inner quotes are doubled.
- Carol's `notes` field is empty — just an empty string at end of line.

## Workflow

**Step 1: Format the data as CSV text**

From the user's data:

1. Identify all columns — these become the header row.
2. Apply escaping rules (table above) to every field value.
3. Assemble rows, one per line, fields separated by `,`.
4. The first line is always the header.
5. Use `\n` (LF) as the line terminator. Do not use `\r\n` unless the user specifically requests Windows line endings.

**Step 2: Write to file**

Use `write_file` to write the complete CSV content to a relative path, which resolves inside the working directory:

```
<slug>.csv
```

Where `<slug>` is a lowercase-hyphenated identifier derived from the data or user's request (e.g. `user-list-2026-06`, `product-inventory`, `q2-transactions`).

Write the file as UTF-8. Do not add a BOM unless the user says they will open it in Excel on Windows (Excel sometimes needs a UTF-8 BOM to detect encoding: `﻿` prepended to the content).

**Step 3: Confirm to the user**

Tell the user:

> "CSV exported to: `<slug>.csv` in the working directory — visible in the Documents tab."

If the file has an unusual number of rows or columns, mention the count:

> "CSV exported to: `<slug>.csv` in the working directory — 3 columns, 42 rows (plus header)."

## Anti-patterns

- **Do not omit the header row** — a CSV without headers is not useful to most consumers.
- **Do not use single quotes** for quoting fields — RFC 4180 specifies double-quotes only.
- **Do not write `null`, `undefined`, or `N/A`** for empty fields unless the user explicitly asks — use an empty string.
- **Do not add trailing commas** at the end of rows.
- **Do not write a BOM by default** — only add it if the user says they need Excel on Windows compatibility.
- **Do not add extra whitespace around commas** — `Alice, 30` is two different values from `Alice,30`.

## Hard rules

- All generated files go to the working directory. Always write a relative path — never write outside the working directory.
- Always tell the user the exact output path after completion.
- The first row must always be the header row.
- Every field containing `,`, `"`, or a newline must be wrapped in double-quotes.
- Every `"` inside a quoted field must be escaped as `""`.
- The slug must be lowercase, hyphen-separated, and contain no spaces or special characters.
