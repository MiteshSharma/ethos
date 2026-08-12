import {
  type AgentSafety,
  ApprovalPostureError,
  type HookRegistry,
  type Logger,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// G4 — verify the composition root's approval-posture declaration against what
// is actually registered behind core's enforcement point.
//
// Core owns the `before_tool_call` fire site (`stages/per-call-enforcement.ts`)
// but has no way to see whether a policy was registered behind it: a bare
// `@ethosagent/core` embedder that registers nothing gets a fully working loop
// with no gating and no signal. `approval-seams.ts`'s own header records this
// failure happening once in-tree already — every entry point called
// `createDangerPredicate` with neither seam, so `safety.denyRules` was inert
// config nobody consulted, and nothing said so.
//
// The posture is therefore declared, not inferred. `gated` is a claim core
// checks; an unbacked claim is a wiring bug and surfaces as a typed error
// (ARCHITECTURE.md §V S7 — boundary violations surface to the operator; silent
// failures are forbidden). `ungated` is a legitimate posture but never an
// invisible one: it is logged once, through the `Logger` contract (Law 10),
// naming the reason the composition root supplied.
// ---------------------------------------------------------------------------

/**
 * Build the once-per-loop posture check.
 *
 * The returned guard is called at the point tool calls are dispatched, NOT at
 * construction: every surface registers its `before_tool_call` handler on
 * `loop.hooks` after the loop is built, so a constructor-time scan would always
 * see an empty registry. It is also not called per call — a hook-registry scan
 * does not belong on the hot path — so the guard latches after its first run
 * and every later call is a boolean read.
 */
export function createApprovalPostureGuard(
  safety: AgentSafety,
  hooks: HookRegistry,
  logger: Logger | undefined,
): () => void {
  let checked = false;
  return () => {
    if (checked) return;
    checked = true;
    const posture = safety.approvalPosture;
    if (posture.kind === 'ungated') {
      logger?.warn(
        `agent loop is running UNGATED — no approval policy gates tool calls (reason: ${posture.reason})`,
        { component: 'agent-loop', approvalPosture: 'ungated', reason: posture.reason },
      );
      return;
    }
    if (!hooks.hasHandlers('modifying', 'before_tool_call')) {
      throw new ApprovalPostureError(posture.policy);
    }
  };
}
