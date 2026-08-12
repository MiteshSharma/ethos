import type { AgentEvent, DryRunToolPlan, HookRegistry, SessionStore } from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';

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

  if (ctx.traceId) observability?.endTrace(ctx.traceId, 'ok');
  observability?.flush();

  yield { type: 'done', text: ctx.fullText, turnCount: ctx.turnCount };

  // dry_run_summary comes AFTER done — ordering preserved
  if (ctx.isDryRun && ctx.dryRunPlan.length > 0) {
    yield {
      type: 'dry_run_summary' as const,
      plan: ctx.dryRunPlan,
      capped: ctx.dryRunCapped,
    };
  }
}
