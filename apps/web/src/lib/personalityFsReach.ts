// Pure logic for the create wizard's `fs_reach` payload, split out of
// `pages/Personalities.tsx` so it is unit-testable without mounting the
// multi-step wizard (same technique as `personalityIdentityActions.ts`).
//
// The edit drawer has its own, deliberately different, shape: it always sends
// `workdir`, the empty list included, because the registry shallow-merges
// `fs_reach` sub-keys and omitting the key there would make the field
// impossible to clear. Creation has nothing to merge into, so it omits what
// was never declared.

/** The `fs_reach` block of a `personalities.create` call — omitted entirely
 *  when the wizard declared nothing. */
export interface WizardFsReach {
  fs_reach?: { read: string[]; write: string[]; workdir?: string[] };
}

/**
 * `workdir` is a LIST, passed through whole. A personality created with
 * several working directories must reach the registry with all of them: the
 * contract accepts `string | string[]`, so narrowing to the first entry here
 * would typecheck and silently drop every root but one.
 */
export function wizardFsReach(state: {
  fsReachRead: string[];
  fsReachWrite: string[];
  fsReachWorkdir: string[];
}): WizardFsReach {
  const { fsReachRead: read, fsReachWrite: write, fsReachWorkdir: workdir } = state;
  if (read.length === 0 && write.length === 0 && workdir.length === 0) return {};
  return { fs_reach: { read, write, ...(workdir.length > 0 ? { workdir } : {}) } };
}
