// @vitest-environment jsdom
//
// The team Documents pane: the shared `DocumentsBrowser` mounted with a
// `{ team }` scope, so every call carries `team` (never `personalityId`),
// the header names the team directory, and the listing renders the team's
// files. The browser's own behaviour is covered by its lib tests; this pins
// the delegation and the scope.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, installDomStubs, type Mounted, mountPage } from './harness';

installDomStubs();

const documentsRoot = vi.fn();
const documentsList = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    documents: {
      root: (...args: unknown[]) => documentsRoot(...args),
      list: (...args: unknown[]) => documentsList(...args),
    },
  },
}));

const { TeamDocuments } = await import('../TeamDocuments');

let mounted: Mounted | null = null;

async function mount(): Promise<HTMLDivElement> {
  mounted = await mountPage(TeamDocuments, '/t/:teamId/documents', '/t/marketing/documents');
  await flush();
  return mounted.container;
}

beforeEach(() => {
  documentsRoot.mockResolvedValue({
    roots: [{ id: '0', path: '/home/ethos/.ethos/teams/marketing' }],
    team: 'marketing',
  });
  documentsList.mockResolvedValue({
    entries: [
      { name: 'outcomes.md', path: 'outcomes.md', isDir: false, size: 12, isSymlink: false },
      { name: 'brand', path: 'brand', isDir: true, isSymlink: false },
    ],
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('TeamDocuments', () => {
  it('names the team directory in the header and asks for the team scope only', async () => {
    const c = await mount();
    expect(text(c.querySelector('.team-documents-head'))).toBe('Documents teams/marketing/');
    expect(documentsRoot).toHaveBeenCalledWith({ team: 'marketing' });
    expect(documentsList).toHaveBeenCalledWith({ team: 'marketing', root: '0' });
    for (const call of [...documentsRoot.mock.calls, ...documentsList.mock.calls]) {
      expect(call[0]).not.toHaveProperty('personalityId');
    }
  });

  it('renders the absolute root, the toolbar and the listing — folders first', async () => {
    const c = await mount();
    expect(text(c.querySelector('.documents-rootline .documents-mono'))).toBe(
      '/home/ethos/.ethos/teams/marketing',
    );
    const actions = [...c.querySelectorAll('.documents-toolbar .documents-action')].map(
      (b) => b.textContent,
    );
    expect(actions).toEqual(['New folder', 'Upload']);
    const names = [...c.querySelectorAll('.ant-table-row')].map((r) => text(r.querySelector('td')));
    expect(names).toEqual(['brand/', 'outcomes.md']);
    expect(c.querySelector('a.documents-action')?.getAttribute('href')).toBe(
      '/documents/download?team=marketing&root=0&path=outcomes.md',
    );
  });

  it('says so when the team has no work directory yet, with no config-key pointer', async () => {
    documentsRoot.mockResolvedValue({ roots: [], team: 'marketing' });
    const c = await mount();
    expect(text(c.querySelector('.documents-team-empty'))).toBe(
      'marketing has no work directory yet. It is created the first time the team runs.',
    );
    expect(c.textContent).not.toContain('fs_reach');
    expect(documentsList).not.toHaveBeenCalled();
  });
});
