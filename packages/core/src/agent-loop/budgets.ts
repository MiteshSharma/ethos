/** Running streak of consecutive tool calls with identical name + args. */
export interface IdenticalStreak {
  /** Identity key — `${toolName}:${JSON.stringify(args)}`. */
  key: string;
  toolName: string;
  count: number;
}

/**
 * Fold one completed tool call into the consecutive-identical-call streak.
 * Same key as the previous call extends the streak; any different call
 * (different name OR different args) resets it to 1.
 */
export function updateIdenticalStreak(
  prev: IdenticalStreak | null,
  toolName: string,
  args: unknown,
): IdenticalStreak {
  let key: string;
  try {
    key = `${toolName}:${JSON.stringify(args)}`;
  } catch {
    // Non-serializable args (shouldn't happen for JSON tool args) — fall back
    // to the tool name so the guard still functions, just more coarsely.
    key = toolName;
  }
  if (prev && prev.key === key) {
    return { key, toolName, count: prev.count + 1 };
  }
  return { key, toolName, count: 1 };
}

/** Which budget guard tripped. Carried on the exceeded result (and the `halt`
 *  AgentEvent) so consumers never parse the human-readable message. */
export type BudgetRule =
  | 'tool-budget'
  | 'identical-name'
  | 'identical-streak'
  | 'cost-cap'
  | 'denial_circuit_breaker';

/**
 * Consecutive approval denials that stop the turn. Hard-coded on purpose — an
 * agent that has had three tool calls denied in a row is not going to guess its
 * way to an approved one, and a config knob for it is speculation until someone
 * asks for a different number.
 */
export const MAX_CONSECUTIVE_DENIALS = 3;

/**
 * Fold one tool batch into the consecutive-approval-denial streak.
 *
 * Only `before_tool_call` hook denials count — the approval flow's rejections.
 * MCP-policy blocks, MCP `reject_args`, injection downgrades, and watcher halts
 * all collapse into the same `rejected` field inside the tool-processing stage,
 * so the stage tags the approval case separately and reports only that count.
 *
 * Any tool that actually executed breaks the streak: the batch's own denials
 * are still the most recent run, so the streak restarts at that count rather
 * than resetting to zero.
 */
export function updateDenialStreak(
  prev: number,
  batch: { hookDenials: number; successCount: number },
): number {
  if (batch.hookDenials === 0) return 0;
  return batch.successCount > 0 ? batch.hookDenials : prev + batch.hookDenials;
}

/**
 * Accumulated session spend, checked against the personality's `budgetCapUsd`.
 *
 * `turn-setup` refuses a turn whose spend already exceeded the cap, but that
 * runs once, before the iteration loop opens — it only ever sees spend from
 * *previous* turns. Spend accrues inside the loop: `stream-step` adds LLM
 * usage and `tool-processing` adds tool-reported `cost_usd`, both writing to
 * the same `sessionCosts` map. So `spentUsd` must be read live on every
 * iteration, never snapshotted at turn start, or one long turn can burn all
 * `maxIterations` past the cap.
 *
 * `capUsd` undefined = no cap configured; the check is skipped entirely.
 */
export interface CostBudget {
  spentUsd: number;
  capUsd?: number;
}

export function checkTurnBudgets(
  totalToolCalls: number,
  maxToolCallsPerTurn: number,
  toolNameCounts: Map<string, number>,
  maxIdenticalToolCalls: number,
  identicalStreak: IdenticalStreak | null,
  maxConsecutiveIdenticalCalls: number,
  cost?: CostBudget,
  consecutiveDenials = 0,
):
  | { exceeded: false }
  | { exceeded: true; rule: BudgetRule; toolName: string; count?: number; message: string } {
  if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
    return {
      exceeded: true,
      rule: 'denial_circuit_breaker',
      toolName: '_approval',
      count: consecutiveDenials,
      message: `Stopped: ${consecutiveDenials} tool calls denied in a row — retrying will not help`,
    };
  }
  // Cost first: money spent is a harder constraint than loop pathology, and
  // `turn-setup`'s pre-turn refusal only ever sees spend from previous turns.
  if (cost?.capUsd != null && cost.spentUsd >= cost.capUsd) {
    return {
      exceeded: true,
      rule: 'cost-cap',
      toolName: '_budget',
      message:
        `Stopped: hit $${cost.capUsd.toFixed(2)} budget cap for this session ` +
        `($${cost.spentUsd.toFixed(4)} spent)`,
    };
  }
  if (totalToolCalls >= maxToolCallsPerTurn) {
    return {
      exceeded: true,
      rule: 'tool-budget',
      toolName: '_budget',
      count: totalToolCalls,
      message: `Stopped: hit ${maxToolCallsPerTurn}-tool-call budget for this turn`,
    };
  }
  const overused = [...toolNameCounts.entries()].find(
    ([, count]) => count >= maxIdenticalToolCalls,
  );
  if (overused) {
    return {
      exceeded: true,
      rule: 'identical-name',
      toolName: overused[0],
      count: overused[1],
      message: `Stopped: ${overused[0]} called ${overused[1]} times in one turn (likely loop)`,
    };
  }
  if (identicalStreak && identicalStreak.count >= maxConsecutiveIdenticalCalls) {
    return {
      exceeded: true,
      rule: 'identical-streak',
      toolName: identicalStreak.toolName,
      count: identicalStreak.count,
      message: `Stopped: ${identicalStreak.toolName} called ${identicalStreak.count} times in a row with identical arguments (loop)`,
    };
  }
  return { exceeded: false };
}
