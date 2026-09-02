export const documentKeys = {
  all: () => ['documents'] as const,
  root: (personalityId: string) => [...documentKeys.all(), 'root', personalityId] as const,
  /**
   * Every listing for one personality. Deliberately a PREFIX of `list(...)`
   * so a delete can invalidate the whole tree — the deleted file may have been
   * viewed from a subdirectory the operator has since navigated away from.
   *
   * The ROOT sits below this level for the same reason: a personality can
   * declare several roots, and an upload or a folder creation invalidates the
   * one it happened in without discarding the others' cached listings.
   */
  lists: (personalityId: string) => [...documentKeys.all(), 'list', personalityId] as const,
  rootLists: (personalityId: string, root: string) =>
    [...documentKeys.lists(personalityId), root] as const,
  list: (personalityId: string, root: string, path: string) =>
    [...documentKeys.rootLists(personalityId, root), path] as const,
};
