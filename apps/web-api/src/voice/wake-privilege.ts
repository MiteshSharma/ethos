import type { PersonalityConfig } from '@ethosagent/types';
import { APPROVAL_SURFACE_ALWAYS_ASK, SMART_MODE_CONSEQUENTIAL_TOOLS } from '@ethosagent/wiring';

// What makes a personality PRIVILEGED, for the wake surface only.
//
// The wake surface needs this because a voice in the room is an unauthenticated
// caller: until speaker-ID lands (voice V3 explicit follow-up), anyone within
// earshot can trigger a route, and route-level opt-in is the entire access
// control. So the question "may this phrase reach this personality by default?"
// has to have an answer, and the answer has to be computable from what a
// personality already declares.
//
// REUSED, NOT INVENTED. There is no pre-existing "privileged personality" notion
// in the codebase — the closest things are per-CALL: the danger predicate's
// consequential-tool lists, which decide whether one tool call needs an
// approval. Those lists are the right raw material and the wrong granularity, so
// this lifts them rather than writing a second opinion about what is
// consequential: a personality is privileged when its toolset can REACH a tool
// the approval layer would already stop and ask about. If that list grows, this
// grows with it, which is the point of not forking it.
//
// This is the ONE definition. Nothing else in the wake path decides privilege.

/** Tool names whose presence in a toolset makes a personality privileged. */
const CONSEQUENTIAL_TOOLS: ReadonlySet<string> = new Set([
  ...SMART_MODE_CONSEQUENTIAL_TOOLS,
  ...APPROVAL_SURFACE_ALWAYS_ASK,
]);

/**
 * True when a wake route must set `privileged: true` before this personality is
 * reachable by voice.
 *
 * An ABSENT toolset means "every registered tool", which includes every
 * consequential one — so it is privileged. Fail-closed is the only safe reading
 * here: the cost of a false positive is one config line the operator writes on
 * purpose, and the cost of a false negative is a stranger at the window running
 * `terminal`.
 */
export function isPrivilegedPersonality(config: PersonalityConfig): boolean {
  const toolset = config.toolset;
  if (toolset === undefined) return true;
  return toolset.some((tool) => CONSEQUENTIAL_TOOLS.has(tool));
}
