/**
 * Every declared `fs_reach.workdir` entry, as a list. Mirrors `declaredWorkdirs`
 * in `packages/core/src/fs-reach.ts` (replicated, not imported: this package
 * depends on `@ethosagent/types` only). Empty strings are dropped so the
 * `workdir: ''` clear convention keeps clearing — and so an all-empty array,
 * which declares nothing, is indistinguishable here from an absent workdir.
 *
 * Lives in its own module because both the config renderer (`index.ts`) and the
 * character sheet (`character-sheet.ts`) need it, and `index.ts` already
 * imports from `character-sheet.ts` — a shared helper in either of them would
 * be a cycle.
 */
export function normalizeWorkdir(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}
