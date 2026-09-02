import { describe, expect, it } from 'vitest';
import { documentKeys } from '../../features/documents/api/keys';
import {
  documentCrumbs,
  documentDownloadHref,
  documentFolderOptions,
  documentRootOptions,
  documentRowActions,
  documentUploadFailure,
  documentUploadHref,
  joinDocumentPath,
  newFolderNameError,
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
    const href = documentDownloadHref('researcher', '0', 'report.md');
    expect(href.startsWith('/documents/download?')).toBe(true);
    expect(href).not.toMatch(/^https?:\/\//);
  });

  it('carries the personality, the root and the relative path', () => {
    const params = new URLSearchParams(
      documentDownloadHref('engineer', '1', 'reports/q3.md').split('?')[1],
    );
    expect(params.get('personality')).toBe('engineer');
    expect(params.get('root')).toBe('1');
    expect(params.get('path')).toBe('reports/q3.md');
  });

  it('always names a root — the route 400s without one, and typecheck cannot see it', () => {
    // A relative path means nothing until a root says which declared workdir
    // it hangs off. Omitting `root` is a RUNTIME break (a silent 400 on the
    // download button), not a compile error, which is why it is asserted here.
    for (const rootId of ['0', '1', '2']) {
      const params = new URLSearchParams(
        documentDownloadHref('engineer', rootId, 'a.md').split('?')[1],
      );
      expect(params.get('root')).toBe(rootId);
    }
  });

  it('encodes spaces as %20, not +, so the filename survives the round trip', () => {
    const href = documentDownloadHref('coach', '0', 'my notes.md');
    expect(href).toContain('path=my%20notes.md');
    expect(href).not.toContain('+');
  });

  it('percent-encodes a non-ASCII filename as UTF-8, and decodes back to it', () => {
    const name = 'rapport financier — été.txt';
    const href = documentDownloadHref('coach', '0', name);
    expect(href).toContain('path=rapport%20financier%20%E2%80%94%20%C3%A9t%C3%A9.txt');
    expect(new URLSearchParams(href.split('?')[1]).get('path')).toBe(name);
  });

  it('escapes a path that tries to smuggle another query parameter', () => {
    const href = documentDownloadHref('operator', '0', 'a&personality=root.md');
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('personality')).toBe('operator');
    expect(params.get('path')).toBe('a&personality=root.md');
  });
});

describe('documentUploadHref', () => {
  it('targets the raw upload route with personality, root and destination path', () => {
    const href = documentUploadHref('engineer', '1', 'reports/q3.md');
    expect(href.startsWith('/documents/upload?')).toBe(true);
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('personality')).toBe('engineer');
    expect(params.get('root')).toBe('1');
    expect(params.get('path')).toBe('reports/q3.md');
  });

  it('omits overwrite unless it was explicitly asked for', () => {
    expect(documentUploadHref('engineer', '0', 'a.md')).not.toContain('overwrite');
    expect(documentUploadHref('engineer', '0', 'a.md', {})).not.toContain('overwrite');
    expect(documentUploadHref('engineer', '0', 'a.md', { overwrite: false })).not.toContain(
      'overwrite',
    );
    expect(documentUploadHref('engineer', '0', 'a.md', { overwrite: true })).toContain(
      'overwrite=true',
    );
  });

  it('encodes a filename with a space the same way download does', () => {
    expect(documentUploadHref('coach', '0', 'my notes.md')).toContain('path=my%20notes.md');
  });

  it('encodes a non-ASCII filename the same way download does', () => {
    const name = 'reports/rapport financier — été (v2).txt';
    const upload = documentUploadHref('coach', '0', name);
    expect(upload).toContain(`path=${encodeURIComponent(name)}`);
    expect(new URLSearchParams(upload.split('?')[1]).get('path')).toBe(name);
    // The two hrefs must agree byte-for-byte on the path, or a file uploaded
    // under this name cannot be downloaded again under it.
    expect(new URLSearchParams(upload.split('?')[1]).get('path')).toBe(
      new URLSearchParams(documentDownloadHref('coach', '0', name).split('?')[1]).get('path'),
    );
  });

  it('keeps overwrite=true parseable after a filename full of separators', () => {
    const params = new URLSearchParams(
      documentUploadHref('coach', '0', 'a&b=c?d#e f.txt', { overwrite: true }).split('?')[1],
    );
    expect(params.get('path')).toBe('a&b=c?d#e f.txt');
    expect(params.get('overwrite')).toBe('true');
  });
});

describe('documentRootOptions', () => {
  it('labels each root by its last path segment and keeps the full path', () => {
    expect(
      documentRootOptions([
        { id: '0', path: '/srv/ethos/workspace' },
        { id: '1', path: '/srv/ethos/archive' },
      ]),
    ).toEqual([
      { id: '0', label: 'workspace', path: '/srv/ethos/workspace' },
      { id: '1', label: 'archive', path: '/srv/ethos/archive' },
    ]);
  });

  it('widens a colliding label until the set is distinguishable', () => {
    expect(
      documentRootOptions([
        { id: '0', path: '/srv/alpha/docs' },
        { id: '1', path: '/srv/beta/docs' },
        { id: '2', path: '/srv/notes' },
      ]).map((o) => o.label),
    ).toEqual(['alpha/docs', 'beta/docs', 'notes']);
  });

  it('falls back to the path itself when there is no segment to name it by', () => {
    expect(documentRootOptions([{ id: '0', path: '/' }])[0]?.label).toBe('/');
  });
});

describe('joinDocumentPath', () => {
  it('treats the empty directory as the root', () => {
    expect(joinDocumentPath('', 'a.md')).toBe('a.md');
  });

  it('joins a subdirectory without doubling the separator', () => {
    expect(joinDocumentPath('reports', 'q3.md')).toBe('reports/q3.md');
    expect(joinDocumentPath('reports/', 'q3.md')).toBe('reports/q3.md');
  });
});

describe('newFolderNameError', () => {
  it('accepts an ordinary name', () => {
    expect(newFolderNameError('reports')).toBeNull();
  });

  it('refuses a blank name', () => {
    expect(newFolderNameError('   ')).toMatch(/Enter a folder name/);
  });

  it('refuses a name that is really a path — creation is one level at a time', () => {
    expect(newFolderNameError('a/b')).toMatch(/cannot contain/);
  });

  it('refuses the two relative names', () => {
    expect(newFolderNameError('.')).toMatch(/other than/);
    expect(newFolderNameError('..')).toMatch(/other than/);
  });
});

describe('documentFolderOptions', () => {
  const entries = [
    { name: 'q3.md', path: 'reports/q3.md', isDir: false, isSymlink: false },
    { name: 'drafts', path: 'reports/drafts', isDir: true, isSymlink: false },
    { name: 'archive', path: 'reports/archive', isDir: true, isSymlink: false },
    { name: 'elsewhere', path: 'reports/elsewhere', isDir: true, isSymlink: true },
  ];

  it('offers the ancestors, the destination itself, and its subfolders', () => {
    expect(documentFolderOptions('reports', entries, 'workspace').map((o) => o.value)).toEqual([
      '',
      'reports',
      'reports/archive',
      'reports/drafts',
    ]);
  });

  it('marks exactly one option as the current destination', () => {
    const current = documentFolderOptions('reports', entries, 'workspace').filter(
      (o) => o.isCurrent,
    );
    expect(current.map((o) => o.value)).toEqual(['reports']);
  });

  it('names the root by its label rather than the empty string', () => {
    expect(documentFolderOptions('', [], 'workspace')).toEqual([
      { value: '', label: 'workspace/', isCurrent: true },
    ]);
  });

  it('never offers a symlinked directory — the listing refuses to serve them', () => {
    const values = documentFolderOptions('reports', entries, 'workspace').map((o) => o.value);
    expect(values).not.toContain('reports/elsewhere');
  });

  it('offers no files, only folders', () => {
    const values = documentFolderOptions('reports', entries, 'workspace').map((o) => o.value);
    expect(values).not.toContain('reports/q3.md');
  });
});

describe('documentUploadFailure', () => {
  it('turns a 409 into the one failure the user can act on', () => {
    const failure = documentUploadFailure(409, {
      ok: false,
      code: 'DOCUMENT_EXISTS',
      error: 'A file already exists at that path.',
      action: 'Retry with overwrite enabled, or pick a different filename.',
    });
    expect(failure.kind).toBe('exists');
    expect(failure.message).toMatch(/already exists/);
  });

  it('states the limit in megabytes rather than echoing PAYLOAD_TOO_LARGE', () => {
    const failure = documentUploadFailure(413, null);
    expect(failure.kind).toBe('too-large');
    expect(failure.message).toContain('100 MB');
    expect(failure.message).not.toContain('PAYLOAD_TOO_LARGE');
  });

  it('passes a service error through with its action, since that names the fix', () => {
    const failure = documentUploadFailure(404, {
      ok: false,
      code: 'FILE_NOT_FOUND',
      error: 'The parent folder does not exist.',
      action: 'Create the parent folder first, or pick an existing destination.',
    });
    expect(failure.kind).toBe('other');
    expect(failure.message).toBe(
      'The parent folder does not exist. Create the parent folder first, or pick an existing destination.',
    );
  });

  it('falls back to the status when the body is not an envelope at all', () => {
    expect(documentUploadFailure(500, '<html>502 Bad Gateway</html>')).toEqual({
      kind: 'other',
      message: 'Upload failed (HTTP 500).',
    });
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
    expect(documentKeys.list('researcher', '0', '')).not.toEqual(
      documentKeys.list('engineer', '0', ''),
    );
  });

  it('scopes listings by root so two declared workdirs never share a cache entry', () => {
    expect(documentKeys.list('researcher', '0', '')).not.toEqual(
      documentKeys.list('researcher', '1', ''),
    );
  });

  it('makes the post-write invalidation key a prefix of every listing key in that root', () => {
    const invalidation = documentKeys.rootLists('researcher', '0');
    for (const path of ['', 'reports', 'reports/2026/q3']) {
      const listKey = documentKeys.list('researcher', '0', path);
      expect(listKey.slice(0, invalidation.length)).toEqual([...invalidation]);
    }
  });

  it("does not invalidate another root's listings", () => {
    const invalidation = documentKeys.rootLists('researcher', '0');
    const other = documentKeys.list('researcher', '1', '');
    expect(other.slice(0, invalidation.length)).not.toEqual([...invalidation]);
  });

  it("does not invalidate another personality's listings", () => {
    const invalidation = documentKeys.lists('researcher');
    const other = documentKeys.list('engineer', '0', '');
    expect(other.slice(0, invalidation.length)).not.toEqual([...invalidation]);
  });
});
