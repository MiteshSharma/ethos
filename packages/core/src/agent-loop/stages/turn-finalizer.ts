import type {
  AgentEvent,
  DryRunToolPlan,
  HookRegistry,
  SessionStore,
  TurnAuditContext,
  TurnAuditor,
  TurnFinding,
} from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';

/**
 * Total wall-clock the turn will spend on auditing, across ALL auditors — not
 * a per-auditor allowance, or N auditors would cost N × the budget. The turn
 * has already produced its answer; this is latency the user waits through
 * before `done`, so it is small and hard.
 */
const TURN_AUDIT_BUDGET_MS = 250;

/** Tool name the `_grounding` progress line is attributed to. Not a real tool
 *  — it is the framework speaking, the same way the budget warnings do. */
const GROUNDING_TOOL_NAME = '_grounding';

/**
 * Run every auditor against the finished turn and collect what they found.
 *
 * Fail-open in both directions an auditor can fail. A throw is swallowed by
 * `allSettled`; a hang is cut by racing each auditor against ONE shared
 * deadline, so the budget bounds the total while auditors that did finish keep
 * their findings (a single race around `allSettled` would discard them). A
 * late auditor's promise stays pending forever, which is its own leak, but it
 * cannot reject unhandled — `allSettled` attached a handler to it at the start
 * and keeps it whether the race won or lost.
 *
 * `audit` is invoked INSIDE a `Promise.resolve().then(...)` rather than called
 * directly in the `map`. Fail-open would otherwise be a half-truth: a
 * `TurnAuditor` is an interface, so `audit` need not be `async`, and one that
 * throws SYNCHRONOUSLY — a plain method, a guard clause, a bad destructure —
 * throws while the array is still being built, before `allSettled` exists to
 * settle anything. The exception would escape `finalizeTurn`, and the turn
 * would end with no `done` event at all: the loop hangs on the very failure the
 * budget and the `allSettled` were written to absorb. Deferring the call turns
 * that throw into a rejection the existing handling already covers.
 */
async function runTurnAuditors(
  auditors: readonly TurnAuditor[],
  auditCtx: TurnAuditContext,
  traceId: string | undefined,
  observability: AgentLoopObservability | undefined,
): Promise<TurnFinding[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TURN_AUDIT_BUDGET_MS);
  });
  try {
    const settled = await Promise.allSettled(
      auditors.map((auditor) =>
        Promise.race([
          Promise.resolve()
            .then(() => auditor.audit(auditCtx))
            .then((findings) => ({ auditorId: auditor.id, findings })),
          deadline,
        ]),
      ),
    );
    const out: TurnFinding[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled' || result.value === null) continue;
      for (const finding of result.value.findings) {
        observability?.recordGroundingFinding?.({
          ...(traceId ? { traceId } : {}),
          code: finding.code,
          severity: finding.severity,
          cause: finding.message,
          auditorId: result.value.auditorId,
          ...(finding.claim !== undefined ? { claim: finding.claim } : {}),
        });
        out.push(finding);
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A1 — per-turn token/cost rollup accumulator.
 *
 * `messages` rows are authoritative (analytics decision 9); the session's
 * `input_tokens / output_tokens / cache_* / estimated_cost_usd` columns are a
 * derived display cache. So this only ever accumulates what `streamStep` wrote
 * onto a message row — tool-incurred costs, which never reach `messages`, stay
 * out of it, or the `rollup == SUM(messages)` invariant would break.
 */
export interface TurnUsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}

export function createTurnUsage(): TurnUsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
  };
}

/**
 * Drain the accumulator into the session's rollup columns.
 *
 * Draining makes the call idempotent, so the loop's early exits (abort, fatal
 * stream failure, unrecoverable overflow, return-direct) can flush without
 * double-counting when `finalizeTurn` also runs. A turn that never reaches the
 * finalizer still leaves the rollup equal to `SUM(messages)`.
 *
 * Write first, drain only on success: if `updateUsage` throws, the accumulator
 * still holds the delta, so a later flush can still get it into the rollup. The
 * drain subtracts exactly what was written rather than assigning zero, so usage
 * appended while the await was in flight survives.
 *
 * The write is best-effort. Three of the five early exits (abort, watcher
 * terminate, unrecoverable overflow) flush and then yield the error event they
 * exist to emit, and a storage failure must not replace that event with a
 * thrown generator. Nothing is lost either way: the `messages`
 * rows are authoritative (analytics decision 9) and already persisted, so the
 * rollup — a derived display cache — stays rebuildable. Not silent: the failure
 * is recorded, same shape as `compaction_persist_failed` in
 * `agent-loop/compaction.ts`.
 */
export async function flushTurnUsage(
  session: SessionStore,
  sessionId: string,
  usage: TurnUsageAccumulator,
  observability?: AgentLoopObservability,
): Promise<void> {
  const delta = { ...usage };
  if (
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.cacheReadTokens === 0 &&
    delta.cacheCreationTokens === 0 &&
    delta.estimatedCostUsd === 0
  ) {
    return;
  }
  try {
    await session.updateUsage(sessionId, delta);
  } catch (err) {
    observability?.recordError?.({
      severity: 'warn',
      code: 'usage_rollup_flush_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  usage.inputTokens -= delta.inputTokens;
  usage.outputTokens -= delta.outputTokens;
  usage.cacheReadTokens -= delta.cacheReadTokens;
  usage.cacheCreationTokens -= delta.cacheCreationTokens;
  usage.estimatedCostUsd -= delta.estimatedCostUsd;
}

export interface TurnFinalizerContext {
  sessionId: string;
  traceId: string | undefined;
  personalityId: string;
  allowedPlugins: string[];
  fullText: string;
  turnCount: number;
  successfulToolCalls: number;
  totalToolCalls: number;
  toolNames: string[];
  initialPrompt: string;
  activeSkillFiles: string[] | undefined;
  dryRunPlan: DryRunToolPlan[];
  dryRunCapped: number;
  isDryRun: boolean;
  turnUsage: TurnUsageAccumulator;
  /** Ground-truth verification (R5). Absent or empty → the seam is skipped
   *  entirely and the turn ends exactly as it did before. */
  turnAuditors?: readonly TurnAuditor[];
}

export async function* finalizeTurn(
  session: SessionStore,
  hooks: HookRegistry,
  observability: AgentLoopObservability | undefined,
  ctx: TurnFinalizerContext,
): AsyncGenerator<AgentEvent> {
  // Step 11: Update usage — API-call count plus this turn's token/cost rollup.
  await session.updateUsage(ctx.sessionId, { apiCallCount: ctx.turnCount });
  await flushTurnUsage(session, ctx.sessionId, ctx.turnUsage, observability);

  // Step 12: Fire agent_done hook
  await hooks.fireVoid(
    'agent_done',
    {
      sessionId: ctx.sessionId,
      text: ctx.fullText,
      turnCount: ctx.turnCount,
      personalityId: ctx.personalityId,
      successfulToolCalls: ctx.successfulToolCalls,
      totalToolCalls: ctx.totalToolCalls,
      toolNames: ctx.toolNames,
      initialPrompt: ctx.initialPrompt,
      activeSkillFiles: ctx.activeSkillFiles,
    },
    ctx.allowedPlugins,
  );

  // Ground-truth verification (R5) — audit the finished turn's claims against
  // what its tools did. Awaited BEFORE `endTrace`/`flush` so the findings land
  // inside this turn's trace and go out with its flush, and so the seam adds no
  // suspension point ahead of them: a consumer that stops reading mid-turn must
  // not be able to skip closing the trace.
  //
  // Return-direct turns are not audited, and need no exemption to say so: that
  // path returns from `run()` at the tool-processing `done` (agent-loop.ts) and
  // never reaches this function at all — it skips `agent_done` for the same
  // reason.
  const findings =
    ctx.turnAuditors && ctx.turnAuditors.length > 0
      ? await runTurnAuditors(
          ctx.turnAuditors,
          { sessionId: ctx.sessionId, text: ctx.fullText, toolNames: ctx.toolNames },
          ctx.traceId,
          observability,
        )
      : [];

  if (ctx.traceId) observability?.endTrace(ctx.traceId, 'ok');
  observability?.flush();

  // R5 — findings must precede `done`. `done` is what closes the turn, so a
  // `_grounding` line yielded after it reaches no surface. `audience: 'user'`
  // is the deliberate opt-in (Phase 30.2): this is the one thing the framework
  // has to say about the reply the user is reading.
  for (const finding of findings) {
    if (finding.severity !== 'warn') continue;
    yield {
      type: 'tool_progress',
      toolName: GROUNDING_TOOL_NAME,
      message: finding.message,
      audience: 'user',
    };
  }

  // B3 — `traceId` closes the turn under the same identity `run_start` opened
  // it with, so a consumer that joined the stream late still gets it.
  yield {
    type: 'done',
    text: ctx.fullText,
    turnCount: ctx.turnCount,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
  };

  // dry_run_summary comes AFTER done — ordering preserved
  if (ctx.isDryRun && ctx.dryRunPlan.length > 0) {
    yield {
      type: 'dry_run_summary' as const,
      plan: ctx.dryRunPlan,
      capped: ctx.dryRunCapped,
    };
  }
}
