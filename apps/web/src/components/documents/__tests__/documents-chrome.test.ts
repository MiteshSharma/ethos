import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DocumentsUnconfigured } from '../DocumentsUnconfigured';
import { NewFolderPrompt } from '../NewFolderPrompt';
import { RootSwitcher } from '../RootSwitcher';

// `renderToStaticMarkup` needs no DOM, so these stay plain `.test.ts` files in
// the existing suite — same precedent as `document-preview-body.test.ts`. The
// three components under test are antd-free and hold no mutation for exactly
// that reason; `UploadDocumentModal` is the antd + react-query shell around
// them, and its logic lives in `lib/documents.ts` where it is tested directly.

const noop = () => {};

describe('RootSwitcher', () => {
  it('renders nothing for a single root — a picker with one option is not a control', () => {
    const html = renderToStaticMarkup(
      createElement(RootSwitcher, {
        roots: [{ id: '0', path: '/srv/ethos/workspace' }],
        value: '0',
        onChange: noop,
      }),
    );
    expect(html).toBe('');
  });

  it('renders nothing at all when the personality declares no roots', () => {
    expect(
      renderToStaticMarkup(createElement(RootSwitcher, { roots: [], value: '', onChange: noop })),
    ).toBe('');
  });

  it('renders one tab per root, labelled by its last segment', () => {
    const html = renderToStaticMarkup(
      createElement(RootSwitcher, {
        roots: [
          { id: '0', path: '/srv/ethos/workspace' },
          { id: '1', path: '/srv/ethos/archive' },
        ],
        value: '0',
        onChange: noop,
      }),
    );
    expect(html).toContain('>workspace</button>');
    expect(html).toContain('>archive</button>');
  });

  it('keeps the full path available on hover, since the label is only a suffix', () => {
    const html = renderToStaticMarkup(
      createElement(RootSwitcher, {
        roots: [
          { id: '0', path: '/srv/ethos/workspace' },
          { id: '1', path: '/srv/ethos/archive' },
        ],
        value: '0',
        onChange: noop,
      }),
    );
    expect(html).toContain('title="/srv/ethos/workspace"');
    expect(html).toContain('title="/srv/ethos/archive"');
  });

  it('marks exactly the selected root as the current tab', () => {
    const html = renderToStaticMarkup(
      createElement(RootSwitcher, {
        roots: [
          { id: '0', path: '/srv/ethos/workspace' },
          { id: '1', path: '/srv/ethos/archive' },
        ],
        value: '1',
        onChange: noop,
      }),
    );
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/title="\/srv\/ethos\/archive"[^>]*documents-root-tab--current/);
  });
});

describe('DocumentsUnconfigured', () => {
  const render = (identityHref: string | null) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(DocumentsUnconfigured, { personalityId: 'scribe', identityHref }),
      ),
    );

  it('names the personality and the exact config key to set', () => {
    const html = render(null);
    expect(html).toContain('scribe');
    expect(html).toContain('fs_reach.workdir');
    expect(html).toContain('config.yaml');
  });

  it('does not pretend the folder is merely empty', () => {
    const html = render(null);
    expect(html).toContain('no Documents folder configured');
    expect(html).not.toContain('Empty directory');
  });

  it('links to the personality’s own configuration when there is a route for it', () => {
    expect(render('/p/scribe/identity')).toContain('href="/p/scribe/identity"');
  });

  it('stands on its own with no link when none is offered', () => {
    expect(render(null)).not.toContain('<a ');
  });
});

describe('NewFolderPrompt', () => {
  const base = {
    value: 'reports',
    onChange: noop,
    onSubmit: noop,
    onCancel: noop,
    busy: false,
    error: null,
    parentLabel: '',
  };

  it('names the folder the new one would land in, so the prompt is unambiguous', () => {
    const html = renderToStaticMarkup(
      createElement(NewFolderPrompt, { ...base, parentLabel: 'reports/2026' }),
    );
    expect(html).toContain('aria-label="New folder name in reports/2026"');
  });

  it('says "the root" rather than an empty string at the top level', () => {
    const html = renderToStaticMarkup(createElement(NewFolderPrompt, base));
    expect(html).toContain('aria-label="New folder name in the root"');
  });

  it('shows a collision inline, next to the input that caused it', () => {
    const html = renderToStaticMarkup(
      createElement(NewFolderPrompt, { ...base, error: 'Something already exists at that path.' }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Something already exists at that path.');
  });

  it('disables both controls and says so while the create is in flight', () => {
    const html = renderToStaticMarkup(createElement(NewFolderPrompt, { ...base, busy: true }));
    expect(html).toContain('Creating…');
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
