// Pure helpers for the Documents tab. No React, no rpc client — the page
// wires these to state; the tests drive them directly.

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
}

export function documentRowActions(entry: {
  isDir: boolean;
  isSymlink: boolean;
}): DocumentRowActions {
  const servable = !entry.isSymlink && !entry.isDir;
  return { canDownload: servable, canDelete: servable };
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
export function documentDownloadHref(personalityId: string, path: string): string {
  return `/documents/download?personality=${encodeURIComponent(personalityId)}&path=${encodeURIComponent(path)}`;
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
