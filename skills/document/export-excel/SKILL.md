---
name: export-excel
description: Export structured tabular data to an Excel .xlsx file using a Node.js script and the exceljs library. The skill writes a generator script to gen-excel.js in the working directory, installs exceljs locally under ~/.ethos/tools if needed, then runs the script to produce the workbook. Handles multiple sheets, column headers, and typed cell values.
version: 1.0.0
author: ethosagent
tags: [document, excel, xlsx, export, data]
required_tools: [terminal, write_file]

ethos:
  external_cli_alternatives:
    - node
  category: document
  default_personalities: []
  prerequisites:
    external_cli: [node]
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with: []
  surface_metadata:
    invocation_trigger: "user says 'export to Excel', 'save as xlsx', 'create a spreadsheet', 'export this table to Excel'"
    estimated_turns: "3-5"
---

# Export Excel

Export structured tabular data to an Excel `.xlsx` file. A Node.js script using `exceljs` is written to a temp path, `exceljs` is installed locally if missing, and the script is run to produce the workbook. Output is written to the working directory as `<filename>.xlsx`.

## When to use this skill

- User asks to export data to Excel, save as `.xlsx`, create a spreadsheet, or produce a file they can open in Excel or Google Sheets.
- The data is tabular (rows and columns) — query results, lists, comparison tables, reports.
- User says "I need an Excel file", "export this as a spreadsheet", "make an xlsx".

## When NOT to use this skill

- User wants CSV — use the `export-csv` skill (simpler, no installation needed).
- User wants a PDF or HTML report — use `make-pdf` or `make-html-report`.
- The data is not tabular (free-form prose, charts only).
- User wants formulas or charts in the workbook — this skill produces data-only workbooks; complex Excel features are out of scope.

## Workflow

**Step 1: Check that Node.js is available**

```bash
which node 2>/dev/null || echo "not found"
```

If not found, stop and tell the user:

> "This skill requires Node.js. Install it from https://nodejs.org, then try again."

Do not proceed further.

**Step 2: Create the tools directory**

```bash
mkdir -p ~/.ethos/tools
```

**Step 3: Write the generator script**

Use `write_file` to write a Node.js script to the relative path `gen-excel.js`, which resolves inside the working directory. The script should:

- Embed the data directly (as a JavaScript object literal).
- Use `exceljs` to create a workbook with one sheet per logical table.
- Set column headers from the data keys.
- Write each row of data.
- Save to the relative path `<filename>.xlsx`.

Minimal script template:

```js
const ExcelJS = require('exceljs');

async function main() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');

  // Set headers
  sheet.columns = [
    { header: 'Column A', key: 'colA', width: 20 },
    { header: 'Column B', key: 'colB', width: 20 },
  ];

  // Add rows
  const rows = [
    { colA: 'value1', colB: 'value2' },
  ];
  rows.forEach(row => sheet.addRow(row));

  await workbook.xlsx.writeFile('<filename>.xlsx');
  console.log('Done');
}

main().catch(err => { console.error(err); process.exit(1); });
```

Replace `<filename>` with a lowercase-hyphenated slug derived from the user's request (e.g. `sales-data-2026-06`). Embed the actual data in the `rows` array.

**Step 4: Check if `exceljs` is available**

```bash
node -e "require('exceljs')" 2>/dev/null || echo "not found"
```

If not found, install it locally:

```bash
npm install exceljs --prefix ~/.ethos/tools
```

If install fails (no npm, no network, permission denied), stop and tell the user:

> "This skill requires the exceljs npm package. Run: `npm install exceljs --prefix ~/.ethos/tools`
> If npm is unavailable, ask your system administrator to install it."

Do not proceed further.

**Step 5: Run the generator script**

```bash
NODE_PATH=~/.ethos/tools/node_modules node gen-excel.js
```

**Step 6: Confirm to the user**

Tell the user:

> "Excel file created at: `<filename>.xlsx` in the working directory — visible in the Documents tab."

## Anti-patterns

- **Do not install `exceljs` globally** — use `--prefix ~/.ethos/tools` to keep it isolated and avoid permission issues.
- **Do not use an absolute output path in the script** — write to a bare relative filename so the workbook lands in the working directory.
- **Do not write a generic script and ask the user to fill in the data** — embed the actual data in the script before running it.
- **Do not produce an empty workbook** — always include at least a header row.
- **Do not reuse a stale `gen-excel.js`** from a previous run without overwriting it with the current data.

## Hard rules

- All generated files go to the working directory. Always write a relative path — never write the `.xlsx` outside the working directory.
- Always tell the user the exact output path after completion.
- If `node` is not installed, show the fallback message verbatim — do not proceed.
- If `exceljs` install fails, show the fallback message verbatim — do not proceed.
- The filename slug must be lowercase, hyphen-separated, and contain no spaces or special characters.
