// Production wiring for the two danger-predicate seams.
//
// `createDangerPredicate` accepts `getPersonality` (which personality's
// approval policy applies to this call) and `smartApprove` (the LLM reviewer
// behind `approvalMode: 'smart'`). Every entry point used to call it with
// NEITHER, so the mode dispatch always resolved to `manual` and
// `safety.denyRules` was never consulted — the config was inert. This module
// builds both seams out of what an entry point already has: the hook
// registries of the loops it owns, and the personality registry those loops
// resolve against.
//
// Cost posture: nothing here runs on the common path. The `session_start`
// handler is a single Map write per turn; the reviewer and its provider are
// constructed only when a flagged call actually reaches `approvalMode: smart`.

import type {
  HookRegistry,
  LLMProvider,
  PersonalityConfig,
  PersonalityRegistry,
} from '@ethosagent/types';
import { createDangerPredicate, type DangerPredicate } from './danger-predicate';
import { createSmartApprover } from './smart-approver';

/**
 * Backstop on the session → personality map. Entries are added on
 * `session_start` and removed on `agent_done`, so the live size is the number
 * of in-flight turns — but a turn that dies without firing `agent_done` would
 * otherwise leak an entry for the process lifetime. Oldest-first eviction past
 * this bound costs a resolved session its personality (falling back to the
 * `manual` default), which is the safe direction to fail.
 */
const MAX_TRACKED_SESSIONS = 4096;

/**
 * Memoise a provider factory so the provider is constructed at most once, and
 * only when someone actually asks for it. Same shape as the completion
 * verifier's getter (`buildVerifierProviderGetter` in `./compose-tools`), but
 * takes the factory rather than a config so each caller keeps its own
 * construction path (the CLI's `createLLM` applies the auth-rotation pool).
 *
 * A failed construction is not cached — the next request retries instead of
 * pinning the caller to a dead handle.
 */
export function createLazyProvider(create: () => Promise<LLMProvider>): () => Promise<LLMProvider> {
  let pending: Promise<LLMProvider> | undefined;
  return () => {
    if (!pending) {
      pending = create();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

export interface CreateApprovalDangerPredicateOptions {
  /**
   * Hook registries of every loop whose turns reach this predicate. The
   * `before_tool_call` payload carries only a `sessionId`, so the personality
   * is learned from each loop's `session_start`.
   */
  hooks: ReadonlyArray<HookRegistry>;
  /** The registry those loops resolve personalities from. */
  personalities: PersonalityRegistry;
  /**
   * Lazy handle to the primary provider — see `createLazyProvider` above.
   * Only awaited when a flagged call reaches `approvalMode: 'smart'`.
   */
  getProvider: () => Promise<LLMProvider>;
  /** Model the smart reviewer runs on (the primary model today). */
  model: string;
  /**
   * Extra tools that always require approval, in every mode. All three
   * production callers — `apps/ethos/src/commands/serve.ts` and
   * `apps/desktop/src/main/serve.ts` (web modal) and
   * `apps/ethos/src/commands/gateway.ts` (Slack card) — pass
   * `APPROVAL_SURFACE_ALWAYS_ASK`, the set of tools that must never run
   * unprompted on a surface that can prompt. A caller with additional
   * deployment-specific tools to gate unions them in here. Under
   * `approvalMode: 'smart'` the predicate unions this with
   * `SMART_MODE_CONSEQUENTIAL_TOOLS` — under `manual` and `off` this is the
   * only non-hardline danger source.
   */
  alwaysAsk?: ReadonlyArray<string>;
}

/**
 * Build the danger predicate an approval surface (web modal, Slack/Telegram
 * card) gates tool calls with, wired to the personality that is actually
 * running the turn.
 *
 * Registers two void hooks per supplied registry. Both are fire-and-forget
 * bookkeeping — neither can reject a turn.
 */
export function createApprovalDangerPredicate(
  opts: CreateApprovalDangerPredicateOptions,
): DangerPredicate {
  const activeBySession = new Map<string, string>();

  for (const hooks of opts.hooks) {
    hooks.registerVoid('session_start', async (payload) => {
      if (!payload.personalityId) return;
      activeBySession.set(payload.sessionId, payload.personalityId);
      if (activeBySession.size > MAX_TRACKED_SESSIONS) {
        const oldest = activeBySession.keys().next();
        if (!oldest.done) activeBySession.delete(oldest.value);
      }
    });
    hooks.registerVoid('agent_done', async (payload) => {
      activeBySession.delete(payload.sessionId);
    });
  }

  // Deferred so a deployment where no personality declares `smart` never
  // constructs the reviewer — and therefore never constructs a provider.
  let approver: ReturnType<typeof createSmartApprover> | undefined;

  return createDangerPredicate({
    ...(opts.alwaysAsk ? { alwaysAsk: opts.alwaysAsk } : {}),
    getPersonality: (payload): PersonalityConfig | undefined => {
      const id = activeBySession.get(payload.sessionId);
      // Unknown session (no `session_start` seen) → no personality, which is
      // the legacy `manual` default. Never guess a personality here: guessing
      // could apply another personality's `approvalMode: 'off'`.
      return id === undefined ? undefined : opts.personalities.get(id);
    },
    smartApprove: (payload, reason) => {
      approver ??= createSmartApprover({ getProvider: opts.getProvider, model: opts.model });
      return approver(payload, reason);
    },
  });
}
