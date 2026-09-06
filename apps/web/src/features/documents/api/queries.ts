import { useQuery } from '@tanstack/react-query';
import type { DocumentsScope } from '../../../lib/documents';
import { rpc } from '../../../rpc';
import { documentKeys } from './keys';

/** One listing row, inferred from the typed oRPC client — never hand-declared. */
export type DocumentEntry = Awaited<ReturnType<typeof rpc.documents.list>>['entries'][number];

/**
 * Every Documents root this scope declares, in declaration order — a
 * personality's `fs_reach.workdir` entries, or a team's one work directory.
 *
 * An EMPTY `roots` array is the "unconfigured" answer, not an error — the
 * personality declares no `fs_reach.workdir` (or the team has no directory
 * yet), so there is nothing to browse. The page renders a dedicated state for
 * it rather than an empty listing.
 */
export function useDocumentsRoot(scope: DocumentsScope) {
  return useQuery({
    queryKey: documentKeys.root(scope),
    queryFn: () => rpc.documents.root(scope),
  });
}

/**
 * `path` is relative to the selected `root`; `''` is the root itself.
 *
 * `root` is nullable so the caller can mount this hook before `documents.root`
 * has answered — every other procedure refuses a request with no root, so
 * there is nothing to ask for until one is selected.
 */
export function useDocumentsList(
  scope: DocumentsScope,
  root: string | null,
  path: string,
  options: { enabled?: boolean; retry?: boolean } = {},
) {
  return useQuery({
    queryKey: documentKeys.list(scope, root ?? '', path),
    queryFn: () => rpc.documents.list({ ...scope, root: root ?? '', ...(path ? { path } : {}) }),
    enabled: root !== null && (options.enabled ?? true),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
}
