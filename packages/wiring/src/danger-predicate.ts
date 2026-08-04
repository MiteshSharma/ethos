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

/**
 * Tools flagged for review **under `approvalMode: 'smart'` only**.
 *
 * Why smart-only: a personality that opts into `smart` is explicitly asking for
 * an LLM to judge its consequential calls. Before this list existed the only
 * non-hardline danger source was a caller-supplied `alwaysAsk`, which no
 * production caller passes — so `dangerReason` was always `null` under `smart`
 * and the reviewer was structurally unreachable. Confining the list to `smart`
 * keeps `manual` and `off` byte-identical to their previous behaviour: their
 * flag set stays exactly `opts.alwaysAsk` (empty unless a caller passes one).
 *
 * **Composition: union, not override.** Under `smart` the effective flag set is
 * `alwaysAsk ∪ SMART_MODE_CONSEQUENTIAL_TOOLS`; under `manual` / `off` it is
 * `alwaysAsk` alone. An explicit `alwaysAsk` therefore always takes effect, in
 * every mode — this list can only add to it, never replace or subtract from it.
 * That matches the module's law that modes only make things stricter.
 *
 * **Scope: mutating-or-executing only.** Read-only tools (`read_file`,
 * `search_files`, `list_*`, `web_search`, the `browser_*` readers) are
 * deliberately absent: flagging a lookup would cost an LLM round-trip per read
 * for no safety benefit. `run_code` is also absent — it executes inside an
 * isolated container with no network, no `fs_reach`, and a memory cap, so the
 * sandbox is already the containment. `process_stop` / `process_list` /
 * `process_logs` observe or wind down work this list already gated at spawn.
 *
 * **Cost.** `createSmartApprover` caches verdicts on
 * `sha256(toolName + canonicalized args)`, so a repeated identical call is
 * served from cache and never re-reviewed. Worst case under `smart` is
 * therefore one reviewer call per *distinct* consequential call — a typical
 * turn that writes two files and runs one command costs three, and a retry loop
 * re-issuing the same command costs zero more.
 *
 * Not a frozen contract: it is a default. Callers that want a different set
 * pass `alwaysAsk`, and a personality that wants a specific call refused
 * outright uses `safety.denyRules`, which is evaluated before this.
 */
export const SMART_MODE_CONSEQUENTIAL_TOOLS: ReadonlyArray<string> = [
  // Shell execution on the host or execution backend — the widest-reach tool in
  // the registry, and the only path to file deletion or move (no dedicated tool
  // exists for either). The hardline check still short-circuits ahead of the
  // reviewer for the commands it refuses outright.
  'terminal',
  // Creates or overwrites a file; an overwrite discards the prior content with
  // no tool-layer undo.
  'write_file',
  // In-place edit of existing file content — same irreversibility as
  // `write_file`, at finer granularity.
  'patch_file',
  // Spawns a background process that outlives the turn, so nothing later in the
  // turn can be relied on to clean it up.
  'process_start',
];

export interface CreateDangerPredicateOptions {
  /**
   * Tools that always require approval, in every mode. Unioned with
   * {@link SMART_MODE_CONSEQUENTIAL_TOOLS} when the resolved personality is on
   * `approvalMode: 'smart'`; used alone under `manual` and `off`.
   */
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
 *   3. Flagged tool / non-hardline danger → consult approvalMode. The flag set
 *      is `alwaysAsk` under manual and off, and
 *      `alwaysAsk ∪ SMART_MODE_CONSEQUENTIAL_TOOLS` under smart:
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
  // Built once; `smart` is the only mode that sees it (see the const's docs).
  const smartAlwaysAsk = new Set([...alwaysAsk, ...SMART_MODE_CONSEQUENTIAL_TOOLS]);
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

    // Non-hardline danger. The mode is resolved first because it selects the
    // flag set: `smart` adds the built-in consequential-tool list on top of
    // `alwaysAsk`, `manual` / `off` see `alwaysAsk` alone.
    // Future: per-tool risk classifiers (sql_execute, kubectl, etc.)
    // would also produce non-hardline reasons that route through here.
    const mode = safety?.approvalMode ?? 'manual';
    const flagged = mode === 'smart' ? smartAlwaysAsk : alwaysAsk;
    let dangerReason: string | null = null;
    if (flagged.has(payload.toolName)) {
      dangerReason = `${payload.toolName} requires explicit approval`;
    }
    if (!dangerReason) return null;

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
