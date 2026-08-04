// Ch.4 — danger predicate for the before_tool_call hook.
//
// Lives in its own file so tests can import it without dragging in
// the full createAgentLoop wiring (which depends on plugin-loader,
// sandbox-docker, etc. and chokes outside the monorepo install).

import { checkCommand } from '@ethosagent/tools-terminal';
import type { BeforeToolCallPayload, PersonalityConfig } from '@ethosagent/types';

/** Result returned by a danger predicate. `null` = no approval needed. */
export type DangerReason = string | null;
export type DangerPredicate = (payload: BeforeToolCallPayload) => Promise<DangerReason>;

/**
 * Verdict returned by a smart-approval reviewer.
 *
 *   `approve` — low residual risk; the call proceeds with no prompt.
 *   `deny`    — the call must not run; the reason surfaces to the agent.
 *   `ask`     — undecided; falls through to the normal approval flow.
 *
 * `ask` is the fail-closed default: any error, timeout, or unparseable
 * reviewer response maps to `ask`, never to `approve`.
 */
export interface SmartVerdict {
  decision: 'approve' | 'deny' | 'ask';
  reason: string;
}

/**
 * Ch.4b — auxiliary classifier hook. When `approvalMode: smart` is set,
 * the danger predicate consults this callback (typically a cheap-model
 * call) for a `dangerous` classification: low residual risk →
 * auto-approve, high residual risk → leave the dangerous flag in place
 * so the approval modal still fires. `approve` is the only fast-path;
 * any uncertainty falls through to the approval flow.
 */
export type SmartApprovalCallback = (
  payload: BeforeToolCallPayload,
  reason: string,
) => Promise<SmartVerdict>;

export interface CreateDangerPredicateOptions {
  alwaysAsk?: ReadonlyArray<string>;
  /** Resolves the active personality config for a given session. The
   *  predicate uses it to read `safety.approvalMode`. Optional — when
   *  unset, every personality falls through to the legacy `manual`
   *  default behavior (return reason for terminal hardline, null
   *  otherwise). */
  getPersonality?: (payload: BeforeToolCallPayload) => PersonalityConfig | undefined;
  /** Smart-mode callback (see SmartApprovalCallback above). */
  smartApprove?: SmartApprovalCallback;
  /**
   * Capability gate for `approvalMode: 'off'`. Without this set to
   * true, the predicate treats `off` as `manual` — i.e. it will NOT
   * auto-approve any dangerous tool, even when the personality config
   * declares `off`. The personality-registry load-time check rejects
   * `off` + channel ingress, but this flag is the predicate-local
   * guarantee that survives any future caller bypassing the registry
   * (Codex flagged the prior cross-module-only invariant as security-
   * rot shaped).
   *
   * **Today, NO production caller passes this flag.** There are three
   * production construction sites — `apps/ethos/src/commands/serve.ts:893`
   * and `apps/desktop/src/main/serve.ts:134` (both feeding the web-profile
   * approval modal) and `apps/ethos/src/commands/gateway.ts:1440` (feeding
   * the Slack approval card) — and all three intentionally omit the flag:
   * web and Slack both have channel ingress, so `off` mode would be
   * rejected by the registry anyway, and the predicate refuses to honor it
   * as a second-line check. CLI / TUI use the synchronous
   * `createTerminalGuardHook` (hard-block, no
   * approval flow). The cron / batch runners would be the natural
   * future caller — when they grow an approval flow, they would
   * construct the predicate with `allowAutoApproveDangerousTools: true`
   * once they verify trusted-local execution conditions.
   *
   * As a result, `approvalMode: 'off'` has no observable runtime
   * effect today; it is config-only documentation until a caller
   * opts in. That is intentional: the capability gate is the API
   * contract that prevents any future caller from accidentally
   * auto-approving dangerous tools.
   */
  allowAutoApproveDangerousTools?: boolean;
}

/**
 * Stable stringification of tool args — sorted keys, so `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same text. Shared with `createSmartApprover`, whose
 * verdict cache keys off the same canonical form.
 */
export function canonicalizeArgs(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalizeArgs).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeArgs(v)}`).join(',')}}`;
}

/** First deny rule matching this call, or null. Case-sensitive substring. */
function matchDenyRule(
  rules: ReadonlyArray<string> | undefined,
  payload: BeforeToolCallPayload,
): string | null {
  if (!rules?.length) return null;
  const subject = `${payload.toolName} ${canonicalizeArgs(payload.args)}`;
  return rules.find((rule) => rule.length > 0 && subject.includes(rule)) ?? null;
}

/**
 * Default danger predicate.
 *
 * **The law: deny rules are the floor; modes can only make things stricter,
 * never looser.** `safety.denyRules` is matched BEFORE the approval-mode
 * dispatch, so a matching rule surfaces its reason even under
 * `approvalMode: 'off'` with `allowAutoApproveDangerousTools: true`. No mode
 * can auto-approve past a deny rule. (What this seam can express is
 * "reason vs. null" — a denied call still reaches the surface's approval flow
 * rather than hard-failing, which is the same shape a hardline command gets.)
 *
 * Resolution order:
 *   1. Hardline command  → return reason (Ch.4a — non-overridable; the
 *                          terminalGuardHook hard-blocks separately so
 *                          this is belt + suspenders).
 *   2. Deny rule match   → return reason, regardless of mode.
 *   3. Always-ask / non-hardline danger → consult approvalMode:
 *        manual (default) → return the reason (drives the modal).
 *        off              → return null (auto-approve — hardline still
 *                           hard-blocks separately).
 *        smart            → consult `smartApprove` callback. `approve`
 *                           auto-approves; `deny` surfaces the reviewer's
 *                           specific reason; `ask` surfaces the generic
 *                           danger reason. Without the callback wired,
 *                           smart degrades to manual.
 *
 * The plan reserves `off` for trusted local automation (cron, batch);
 * the load-time check in personality registry rejects `off` + channel
 * ingress so a remote sender can never drive an auto-approved
 * dangerous tool.
 */
export function createDangerPredicate(opts: CreateDangerPredicateOptions = {}): DangerPredicate {
  const alwaysAsk = new Set(opts.alwaysAsk ?? []);
  return async (payload) => {
    // Hardline command first — non-overridable in every mode.
    let hardlineReason: string | null = null;
    if (payload.toolName === 'terminal') {
      const args = payload.args as { command?: string } | null | undefined;
      if (args?.command) {
        const result = checkCommand(args.command);
        if (result.dangerous) hardlineReason = result.reason;
      }
    }
    if (hardlineReason) return hardlineReason;

    const safety = opts.getPersonality?.(payload)?.safety;

    // Deny rules — the floor, evaluated before the mode dispatch.
    const denyRule = matchDenyRule(safety?.denyRules, payload);
    if (denyRule) return `denied by personality deny rule: ${denyRule}`;

    // Non-hardline danger — alwaysAsk is the only such source today.
    // Future: per-tool risk classifiers (sql_execute, kubectl, etc.)
    // would also produce non-hardline reasons that route through here.
    let dangerReason: string | null = null;
    if (alwaysAsk.has(payload.toolName)) {
      dangerReason = `${payload.toolName} requires explicit approval`;
    }
    if (!dangerReason) return null;

    const mode = safety?.approvalMode ?? 'manual';
    if (mode === 'off' && opts.allowAutoApproveDangerousTools === true) return null;
    if (mode === 'smart' && opts.smartApprove) {
      const verdict = await opts.smartApprove(payload, dangerReason);
      if (verdict.decision === 'approve') return null;
      // A reviewer `deny` carries a concrete, actionable reason — surface it
      // so the agent can course-correct. `ask` is undecided, so it keeps the
      // generic danger reason and routes to the normal approval flow.
      return verdict.decision === 'deny' ? `denied by reviewer: ${verdict.reason}` : dangerReason;
    }
    return dangerReason;
  };
}
