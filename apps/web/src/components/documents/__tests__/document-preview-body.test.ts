import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocumentPreviewKind, DocumentPreviewPlan } from '../../../lib/document-preview';
import { DocumentPreviewBody, type PreviewContent } from '../DocumentPreviewBody';

// `renderToStaticMarkup` needs no DOM, so this stays a plain `.test.ts` in the
// existing suite — same precedent as
// `apps/web/src/features/renderers/__tests__/markdown-fence-seam.test.ts`.
// The body is antd-free precisely so it can be rendered this way.

function render(
  plan: DocumentPreviewPlan,
  content: PreviewContent,
  name = 'artifact',
  size: number | undefined = 100,
) {
  return renderToStaticMarkup(createElement(DocumentPreviewBody, { name, size, plan, content }));
}

function ready(kind: DocumentPreviewKind): DocumentPreviewPlan {
  return { status: 'ready', kind, as: kind === 'image' || kind === 'pdf' ? 'blob' : 'text' };
}

describe('DocumentPreviewBody — agent HTML is sandboxed', () => {
  const html = render(ready('html'), {
    status: 'text',
    text: '<h1>hi</h1><script>fetch("/api/steal")</script>',
  });

  it('renders agent HTML inside an iframe, never inline in this document', () => {
    expect(html).toContain('<iframe');
    expect(html).toContain('srcDoc=');
    // The markup is escaped into the srcdoc attribute, not parsed into our DOM.
    expect(html).not.toContain('<h1>hi</h1>');
  });

  it('sandboxes the iframe WITHOUT allow-same-origin', () => {
    expect(html).toContain('sandbox="allow-scripts"');
    expect(
      html,
      'SECURITY REGRESSION: the workdir HTML preview iframe must never carry ' +
        'allow-same-origin. Combined with allow-scripts it disables the sandbox ' +
        "entirely, giving agent-written markup full access to this app's origin " +
        'and its session cookie. See DocumentPreviewBody.tsx and HtmlBlock.tsx.',
    ).not.toContain('allow-same-origin');
  });
});

describe('DocumentPreviewBody — renderer per kind', () => {
  it('renders markdown through MarkdownRenderer, not as raw text', () => {
    const html = render(ready('markdown'), { status: 'text', text: '# Title\n\nbody' });
    expect(html).toContain('<h1');
    expect(html).toContain('Title');
    expect(html).not.toContain('# Title');
  });

  it('renders text and code in a scrollable code block', () => {
    const html = render(ready('text'), { status: 'text', text: 'const a = 1;' });
    expect(html).toContain('<pre class="docpreview-pre">');
    expect(html).toContain('const a = 1;');
  });

  it('renders csv as a table with a header row', () => {
    const html = render(ready('csv'), { status: 'text', text: 'name,qty\nbolt,4' });
    expect(html).toContain('<table class="docpreview-csv">');
    expect(html).toContain('name</th>');
    expect(html).toContain('bolt</td>');
  });

  it('renders an image from the object URL through <img>, never as inline markup', () => {
    const html = render(ready('image'), { status: 'blob', url: 'blob:x' }, 'chart.svg');
    expect(html).toContain('<img');
    expect(html).toContain('src="blob:x"');
    expect(html).toContain('alt="chart.svg"');
    expect(html).not.toContain('<svg');
  });

  it('renders a pdf in an embedded viewer from the object URL', () => {
    const html = render(ready('pdf'), { status: 'blob', url: 'blob:y' }, 'report.pdf');
    expect(html).toContain('<embed');
    expect(html).toContain('type="application/pdf"');
    expect(html).toContain('src="blob:y"');
  });
});

describe('DocumentPreviewBody — non-preview outcomes', () => {
  it('states there is no preview for an unsupported type, with type and size', () => {
    const html = render({ status: 'unsupported' }, { status: 'loading' }, 'bundle.zip', 4096);
    expect(html).toContain('No preview available.');
    expect(html).toContain('.zip');
    expect(html).toContain('4.0 KB');
  });

  it('states the size and the limit when the file is past the ceiling', () => {
    const html = render(
      { status: 'too-large', kind: 'markdown', limitBytes: 2 * 1024 * 1024 },
      { status: 'loading' },
      'huge.md',
      8 * 1024 * 1024,
    );
    expect(html).toContain('Too large to preview.');
    expect(html).toContain('8.0 MB');
    expect(html).toContain('2.0 MB');
  });

  it('says the read failed rather than showing an empty body', () => {
    const html = render(ready('markdown'), { status: 'error', message: 'HTTP 404' }, 'gone.md');
    expect(html).toContain('Could not read');
    expect(html).toContain('HTTP 404');
  });

  it('names the file while it is loading', () => {
    const html = render(ready('markdown'), { status: 'loading' }, 'slow.md');
    expect(html).toContain('Reading');
    expect(html).toContain('slow.md');
  });
});
