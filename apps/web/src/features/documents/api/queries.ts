import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { documentKeys } from './keys';

/** One listing row, inferred from the typed oRPC client — never hand-declared. */
export type DocumentEntry = Awaited<ReturnType<typeof rpc.documents.list>>['entries'][number];

/**
 * Every Documents root this personality declares, in declaration order.
 *
 * An EMPTY `roots` array is the "unconfigured" answer, not an error — the
 * personality declares no `fs_reach.workdir`, so there is nothing to browse.
 * The page renders a dedicated state for it rather than an empty listing.
 */
export function useDocumentsRoot(personalityId: string) {
  return useQuery({
    queryKey: documentKeys.root(personalityId),
    queryFn: () => rpc.documents.root({ personalityId }),
  });
}

/**
 * `path` is relative to the selected `root`; `''` is the root itself.
 *
 * `root` is nullable so the caller can mount this hook before `documents.root`
 * has answered — every other procedure refuses a request with no root, so
 * there is nothing to ask for until one is selected.
 */
export function useDocumentsList(personalityId: string, root: string | null, path: string) {
  return useQuery({
    queryKey: documentKeys.list(personalityId, root ?? '', path),
    queryFn: () =>
      rpc.documents.list({ personalityId, root: root ?? '', ...(path ? { path } : {}) }),
    enabled: root !== null,
  });
}
