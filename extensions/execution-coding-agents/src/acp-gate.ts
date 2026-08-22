import type { InteractionRequest, Logger } from '@ethosagent/types';
import { type InteractionRouter, RUN_SCOPE_ANSWER } from '@ethosagent/worker-router';
import type { AcpPermissionOption, AcpRequestPermissionOutcome } from './acp-protocol';

/**
 * One `session/request_permission` call, already unwrapped from its JSON-RPC
 * envelope by `AcpHost` — the real-ACP analogue of `execution-pi/src/gate.ts`'s
 * `PiGateRequest`, translating a DIFFERENT wire shape into the same shape of
 * question.
 */
export interface AcpGateRequest {
  /** The JSON-RPC request id — the correlation id the response travels back on. */
  requestId: string;
  jobId: string;
  sessionId: string;
  toolCallId: string;
  /** `toolCall.title`, when the agent supplied one — the closest ACP gets to a tool name. */
  toolName?: string;
  /**
   * `toolCall.kind` (ACP's closed `ToolKind` enum: read/edit/delete/move/
   * search/execute/think/fetch/switch_mode/other) — routed through as the
   * `InteractionRequest.kind` the SAME way Pi's gate passes its own dialog
   * method through unchanged (D16: the router's kinds are open strings, and
   * this is the agent's vocabulary, not a schema this package owns). Absent
   * when the agent didn't categorize the tool call.
   */
  kind?: string;
  /** Compact, legible digest of `toolCall.rawInput`. Never authoritative. */
  digest: string;
  /** The options the AGENT is offering — its own optionIds, not ours to invent. */
  options: AcpPermissionOption[];
}

export type AcpGateAnswer = AcpRequestPermissionOutcome;

/**
 * The single decision point for "may this tool call proceed" — the ACP
 * analogue of `PiGatePolicy`. Isolated on purpose so the router-backed
 * implementation below is the only thing that changes if the decision policy
 * ever does.
 */
export type AcpGatePolicy = (req: AcpGateRequest) => Promise<AcpGateAnswer>;

/** Answer texts the card offers. The middle one carries D17's `'run'` scope (pi-delegation). */
const ALLOW_ONCE = 'Allow once';
const DENY = 'Deny';
const GATE_OPTIONS = [ALLOW_ONCE, RUN_SCOPE_ANSWER, DENY].map((label) => ({
  value: label,
  label,
}));

/**
 * What counts as "yes" — the offered options plus the words a human actually
 * types when answering free-text on a channel like Telegram. Copied verbatim
 * from `execution-pi/src/router-gate.ts`'s list rather than imported: fail
 * closed by construction, same reasoning — an ambiguous or novel answer is a
 * denial, never a guessed allow.
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
 * Pick the ACP `optionId` that best matches our allow/deny decision from
 * whatever options the AGENT actually offered — never invented, since an
 * `optionId` this host makes up would not exist on the agent's side.
 *
 * `always` is preferred over `once` when the router's answer scope was
 * anything other than `'once'` (mirrors D17's run/always scoping); falls back
 * to the other kind in the same family when the agent didn't offer that exact
 * one. Returns `undefined` when the agent's `options` contain NO option of the
 * requested family at all — the malformed/impoverished-request case named as
 * a flagged gap in the plan's Failure modes table. Resolved here conservatively
 * (see `toOutcome` below): never guess an optionId, degrade to `cancelled`.
 */
function pickOption(
  options: AcpPermissionOption[],
  family: 'allow' | 'reject',
  preferAlways: boolean,
): AcpPermissionOption | undefined {
  const preferredKind = preferAlways ? `${family}_always` : `${family}_once`;
  const fallbackKind = preferAlways ? `${family}_once` : `${family}_always`;
  return (
    options.find((o) => o.kind === preferredKind) ?? options.find((o) => o.kind === fallbackKind)
  );
}

function toOutcome(
  options: AcpPermissionOption[],
  allow: boolean,
  preferAlways: boolean,
  logger: Logger | undefined,
  req: AcpGateRequest,
): AcpGateAnswer {
  const picked = pickOption(options, allow ? 'allow' : 'reject', preferAlways);
  if (picked) return { outcome: 'selected', optionId: picked.optionId };
  // The agent's own `options` array offered nothing in the family our decision
  // needs (e.g. an allow decision but the agent listed only reject_* kinds, or
  // sent an empty array). Fail closed: cancel rather than select an optionId
  // that does not exist on the wire, or silently reinterpret the decision.
  logger?.warn('acp gate: no matching permission option offered by the agent; cancelling', {
    jobId: req.jobId,
    toolCallId: req.toolCallId,
    allow,
    offeredKinds: options.map((o) => o.kind),
  });
  return { outcome: 'cancelled' };
}

/**
 * Approve everything, and say so — the ACP analogue of
 * `execution-pi/src/gate.ts`'s `createAutoApproveGate`. Not a decision
 * engine: containment for a run is the container boundary (D4), not this
 * gate. Exists so a standalone construction (tests, a deployment with no
 * `InteractionRouter` wired) still runs, same rationale as Pi's default.
 *
 * Prefers `allow_always` when the agent offered it (fewer future prompts),
 * falling back to `allow_once`, and to `cancelled` when the agent's own
 * `options` offered no allow-shaped choice at all — never guesses an
 * `optionId` that does not exist on the wire.
 */
export function createAutoApproveGate(logger?: Logger): AcpGatePolicy {
  return async (req) => {
    const picked = pickOption(req.options, 'allow', true);
    logger?.debug('acp gate: auto-approved tool call', {
      jobId: req.jobId,
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      digest: req.digest,
      picked: picked?.optionId,
    });
    return picked ? { outcome: 'selected', optionId: picked.optionId } : { outcome: 'cancelled' };
  };
}

/**
 * The real-ACP gate: every gated tool call goes through the SAME worker
 * router `execution-pi`'s `createRouterGate` already uses (D-ACP1's whole
 * point — one router, two callers). Translates a `session/request_permission`
 * payload into an `InteractionRequest`, gets back an `InteractionAnswer`, and
 * translates THAT into the `RequestPermissionOutcome` shape ACP's response
 * requires — never the agent's raw optionId vocabulary passed through
 * unexamined, so an unaffirmed answer can never be misread as consent.
 *
 * A router that throws (the `secret` rule, or an escalation that failed with
 * no default) propagates: `AcpHost` catches it and answers `cancelled`, so a
 * policy failure can never be read as an allow — same contract
 * `execution-pi`'s host has with its own gate.
 */
export function createRouterGate(
  router: Pick<InteractionRouter, 'route'>,
  logger?: Logger,
): AcpGatePolicy {
  return async (req) => {
    const interaction: InteractionRequest = {
      requestId: req.requestId,
      // Falls back to a generic kind when the agent didn't categorize the
      // tool call — same "unknown kind degrades to asking a human" posture
      // D16 already documents for the router itself.
      kind: req.kind ?? 'tool_call_permission',
      prompt: `The agent wants to run \`${req.toolName ?? req.toolCallId}\`: ${req.digest || '(no input)'}. Allow?`,
      options: GATE_OPTIONS,
      ...(req.toolName ? { toolName: req.toolName } : {}),
    };

    const answer = await router.route(req.jobId, interaction);
    const allow = isAffirmative(answer.value);
    const outcome = toOutcome(req.options, allow, answer.scope !== 'once', logger, req);
    logger?.debug('acp gate: routed tool call', {
      jobId: req.jobId,
      requestId: req.requestId,
      toolCallId: req.toolCallId,
      allow,
      scope: answer.scope,
      source: answer.source,
      outcome,
    });
    return outcome;
  };
}
