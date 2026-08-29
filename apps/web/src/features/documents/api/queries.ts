import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { documentKeys } from './keys';

/** One listing row, inferred from the typed oRPC client — never hand-declared. */
export type DocumentEntry = Awaited<ReturnType<typeof rpc.documents.list>>['entries'][number];

/** The absolute workdir this personality's Documents view is rooted at. */
export function useDocumentsRoot(personalityId: string) {
  return useQuery({
    queryKey: documentKeys.root(personalityId),
    queryFn: () => rpc.documents.root({ personalityId }),
  });
}

/** `path` is relative to the root; `''` is the root itself. */
export function useDocumentsList(personalityId: string, path: string) {
  return useQuery({
    queryKey: documentKeys.list(personalityId, path),
    queryFn: () => rpc.documents.list({ personalityId, ...(path ? { path } : {}) }),
  });
}
