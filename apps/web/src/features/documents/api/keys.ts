export const documentKeys = {
  all: () => ['documents'] as const,
  root: (personalityId: string) => [...documentKeys.all(), 'root', personalityId] as const,
  /**
   * Every listing for one personality. Deliberately a PREFIX of `list(...)`
   * so a delete can invalidate the whole tree — the deleted file may have been
   * viewed from a subdirectory the operator has since navigated away from.
   */
  lists: (personalityId: string) => [...documentKeys.all(), 'list', personalityId] as const,
  list: (personalityId: string, path: string) =>
    [...documentKeys.lists(personalityId), path] as const,
};
