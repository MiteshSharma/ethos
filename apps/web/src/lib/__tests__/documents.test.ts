import { describe, expect, it } from 'vitest';
import { documentKeys } from '../../features/documents/api/keys';
import {
  documentCrumbs,
  documentDownloadHref,
  documentRowActions,
  sortDocumentEntries,
} from '../documents';

describe('documentCrumbs', () => {
  it('yields only the root crumb at the root', () => {
    expect(documentCrumbs('', 'workspace')).toEqual([{ label: 'workspace', path: '' }]);
  });

  it('accumulates one crumb per segment', () => {
    expect(documentCrumbs('reports/2026/q3', 'workspace')).toEqual([
      { label: 'workspace', path: '' },
      { label: 'reports', path: 'reports' },
      { label: '2026', path: 'reports/2026' },
      { label: 'q3', path: 'reports/2026/q3' },
    ]);
  });

  it('always offers a path back to the root from any depth', () => {
    const crumbs = documentCrumbs('a/b/c/d', 'root');
    expect(crumbs[0]).toEqual({ label: 'root', path: '' });
  });

  it('ignores empty segments from stray slashes', () => {
    expect(documentCrumbs('reports//q3/', 'root').map((c) => c.path)).toEqual([
      '',
      'reports',
      'reports/q3',
    ]);
  });
});

describe('documentRowActions', () => {
  it('offers download, delete and preview on a plain file', () => {
    expect(documentRowActions({ isDir: false, isSymlink: false })).toEqual({
      canDownload: true,
      canDelete: true,
      canPreview: true,
    });
  });

  it('offers nothing on a directory — the backend refuses delete outright', () => {
    expect(documentRowActions({ isDir: true, isSymlink: false })).toEqual({
      canDownload: false,
      canDelete: false,
      canPreview: false,
    });
  });

  it('offers nothing on a symlink, file or directory', () => {
    expect(documentRowActions({ isDir: false, isSymlink: true })).toEqual({
      canDownload: false,
      canDelete: false,
      canPreview: false,
    });
    expect(documentRowActions({ isDir: true, isSymlink: true })).toEqual({
      canDownload: false,
      canDelete: false,
      canPreview: false,
    });
  });

  it('refuses preview on a symlink for the same reason it refuses download', () => {
    // A symlink's own path passes the workdir prefix check while its target
    // need not be inside it. Preview reads bytes through the same route, so a
    // previewable symlink would be the exact escape download already refuses.
    expect(documentRowActions({ isDir: false, isSymlink: true }).canPreview).toBe(false);
  });
});

describe('documentDownloadHref', () => {
  it('is relative so the SameSite=Strict auth cookie rides along', () => {
    const href = documentDownloadHref('researcher', 'report.md');
    expect(href.startsWith('/documents/download?')).toBe(true);
    expect(href).not.toMatch(/^https?:\/\//);
  });

  it('carries the personality and the relative path', () => {
    const params = new URLSearchParams(
      documentDownloadHref('engineer', 'reports/q3.md').split('?')[1],
    );
    expect(params.get('personality')).toBe('engineer');
    expect(params.get('path')).toBe('reports/q3.md');
  });

  it('encodes spaces as %20, not +, so the filename survives the round trip', () => {
    const href = documentDownloadHref('coach', 'my notes.md');
    expect(href).toContain('path=my%20notes.md');
    expect(href).not.toContain('+');
  });

  it('escapes a path that tries to smuggle another query parameter', () => {
    const href = documentDownloadHref('operator', 'a&personality=root.md');
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('personality')).toBe('operator');
    expect(params.get('path')).toBe('a&personality=root.md');
  });
});

describe('sortDocumentEntries', () => {
  it('puts directories first, then names case-insensitively', () => {
    const entries = [
      { name: 'zeta.md', isDir: false },
      { name: 'Reports', isDir: true },
      { name: 'alpha.md', isDir: false },
      { name: 'archive', isDir: true },
    ];
    expect(sortDocumentEntries(entries).map((e) => e.name)).toEqual([
      'archive',
      'Reports',
      'alpha.md',
      'zeta.md',
    ]);
  });

  it('does not mutate the input', () => {
    const entries = [
      { name: 'b', isDir: false },
      { name: 'a', isDir: true },
    ];
    sortDocumentEntries(entries);
    expect(entries.map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('documentKeys', () => {
  it('scopes listings by personality so switching does not reuse a cache entry', () => {
    expect(documentKeys.list('researcher', '')).not.toEqual(documentKeys.list('engineer', ''));
  });

  it('makes the post-delete invalidation key a prefix of every listing key', () => {
    const invalidation = documentKeys.lists('researcher');
    for (const path of ['', 'reports', 'reports/2026/q3']) {
      const listKey = documentKeys.list('researcher', path);
      expect(listKey.slice(0, invalidation.length)).toEqual([...invalidation]);
    }
  });

  it("does not invalidate another personality's listings", () => {
    const invalidation = documentKeys.lists('researcher');
    const other = documentKeys.list('engineer', '');
    expect(other.slice(0, invalidation.length)).not.toEqual([...invalidation]);
  });
});
