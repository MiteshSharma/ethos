import type { Logger } from '@ethosagent/types';

/**
 * One interception of a Pi tool call, as it reaches the host.
 *
 * Pi has NO permission system for its own built-in tools — `bash`/`edit`/
 * `write`/`read` execute unconditionally. The only interception point that
 * exists is the extension API: a `tool_call` handler that can `block`, calling
 * `ctx.ui.*` to ask the host first. So this request did not come from Pi; it
 * came from the gate extension WE ship and mount into the container.
 */
export interface PiGateRequest {
  /** `extension_ui_request.id` — the correlation id the answer must carry back. */
  requestId: string;
  /**
   * The run this tool call belongs to. Pi's frame does not carry it — the host
   * stamps it from its own spec — but every policy above a single run needs
   * it: the router's answer scope is per-job (D17), and a clarify's lane is
   * the job (G1). Without it a gate can only make one decision for everyone.
   */
  jobId: string;
  /** The dialog method Pi used. One of `PI_RUNNER_CAPABILITIES.interactionKinds`. */
  kind: string;
  /** The tool Pi is about to run. */
  toolName: string;
  /** Compact, truncated digest of the tool input — legible, never authoritative. */
  digest: string;
}

export interface PiGateAnswer {
  allow: boolean;
  /** Surfaced to the model as the block reason when `allow` is false. */
  reason?: string;
}

/**
 * The single decision point for "may this tool call proceed".
 *
 * Isolated on purpose: Phase 4 replaces THIS function with the real router
 * (`packages/worker-router` — capability registry, scope cache, ClarifyBridge
 * escalation) and touches nothing else in the transport. Everything around it
 * — framing, correlation, the round-trip — already works and does not need to
 * be rediscovered then.
 */
export type PiGatePolicy = (req: PiGateRequest) => Promise<PiGateAnswer>;

/** Wire prefix the gate extension puts on every dialog title. */
const TITLE_PREFIX = 'ethos:tool_call:';

/**
 * Parse the gate extension's dialog title back into a request.
 *
 * The title is the ONLY channel Pi's dialog methods give us for payload
 * (`select` carries a title and options, nothing else), so the extension
 * encodes `ethos:tool_call:<toolName>\n<digest>` and this reads it back. A
 * title that is not ours returns null — another extension's dialog is not the
 * gate's to answer.
 */
export function parseGateTitle(
  title: string | undefined,
): { toolName: string; digest: string } | null {
  if (!title?.startsWith(TITLE_PREFIX)) return null;
  const body = title.slice(TITLE_PREFIX.length);
  const nl = body.indexOf('\n');
  return nl === -1
    ? { toolName: body, digest: '' }
    : { toolName: body.slice(0, nl), digest: body.slice(nl + 1) };
}

/**
 * Phase 2's policy: approve everything, and say so.
 *
 * Deliberately not a decision engine. Containment for a Pi run is the container
 * boundary (D4), not this gate — the gate exists so Phase 4 has a live,
 * proven interception seam to route through. A gate that quietly made policy
 * now would be a second, weaker boundary nobody reviewed.
 */
export function createAutoApproveGate(logger?: Logger): PiGatePolicy {
  return async (req) => {
    logger?.debug('pi gate: auto-approved tool call', {
      requestId: req.requestId,
      kind: req.kind,
      toolName: req.toolName,
      digest: req.digest,
    });
    return { allow: true };
  };
}
