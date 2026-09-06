import { z } from 'zod';

// Pure helpers for the Documents tab. No React, no rpc client — the page
// wires these to state; the tests drive them directly.

/**
 * What a Documents call addresses: a personality's declared `fs_reach.workdir`
 * roots, or a team's work directory (`~/.ethos/teams/<team>/`). The same
 * browser, hooks and routes serve both; only the scope differs.
 */
export type DocumentsScope = { personalityId: string } | { team: string };

/** The scope's query-string form — `personality=…` or `team=…`, as the routes read it. */
export function documentsScopeQuery(scope: DocumentsScope): string {
  return 'team' in scope
    ? `team=${encodeURIComponent(scope.team)}`
    : `personality=${encodeURIComponent(scope.personalityId)}`;
}

/** The scope's react-query key segment — distinct per kind so a team and a
 *  personality that share an id never share a cache entry. */
export function documentsScopeKey(scope: DocumentsScope): readonly [string, string] {
  return 'team' in scope ? ['team', scope.team] : ['personality', scope.personalityId];
}

/**
 * One declared Documents root, as `documents.root` returns it. `id` is opaque
 * (a stringified index today) and is fed back verbatim as `root` on every
 * other call — list, delete, createFolder, download, upload.
 */
export interface DocumentRoot {
  id: string;
  path: string;
}

/** One crumb in the breadcrumb trail. `path` feeds straight back into `documents.list`. */
export interface DocumentCrumb {
  label: string;
  /** Relative to the workdir root. `''` is the root itself. */
  path: string;
}

/**
 * Breadcrumb trail for a relative path, root first.
 *
 * `''` yields just the root crumb, so the trail always offers a way back to
 * the root — the operator can be several directories deep with no other
 * navigation affordance on the page.
 */
export function documentCrumbs(path: string, rootLabel: string): DocumentCrumb[] {
  const crumbs: DocumentCrumb[] = [{ label: rootLabel, path: '' }];
  let acc = '';
  for (const segment of path.split('/')) {
    if (!segment) continue;
    acc = acc ? `${acc}/${segment}` : segment;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

/**
 * What a row may actually do, given what the backend refuses.
 *
 * Two refusals, both hard:
 *   • Directories cannot be deleted AT ALL (not "not recursively") and are
 *     not downloadable — `documents.delete` answers `INVALID_INPUT`.
 *   • Symlinks are listed but refused everywhere, because the link path
 *     passes the workdir prefix check while the target need not be inside it.
 *
 * Rendering an affordance that always errors is worse than rendering none, so
 * the page asks here before drawing the actions cell.
 */
export interface DocumentRowActions {
  canDownload: boolean;
  canDelete: boolean;
  /**
   * Preview reads bytes through the SAME download route, so it inherits both
   * refusals verbatim: a symlink is refused there and must be refused here.
   * Directories navigate on click instead.
   */
  canPreview: boolean;
}

export function documentRowActions(entry: {
  isDir: boolean;
  isSymlink: boolean;
}): DocumentRowActions {
  const servable = !entry.isSymlink && !entry.isDir;
  return { canDownload: servable, canDelete: servable, canPreview: servable };
}

/**
 * `GET /documents/download` href — deliberately RELATIVE.
 *
 * The route is authenticated by the httpOnly `ethos_auth` cookie, which is
 * `SameSite=Strict`. An absolute `http://localhost:3000/...` from the Vite dev
 * server on `:5173` is cross-site, so the browser drops the cookie and the
 * download 401s. A relative href keeps the request same-origin in dev (through
 * the Vite proxy) and in production (`ethos serve` serves both).
 *
 * `encodeURIComponent` rather than `URLSearchParams`: the latter encodes a
 * space as `+`, which a query parser is free to hand back as a literal `+`.
 * A filename with a space must survive the round trip byte-for-byte.
 */
export function documentDownloadHref(scope: DocumentsScope, root: string, path: string): string {
  return `/documents/download?${documentsScopeQuery(scope)}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}

/**
 * `POST /documents/upload` URL. Relative for the same cookie reason
 * `documentDownloadHref` is, and built the same way — `encodeURIComponent`
 * rather than `URLSearchParams`, so a filename with a space survives.
 *
 * `overwrite` is only ever emitted when the caller explicitly asks for it: the
 * route defaults to refusing an existing file, and that refusal is the whole
 * point of the 409 the modal turns into a "replace existing file" choice.
 */
export function documentUploadHref(
  scope: DocumentsScope,
  root: string,
  path: string,
  opts: { overwrite?: boolean } = {},
): string {
  const base = `/documents/upload?${documentsScopeQuery(scope)}&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
  return opts.overwrite ? `${base}&overwrite=true` : base;
}

/**
 * Directories first, then case-insensitive name order. `readdir` order is
 * filesystem-dependent; a file browser that reshuffles between refreshes is
 * unusable.
 */
export function sortDocumentEntries<T extends { name: string; isDir: boolean }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** Path segments, with the trailing slash and any empty segment dropped. */
function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** One tab in the root switcher. `path` is the absolute root, shown on hover. */
export interface DocumentRootOption {
  id: string;
  label: string;
  path: string;
}

/**
 * Label every declared root by its last path segment — the shortest thing that
 * still reads as a place. Two roots can share that segment
 * (`/srv/alpha/docs` and `/srv/beta/docs`), and a switcher showing "docs"
 * twice is worse than no switcher, so a colliding label grows one segment at a
 * time until the set is unique or the paths are exhausted. The full absolute
 * path travels alongside for the `title` tooltip either way.
 */
export function documentRootOptions(roots: readonly DocumentRoot[]): DocumentRootOption[] {
  const segments = roots.map((r) => pathSegments(r.path));
  const labels = roots.map((r, i) => segments[i].at(-1) ?? r.path);
  const deepest = segments.reduce((max, s) => Math.max(max, s.length), 0);

  for (let depth = 2; depth <= deepest; depth++) {
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    if ([...counts.values()].every((n) => n === 1)) break;
    for (let i = 0; i < labels.length; i++) {
      if ((counts.get(labels[i]) ?? 0) > 1) {
        labels[i] = segments[i].slice(-depth).join('/') || roots[i].path;
      }
    }
  }

  return roots.map((r, i) => ({ id: r.id, label: labels[i], path: r.path }));
}

/** `dir` + `name`, with `''` meaning the root itself. */
export function joinDocumentPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, '');
  return base ? `${base}/${name}` : name;
}

/**
 * Why a folder name is unacceptable, or `null` when it is fine.
 *
 * Deliberately thin — the backend is the authority (it resolves the path and
 * lets `ScopedStorage` judge it). This only refuses what would be a confusing
 * round trip: a blank name, and a name that is really a path.
 */
export function newFolderNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a folder name.';
  if (trimmed.includes('/'))
    return 'Folder names cannot contain "/". Folders are created one level at a time.';
  if (trimmed === '.' || trimmed === '..') return 'Pick a name other than "." or "..".';
  return null;
}

/** One entry in the upload modal's destination selector. */
export interface DocumentFolderOption {
  /** Path relative to the selected root; `''` is the root itself. */
  value: string;
  label: string;
  isCurrent: boolean;
}

/**
 * Destination folders offered for an upload, built ENTIRELY from the `list()`
 * data the page already loads for `dest` — no folder-tree endpoint, and no
 * recursive walk.
 *
 * What that buys is a picker you navigate rather than a tree you read: the
 * ancestors of the current destination (so you can go back up), the
 * destination itself, and its immediate subfolders. Picking a subfolder makes
 * it the destination, whose own `list()` then supplies the next level — the
 * same one-level-at-a-time motion the page's breadcrumb already has, and the
 * same query key, so browsing the picker mostly hits cache.
 *
 * Symlinked directories are excluded for the same reason the listing refuses
 * to serve them: the link path passes the root's prefix check while its target
 * need not be inside it.
 */
export function documentFolderOptions(
  dest: string,
  entries: readonly { name: string; path: string; isDir: boolean; isSymlink: boolean }[],
  rootLabel: string,
): DocumentFolderOption[] {
  const ancestors = documentCrumbs(dest, rootLabel).map((crumb) => ({
    value: crumb.path,
    label: crumb.path || `${rootLabel}/`,
    isCurrent: crumb.path === dest,
  }));
  const children = sortDocumentEntries(entries.filter((e) => e.isDir && !e.isSymlink)).map((e) => ({
    value: e.path,
    label: e.path,
    isCurrent: false,
  }));
  return [...ancestors, ...children];
}

/** The `{ ok: false, code, error, action }` envelope every web-api route renders. */
const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  error: z.string(),
  action: z.string().optional(),
});

/**
 * What the upload route said went wrong, in words an operator can act on.
 *
 * `kind` is what the modal branches on: `'exists'` is the only failure with a
 * recovery the user can choose (retry with `overwrite=true`), so it is a
 * discriminated case rather than a string match on the message.
 */
export interface DocumentUploadFailure {
  kind: 'exists' | 'too-large' | 'other';
  message: string;
}

export function documentUploadFailure(status: number, body: unknown): DocumentUploadFailure {
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  const envelope = parsed.success ? parsed.data : null;

  if (status === 409 || envelope?.code === 'DOCUMENT_EXISTS') {
    return { kind: 'exists', message: 'A file with that name already exists in this folder.' };
  }
  if (status === 413 || envelope?.code === 'PAYLOAD_TOO_LARGE') {
    return { kind: 'too-large', message: 'That file is over the 100 MB upload limit.' };
  }
  return {
    kind: 'other',
    message: envelope
      ? `${envelope.error}${envelope.action ? ` ${envelope.action}` : ''}`
      : `Upload failed (HTTP ${status}).`,
  };
}
