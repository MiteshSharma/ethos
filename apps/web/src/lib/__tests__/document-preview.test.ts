import { describe, expect, it } from 'vitest';
import {
  BINARY_PREVIEW_LIMIT_BYTES,
  CSV_PREVIEW_MAX_ROWS,
  documentPreviewKind,
  documentPreviewPlan,
  extensionOf,
  parseCsvPreview,
  TEXT_PREVIEW_LIMIT_BYTES,
} from '../document-preview';

describe('documentPreviewKind', () => {
  it('maps markdown', () => {
    expect(documentPreviewKind('REPORT.md')).toBe('markdown');
    expect(documentPreviewKind('notes.markdown')).toBe('markdown');
  });

  it('maps html', () => {
    expect(documentPreviewKind('dashboard.html')).toBe('html');
    expect(documentPreviewKind('legacy.HTM')).toBe('html');
  });

  it('maps every image extension, svg included', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg']) {
      expect(documentPreviewKind(name), name).toBe('image');
    }
  });

  it('maps pdf', () => {
    expect(documentPreviewKind('invoice.pdf')).toBe('pdf');
  });

  it('maps csv', () => {
    expect(documentPreviewKind('rows.csv')).toBe('csv');
  });

  it('maps text, code and json to the code-block renderer', () => {
    for (const name of ['a.txt', 'a.log', 'a.json', 'a.yaml', 'a.ts', 'a.py', 'a.sh']) {
      expect(documentPreviewKind(name), name).toBe('text');
    }
  });

  it('refuses anything it cannot draw rather than guessing at text', () => {
    for (const name of ['archive.zip', 'clip.mp4', 'model.bin', 'binary', '.env']) {
      expect(documentPreviewKind(name), name).toBeNull();
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(documentPreviewKind('Chart.PNG')).toBe('image');
    expect(documentPreviewKind('Notes.MD')).toBe('markdown');
  });
});

describe('extensionOf', () => {
  it('returns the lowercased extension with its dot', () => {
    expect(extensionOf('a/b.TXT')).toBe('.txt');
  });

  it('returns empty for a name with no extension', () => {
    expect(extensionOf('Makefile')).toBe('');
  });

  it('does not treat a dotfile’s leading dot as an extension', () => {
    expect(extensionOf('.env')).toBe('');
  });
});

describe('documentPreviewPlan', () => {
  it('fetches text-ish kinds as text', () => {
    expect(documentPreviewPlan('a.md', 10)).toEqual({
      status: 'ready',
      kind: 'markdown',
      as: 'text',
    });
    expect(documentPreviewPlan('a.html', 10)).toEqual({
      status: 'ready',
      kind: 'html',
      as: 'text',
    });
    expect(documentPreviewPlan('a.csv', 10)).toEqual({ status: 'ready', kind: 'csv', as: 'text' });
    expect(documentPreviewPlan('a.json', 10)).toEqual({
      status: 'ready',
      kind: 'text',
      as: 'text',
    });
  });

  it('fetches image and pdf as a blob, for an object URL', () => {
    expect(documentPreviewPlan('a.png', 10)).toEqual({
      status: 'ready',
      kind: 'image',
      as: 'blob',
    });
    expect(documentPreviewPlan('a.pdf', 10)).toEqual({ status: 'ready', kind: 'pdf', as: 'blob' });
  });

  it('reports an unknown type as unsupported, not as an error', () => {
    expect(documentPreviewPlan('a.zip', 10)).toEqual({ status: 'unsupported' });
  });

  it('skips the fetch for text past the 2 MiB ceiling', () => {
    expect(documentPreviewPlan('big.md', TEXT_PREVIEW_LIMIT_BYTES + 1)).toEqual({
      status: 'too-large',
      kind: 'markdown',
      limitBytes: TEXT_PREVIEW_LIMIT_BYTES,
    });
  });

  it('allows text exactly at the ceiling', () => {
    expect(documentPreviewPlan('big.md', TEXT_PREVIEW_LIMIT_BYTES)).toEqual({
      status: 'ready',
      kind: 'markdown',
      as: 'text',
    });
  });

  it('gives image and pdf the higher ceiling — the bytes never become DOM', () => {
    const overText = TEXT_PREVIEW_LIMIT_BYTES + 1;
    expect(documentPreviewPlan('chart.png', overText)).toEqual({
      status: 'ready',
      kind: 'image',
      as: 'blob',
    });
    expect(documentPreviewPlan('chart.png', BINARY_PREVIEW_LIMIT_BYTES + 1)).toEqual({
      status: 'too-large',
      kind: 'image',
      limitBytes: BINARY_PREVIEW_LIMIT_BYTES,
    });
  });

  it('never previews a file whose size could not be read — the fetch would be unbounded', () => {
    expect(documentPreviewPlan('a.md', undefined)).toEqual({ status: 'unsupported' });
  });
});

describe('parseCsvPreview', () => {
  it('splits plain rows and columns', () => {
    expect(parseCsvPreview('a,b\n1,2\n')).toEqual({
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
      totalRows: 2,
    });
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsvPreview('name,note\n"Doe, Jane",ok').rows[1]).toEqual(['Doe, Jane', 'ok']);
  });

  it('unescapes a doubled quote', () => {
    expect(parseCsvPreview('a\n"say ""hi"""').rows[1]).toEqual(['say "hi"']);
  });

  it('keeps a newline inside a quoted field on one row', () => {
    expect(parseCsvPreview('a,b\n"line1\nline2",x')).toEqual({
      rows: [
        ['a', 'b'],
        ['line1\nline2', 'x'],
      ],
      totalRows: 2,
    });
  });

  it('handles CRLF endings', () => {
    expect(parseCsvPreview('a,b\r\n1,2\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads a final row with no trailing newline', () => {
    expect(parseCsvPreview('a\n1').totalRows).toBe(2);
  });

  it('yields nothing for empty input', () => {
    expect(parseCsvPreview('')).toEqual({ rows: [], totalRows: 0 });
  });

  it('caps retained rows but still reports the true total', () => {
    const lines = Array.from({ length: CSV_PREVIEW_MAX_ROWS + 25 }, (_, i) => `${i}`).join('\n');
    const parsed = parseCsvPreview(lines);
    expect(parsed.rows.length).toBe(CSV_PREVIEW_MAX_ROWS);
    expect(parsed.totalRows).toBe(CSV_PREVIEW_MAX_ROWS + 25);
  });
});
