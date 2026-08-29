import { MarkdownRenderer } from '@ethosagent/ui-components';
import { formatBytes } from '../../lib/attachments';
import {
  CSV_PREVIEW_MAX_ROWS,
  type DocumentPreviewPlan,
  extensionOf,
  parseCsvPreview,
} from '../../lib/document-preview';

// The rendered body of the Documents preview modal.
//
// Split out from the modal shell and kept free of antd so it can be asserted
// on with `renderToStaticMarkup` — which is how the sandboxed-iframe security
// guard is regression-tested. It owns no state and starts no fetch; the shell
// hands it a resolved plan and whatever the fetch produced.

/** What the shell's fetch has produced so far. */
export type PreviewContent =
  | { status: 'loading' }
  | { status: 'text'; text: string }
  | { status: 'blob'; url: string }
  | { status: 'error'; message: string };

export interface DocumentPreviewBodyProps {
  name: string;
  size: number | undefined;
  plan: DocumentPreviewPlan;
  content: PreviewContent;
}

export function DocumentPreviewBody({ name, size, plan, content }: DocumentPreviewBodyProps) {
  if (plan.status === 'unsupported') {
    return (
      <div className="docpreview-notice">
        <p className="docpreview-notice-line">No preview available.</p>
        <p className="documents-mono">
          {extensionOf(name) || 'no extension'} ·{' '}
          {size === undefined ? 'size unknown' : formatBytes(size)}
        </p>
      </div>
    );
  }

  if (plan.status === 'too-large') {
    return (
      <div className="docpreview-notice">
        <p className="docpreview-notice-line">Too large to preview.</p>
        <p className="documents-mono">
          {size === undefined ? '—' : formatBytes(size)} · limit {formatBytes(plan.limitBytes)}
        </p>
      </div>
    );
  }

  if (content.status === 'loading') {
    return <p className="docpreview-notice-line documents-dim">Reading {name}…</p>;
  }

  if (content.status === 'error') {
    // Legible failure, not a dead modal: the footer still offers Download.
    return (
      <p className="docpreview-notice-line docpreview-error">
        Could not read {name} — {content.message}
      </p>
    );
  }

  if (content.status === 'blob') {
    return plan.kind === 'pdf' ? (
      <embed
        className="docpreview-pdf"
        src={content.url}
        type="application/pdf"
        title={`${name} (PDF)`}
      />
    ) : (
      // `<img>` never executes script, which is what makes an agent-written
      // SVG safe here. Inlining the SVG markup into the DOM would not be.
      <img className="docpreview-img" src={content.url} alt={name} />
    );
  }

  switch (plan.kind) {
    case 'markdown':
      // No preview-specific class: a `.md` file must read exactly the way the
      // same markdown reads in chat, which is `MarkdownRenderer`'s own styling.
      return <MarkdownRenderer content={content.text} />;
    case 'html':
      // SECURITY (regression-guarded in __tests__/document-preview-body.test.ts):
      // `allow-scripts` WITHOUT `allow-same-origin`. Granting both together
      // defeats the sandbox outright — the frame would run agent-written
      // script against this app's origin, session cookie included. Same
      // posture as `components/chat/HtmlBlock.tsx` for tool-produced HTML;
      // `HtmlRenderer` is deliberately not used, because it renders in-origin.
      return (
        <iframe
          className="docpreview-iframe"
          srcDoc={content.text}
          sandbox="allow-scripts"
          title={`${name} preview`}
        />
      );
    case 'csv':
      return <CsvTable text={content.text} />;
    default:
      return <pre className="docpreview-pre">{content.text}</pre>;
  }
}

function CsvTable({ text }: { text: string }) {
  const { rows, totalRows } = parseCsvPreview(text);
  const [header, ...body] = rows;
  if (!header) return <p className="docpreview-notice-line documents-dim">Empty file.</p>;

  return (
    <>
      <table className="docpreview-csv">
        <thead>
          <tr>
            {header.map((cell, i) => (
              // Column position IS the identity here — a CSV header may repeat
              // a label, and nothing reorders after parse.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional columns
              <th key={i} className="docpreview-csv-th">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
            <tr key={r}>
              {row.map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional columns
                <td key={c} className="docpreview-csv-td">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {totalRows > CSV_PREVIEW_MAX_ROWS ? (
        <p className="documents-mono">
          Showing {CSV_PREVIEW_MAX_ROWS} of {totalRows} rows. Download for the rest.
        </p>
      ) : null}
    </>
  );
}
