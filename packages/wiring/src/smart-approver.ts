// LLM-judged smart approvals — the reviewer behind `approvalMode: 'smart'`.
//
// The danger predicate calls this only for tool calls that already reached the
// danger branch (hardline commands, always-ask tools). The common path never
// pays for it, and a personality on `manual` or `off` never constructs the
// provider at all.

import { createHash } from 'node:crypto';
import type { BeforeToolCallPayload, LLMProvider, Message } from '@ethosagent/types';
import type { SmartApprovalCallback, SmartVerdict } from './danger-predicate';
import { canonicalizeArgs } from './danger-predicate';

/** Wall-clock bound on the reviewer round-trip. Exceeding it yields `ask`. */
const DEFAULT_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT =
  'You review tool calls an autonomous agent wants to make, and decide whether ' +
  'the call needs a human in the loop. Answer with a single JSON object and no ' +
  'other text: {"decision":"approve"|"deny"|"ask","reason":"..."} where\n' +
  '  approve — the call is routine and reversible; let it run unattended.\n' +
  '  deny    — the call is destructive, irreversible, or clearly outside the ' +
  'stated task; it must not run.\n' +
  '  ask     — anything you are not confident about; a human decides.\n' +
  'Prefer "ask" over "approve" whenever you hesitate. Keep "reason" to one ' +
  'short sentence naming the concrete risk.';

export interface CreateSmartApproverOptions {
  /**
   * Lazy provider handle. Never invoked unless a tool call actually reaches
   * the reviewer, so `manual` / `off` personalities pay nothing for it.
   */
  getProvider: () => Promise<LLMProvider>;
  /** Model the reviewer runs on, passed as `modelOverride`. */
  model: string;
  /** Round-trip bound; on expiry the verdict is `ask`. Default 15s. */
  timeoutMs?: number;
}

/**
 * Cache key. Scoped to the exact call, NOT the tool name: an approval for
 * `rm -rf ./build` must never short-circuit `rm -rf ./src`.
 */
function verdictKey(payload: BeforeToolCallPayload): string {
  return createHash('sha256')
    .update(`${payload.toolName} ${canonicalizeArgs(payload.args)}`)
    .digest('hex');
}

function parseVerdict(text: string): SmartVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { decision, reason } = parsed as { decision?: unknown; reason?: unknown };
  if (decision !== 'approve' && decision !== 'deny' && decision !== 'ask') return null;
  return { decision, reason: typeof reason === 'string' ? reason : 'no reason given' };
}

async function review(
  provider: LLMProvider,
  model: string,
  payload: BeforeToolCallPayload,
  dangerReason: string,
): Promise<SmartVerdict | null> {
  const messages: Message[] = [
    {
      role: 'user',
      content:
        `Tool: ${payload.toolName}\n` +
        `Arguments: ${canonicalizeArgs(payload.args)}\n` +
        `Why it was flagged: ${dangerReason}`,
    },
  ];
  let text = '';
  for await (const chunk of provider.complete(messages, [], {
    system: SYSTEM_PROMPT,
    maxTokens: 200,
    temperature: 0,
    modelOverride: model,
  })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }
  return parseVerdict(text);
}

/**
 * Build the `approvalMode: 'smart'` reviewer.
 *
 * **Fail closed.** Every failure mode — provider construction error, stream
 * error, timeout, unparseable response — yields `{ decision: 'ask' }`, which
 * routes the call back into the normal approval flow. `approve` is only ever
 * returned for a verdict the model actually produced.
 *
 * **Never throws.** `fireModifying` is fail-OPEN on handler throw
 * (`packages/core/src/hook-registry.ts:105-107` catches and continues), so an
 * approver that propagated an exception would let the dangerous tool *execute*
 * — the exact inverse of this module's posture. Every error is caught here.
 *
 * **Known limitation: reviewer spend is not attributed.** There is no path
 * from a `before_tool_call` hook into per-turn cost accounting — `sessionCosts`
 * has two writers, both needing a `ToolResult` or stage deps, and the map is
 * private to `AgentLoop`. Closing it means an `extraCostUsd` field on
 * `BeforeToolCallResult`, a contract change under `packages/types/`. Existing
 * precedent discards usage the same way: `extensions/tools-kanban/src/verifier.ts`
 * records nothing, and `extensions/eval-harness/src/scorers.ts` drops the usage
 * chunks entirely. Volume is bounded instead of measured: the reviewer fires
 * only for calls that already reached the danger branch. Attribution is a
 * follow-up.
 *
 * The cheap-model auxiliary split (an `auxiliary.approvals` config block, the
 * shape `build-agent-loop.ts` uses for `auxiliaryVision` / `auxiliaryWeb`) is a
 * deliberate follow-up. `approvalMode: 'smart'` ships in no personality today,
 * so wiring config surface for it now would be speculative; callers pass the
 * primary model until someone opts in.
 */
export function createSmartApprover(opts: CreateSmartApproverOptions): SmartApprovalCallback {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Only model-produced verdicts are cached — a timeout or parse failure must
  // not stick to the call forever.
  const cache = new Map<string, SmartVerdict>();

  return async (payload, dangerReason) => {
    const key = verdictKey(payload);
    const cached = cache.get(key);
    if (cached) return cached;

    let timer: NodeJS.Timeout | undefined;
    try {
      const provider = await opts.getProvider();
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      });
      const verdict = await Promise.race([
        review(provider, opts.model, payload, dangerReason),
        timeout,
      ]);
      if (!verdict) return { decision: 'ask', reason: 'reviewer gave no usable verdict' };
      cache.set(key, verdict);
      return verdict;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { decision: 'ask', reason: `reviewer error (fail-closed): ${message}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
