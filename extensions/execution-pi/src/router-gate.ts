import type { InteractionRequest, Logger } from '@ethosagent/types';
import { type InteractionRouter, RUN_SCOPE_ANSWER } from '@ethosagent/worker-router';
import type { PiGatePolicy } from './gate';

/** Answer texts the card offers. The middle one carries D17's `'run'` scope. */
const ALLOW_ONCE = 'Allow once';
const DENY = 'Deny';
const GATE_OPTIONS = [ALLOW_ONCE, RUN_SCOPE_ANSWER, DENY].map((label) => ({
  value: label,
  label,
}));

/**
 * What counts as "yes" — the offered options plus the words a human actually
 * types when they answer a permission question in free text on Telegram.
 *
 * Fail closed by construction: anything NOT on this list is a denial, so an
 * ambiguous answer, an empty timeout default, a cancel, or a novel phrasing all
 * stop the tool call rather than run it. A false deny costs a re-ask; a false
 * allow runs a command in someone's repo.
 */
const AFFIRMATIVE = new Set([
  ALLOW_ONCE.toLowerCase(),
  RUN_SCOPE_ANSWER.toLowerCase(),
  'allow',
  'approve',
  'ok',
  'okay',
  'proceed',
  'y',
  'yes',
]);

function isAffirmative(value: unknown): boolean {
  return typeof value === 'string' && AFFIRMATIVE.has(value.trim().toLowerCase());
}

/**
 * The Phase 4 gate: every gated Pi tool call goes through the worker router.
 *
 * Replaces `createAutoApproveGate` and touches nothing else in the transport —
 * the framing, correlation, and round-trip Phase 2 proved stay exactly as they
 * were. All this adds is the decision: cached answer, auto-resolving
 * capability, or a human (plan §3.5).
 *
 * A router that throws (the `secret` rule, or a clarify that timed out with no
 * default) propagates: `runPiHost` catches it and denies, so a policy failure
 * can never be read as an allow.
 */
export function createRouterGate(
  router: Pick<InteractionRouter, 'route'>,
  logger?: Logger,
): PiGatePolicy {
  return async (req) => {
    const interaction: InteractionRequest = {
      requestId: req.requestId,
      // Pi's own dialog method (`select`), passed through unchanged — the
      // router's kinds are open strings and this is Pi's vocabulary, not a
      // schema (D16).
      kind: req.kind,
      prompt: `Pi wants to run \`${req.toolName}\`: ${req.digest || '(no input)'}. Allow?`,
      options: GATE_OPTIONS,
      toolName: req.toolName,
    };

    const answer = await router.route(req.jobId, interaction);
    const allow = isAffirmative(answer.value);
    logger?.debug('pi gate: routed tool call', {
      jobId: req.jobId,
      requestId: req.requestId,
      toolName: req.toolName,
      allow,
      scope: answer.scope,
      source: answer.source,
    });
    if (allow) return { allow: true };
    const reason = typeof answer.value === 'string' && answer.value.trim() ? answer.value : DENY;
    return { allow: false, reason };
  };
}
