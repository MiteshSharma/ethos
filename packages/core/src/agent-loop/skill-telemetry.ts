import type { AgentLoopObservability } from '../observability/agent-loop-observability';

/**
 * AN-C1 — skill telemetry, in one place.
 *
 * Two facts, deliberately separate. `exposed` is injection-mode presence: the
 * skill sat in the prompt whether the model used it or not, a token bill paid
 * every turn. `invoked` is a deliberate `get_skill` call: a choice the model
 * made once. `ethos usage --by-skill` reports them as distinct columns because
 * one combined "skill used" number hides which of the two you are paying for.
 *
 * Both emits live here rather than at their call sites so the two stage files
 * carry an import and a call, not the rule — the same split
 * `agent-loop/ingestion-cap.ts` uses.
 */

/** The `name` argument of a `get_skill` call, when it is a usable string. */
export function invokedSkillName(args: unknown): string | undefined {
  const name = (args as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Record every skill that reached this turn's prompt.
 *
 * Called once per turn from context assembly, which is the per-turn dedup the
 * contract asks for: `skillFilesUsed` is already the injector's deduped list,
 * and assembly runs exactly once.
 */
export function recordSkillsExposed(
  observability: AgentLoopObservability | undefined,
  skills: readonly string[] | undefined,
  traceId: string | undefined,
): void {
  if (!skills || !observability?.recordSkillInvocation) return;
  for (const skill of skills) {
    observability.recordSkillInvocation({
      ...(traceId ? { traceId } : {}),
      skill,
      mode: 'exposed',
    });
  }
}

/** Record a deliberate `get_skill` call. No-op for any other tool. */
export function recordSkillInvoked(
  observability: AgentLoopObservability | undefined,
  toolName: string,
  args: unknown,
  traceId: string | undefined,
): void {
  if (toolName !== 'get_skill' || !observability?.recordSkillInvocation) return;
  const skill = invokedSkillName(args);
  if (!skill) return;
  observability.recordSkillInvocation({
    ...(traceId ? { traceId } : {}),
    skill,
    mode: 'invoked',
  });
}
