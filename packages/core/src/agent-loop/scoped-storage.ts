import type { AgentSafety, Storage } from '@ethosagent/types';

/**
 * Decorate the base Storage with the turn's `fs_reach` scope.
 *
 * The scope arrives already derived — `deriveFsReachPaths` runs ONCE per turn,
 * in the turn-setup stage, and the same result yields both this allowlist and
 * `ToolContext.workingDir`. Re-deriving here would be worse than wasteful: a
 * personality declaring `fs_reach.workdir: ${CWD}/out` resolves `${CWD}` against
 * the *boot* cwd, so feeding the already-resolved workdir back in as `cwd` would
 * compound it into `.../out/out`. One derivation, one scope.
 *
 * Returns undefined when no base Storage is wired, leaving
 * `ToolContext.storage` unset (legacy behaviour — tools fall back to raw fs).
 */
export function buildScopedStorage(
  storage: Storage | undefined,
  safety: AgentSafety,
  scope: { read: string[]; write: string[] },
): Storage | undefined {
  if (!storage) return undefined;
  return safety.scopedStorageFactory(storage, scope);
}
