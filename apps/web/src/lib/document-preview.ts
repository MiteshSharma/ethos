// How a workdir file is previewed — extension → renderer, and the size ceiling
// that decides whether the bytes are fetched at all.
//
// Pure on purpose: the modal is a thin shell over these decisions, so the
// dispatch and the cap are testable without mounting anything.
//
// SECURITY: everything this file classifies is AGENT-WRITTEN and untrusted —
// treat it exactly as content pulled off the internet. The kind returned here
// is what picks the renderer, and two of the choices are load-bearing:
//   • `html` renders in a sandboxed iframe (no `allow-same-origin`), never
//     in-origin via `dangerouslySetInnerHTML`.
//   • `.svg` is an `image`, drawn through `<img>`. `<img>` does not execute
//     scripts inside an SVG; inlining the markup into the DOM would.

/** The renderer a previewable file maps to. */
export type DocumentPreviewKind = 'markdown' | 'html' | 'image' | 'pdf' | 'csv' | 'text';

export type DocumentPreviewPlan =
  /** Fetch the bytes: `text` for `res.text()`, `blob` for an object URL. */
  | { status: 'ready'; kind: DocumentPreviewKind; as: 'text' | 'blob' }
  /** Skip the fetch — the file is past the ceiling. Download is still offered. */
  | { status: 'too-large'; kind: DocumentPreviewKind; limitBytes: number }
  /** No renderer for this type, or no size to bound the fetch with. */
  | { status: 'unsupported' };

/**
 * Ceiling for anything that becomes DOM — markdown, HTML, CSV, code.
 *
 * 2 MiB of text is roughly 40k lines. The binding cost is not the transfer,
 * it is turning those bytes into nodes: react-markdown's AST, a CSV table, or
 * one enormous `<pre>` all run on the main thread and jank the tab well before
 * the network does. Past this the operator wants the file on their machine,
 * not in a modal.
 */
export const TEXT_PREVIEW_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Ceiling for images and PDFs.
 *
 * Higher than the text ceiling because the bytes never become DOM — they go to
 * the browser's native image decoder or its PDF viewer, off the main thread.
 * Here the constraint is only transfer and memory, and an agent-produced chart
 * or scanned report routinely clears 2 MiB. 16 MiB still refuses the
 * multi-hundred-megabyte artifact this cap exists for.
 */
export const BINARY_PREVIEW_LIMIT_BYTES = 16 * 1024 * 1024;

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const HTML_EXTS = new Set(['.html', '.htm']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/**
 * Text-ish types are an ALLOWLIST, not a fallback. Defaulting unknown
 * extensions to text would fetch an `.mp4` and paint it as mojibake; "no
 * preview" is the honest answer for a type we do not know how to draw.
 */
const TEXT_EXTS = new Set([
  '.txt',
  '.log',
  '.json',
  '.jsonl',
  '.ndjson',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.xml',
  '.css',
  '.scss',
  '.diff',
  '.patch',
  '.tsv',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
]);

/**
 * Lowercased extension including the dot, or `''` when there is none.
 *
 * `lastIndexOf('.') <= 0` covers both "no dot at all" and a dotfile like
 * `.env`, whose leading dot is not an extension.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/** The renderer for a filename, or `null` when nothing here can draw it. */
export function documentPreviewKind(name: string): DocumentPreviewKind | null {
  const ext = extensionOf(name);
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (HTML_EXTS.has(ext)) return 'html';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.csv') return 'csv';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

/**
 * What the modal should do for this entry, decided BEFORE any request — the
 * listing already carries `size`, so an oversized file never costs a fetch.
 *
 * A missing `size` means the entry could not be stat'd (see the contract's
 * `DocumentEntrySchema`). With no size there is nothing to bound the fetch
 * against, so it is reported as unpreviewable rather than fetched hopefully.
 */
export function documentPreviewPlan(name: string, size: number | undefined): DocumentPreviewPlan {
  const kind = documentPreviewKind(name);
  if (!kind || size === undefined) return { status: 'unsupported' };
  const as = kind === 'image' || kind === 'pdf' ? 'blob' : 'text';
  const limitBytes = as === 'blob' ? BINARY_PREVIEW_LIMIT_BYTES : TEXT_PREVIEW_LIMIT_BYTES;
  if (size > limitBytes) return { status: 'too-large', kind, limitBytes };
  return { status: 'ready', kind, as };
}

/**
 * Rows kept for a CSV preview. A 2 MiB CSV can be tens of thousands of rows;
 * a preview that locks the tab building 50k `<tr>` elements is not a preview.
 */
export const CSV_PREVIEW_MAX_ROWS = 500;

export interface CsvPreview {
  /** Capped at `CSV_PREVIEW_MAX_ROWS`. */
  rows: string[][];
  /** Rows in the whole file, so the UI can say what it left out. */
  totalRows: number;
}

/**
 * Minimal RFC 4180 reader: comma separated, double-quoted fields, `""` as an
 * escaped quote, CRLF or LF line endings. Deliberately not a CSV library —
 * this covers what an agent writes and nothing more.
 */
export function parseCsvPreview(text: string): CsvPreview {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let totalRows = 0;

  const endRow = () => {
    row.push(field);
    field = '';
    totalRows += 1;
    if (rows.length < CSV_PREVIEW_MAX_ROWS) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') endRow();
    else if (ch !== '\r') field += ch;
  }
  // A trailing newline already closed the last row; anything left is a final
  // row with no line terminator.
  if (field !== '' || row.length > 0) endRow();

  return { rows, totalRows };
}
