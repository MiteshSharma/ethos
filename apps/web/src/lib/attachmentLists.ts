// Pure logic for P3 (plan/phases/personality-first-ui.md) — "dual-altitude
// twins". The same two shapes repeat across Skills / MCP / Plugins:
//
//   1. A workspace capability pane splits the global installed set into
//      "attached" (to this personality) and "installed but not attached" —
//      the two lists each pane renders, one row with a toggle each.
//   2. A Library capability page computes, for one item, which personality
//      ids have it attached — the "Used by" marks column.
//
// Kept here, separate from the page components, so the split/join logic is
// unit-testable without a DOM — same pattern as `workspaceScope.ts` (P2) and
// `scopeNav.ts` (P1b).

/** Splits `all` (the global installed set) into items already in
 *  `attachedIds` and items that aren't. `idOf` extracts the id the caller's
 *  attachment set is keyed by — skill/plugin id, or an MCP server's `name`
 *  (which has no `id` field at all) — so this one function serves all three
 *  capability panes without forcing an artificial common shape on them. */
export function splitByAttachment<T>(
  all: readonly T[],
  attachedIds: ReadonlySet<string>,
  idOf: (item: T) => string,
): { attached: T[]; notAttached: T[] } {
  const attached: T[] = [];
  const notAttached: T[] = [];
  for (const item of all) {
    (attachedIds.has(idOf(item)) ? attached : notAttached).push(item);
  }
  return { attached, notAttached };
}

export interface PersonalityAttachment {
  personalityId: string;
  /** The ids this personality has attached (skill ids, MCP server names,
   *  plugin ids) — whatever id space the caller is working in. */
  itemIds: readonly string[];
}

/** The Library "Used by" column: which personality ids have `itemId`
 *  attached, across every personality's own attachment list. Order follows
 *  `attachments`' order, not any of its own. */
export function usedByPersonalityIds(
  itemId: string,
  attachments: readonly PersonalityAttachment[],
): string[] {
  return attachments.filter((a) => a.itemIds.includes(itemId)).map((a) => a.personalityId);
}
