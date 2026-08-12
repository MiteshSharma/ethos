import type { HookRegistry, VoiceTurnOrigin } from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { type IdenticalStreak, updateIdenticalStreak } from '../budgets';
import type { HaltDecision, WatcherTap } from '../turn-context';

// ---------------------------------------------------------------------------
// Per-call enforcement — the segment of the tool pipeline that must run for
// EVERY tool call regardless of who issued it (the LLM via the tool-processing
// stage today; a script via the ScriptToolBridge later). Extracted so both
// callers share one `before_tool_call` fire site, one watcher-halt consult,
// and one set of turn budget counters.
// ---------------------------------------------------------------------------

export interface BeforeToolCallDeps {
  hooks: HookRegistry;
  observability?: AgentLoopObservability;
}

export interface BeforeToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  allowedPlugins: string[];
  traceId: string | undefined;
  /** Set when the turn arrived as speech — forwarded verbatim onto the hook
   *  payload so the danger predicate can apply the spoken-confirmation gate. */
  voiceOrigin?: VoiceTurnOrigin;
}

export type BeforeToolCallDecision =
  | { allowed: true; effectiveArgs: unknown }
  | { allowed: false; reason: string };

/**
 * Fire the `before_tool_call` modifying hook for one tool call. A hook error
 * blocks the call (the caller decides how to surface the rejection); a hook
 * `args` override becomes the effective args for execution.
 */
export async function enforceBeforeToolCall(
  deps: BeforeToolCallDeps,
  input: BeforeToolCallInput,
): Promise<BeforeToolCallDecision> {
  const beforeResult = await deps.hooks.fireModifying(
    'before_tool_call',
    {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      ...(input.voiceOrigin ? { voiceOrigin: input.voiceOrigin } : {}),
    },
    input.allowedPlugins,
  );

  if (beforeResult.error) {
    deps.observability?.recordSafetyBlock({
      traceId: input.traceId,
      code: 'tool_blocked',
      cause: beforeResult.error,
    });
    return { allowed: false, reason: beforeResult.error };
  }

  return { allowed: true, effectiveArgs: beforeResult.args ?? input.args };
}

/**
 * Consult the watcher tap for a non-allow decision. Returns the halt (so a
 * caller that must abort — e.g. a script execution — can inspect the action)
 * plus the standard rejection reason for calls that will not execute.
 */
export function consultWatcherHalt(
  getHalt: WatcherTap['getHalt'],
): { halted: false } | { halted: true; halt: HaltDecision; rejectionReason: string } {
  const halt = getHalt();
  if (!halt) return { halted: false };
  return {
    halted: true,
    halt,
    rejectionReason: `Watcher halted before execution: ${halt.reason}`,
  };
}

/**
 * Turn-scoped budget counters read by `checkTurnBudgets`. Held as one mutable
 * object so every caller that records a tool call increments the SAME
 * counters — the turn budget arithmetic does not distinguish who asked.
 */
export interface TurnBudgetCounters {
  totalToolCalls: number;
  toolNameCounts: Map<string, number>;
  identicalStreak: IdenticalStreak | null;
}

/** Fresh counters for one user turn. */
export function createTurnBudgetCounters(): TurnBudgetCounters {
  return { totalToolCalls: 0, toolNameCounts: new Map(), identicalStreak: null };
}

/** Fold one tool call into the turn's budget counters. */
export function recordToolCallForBudgets(
  counters: TurnBudgetCounters,
  toolName: string,
  args: unknown,
): void {
  counters.totalToolCalls++;
  counters.toolNameCounts.set(toolName, (counters.toolNameCounts.get(toolName) ?? 0) + 1);
  counters.identicalStreak = updateIdenticalStreak(counters.identicalStreak, toolName, args);
}
