import { type DocumentsScope, documentsScopeKey } from '../../../lib/documents';

export const documentKeys = {
  all: () => ['documents'] as const,
  root: (scope: DocumentsScope) =>
    [...documentKeys.all(), 'root', ...documentsScopeKey(scope)] as const,
  /**
   * Every listing for one scope. Deliberately a PREFIX of `list(...)` so a
   * delete can invalidate the whole tree — the deleted file may have been
   * viewed from a subdirectory the operator has since navigated away from.
   *
   * The ROOT sits below this level for the same reason: a personality can
   * declare several roots, and an upload or a folder creation invalidates the
   * one it happened in without discarding the others' cached listings.
   */
  lists: (scope: DocumentsScope) =>
    [...documentKeys.all(), 'list', ...documentsScopeKey(scope)] as const,
  rootLists: (scope: DocumentsScope, root: string) => [...documentKeys.lists(scope), root] as const,
  list: (scope: DocumentsScope, root: string, path: string) =>
    [...documentKeys.rootLists(scope, root), path] as const,
};
