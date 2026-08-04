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
export type BudgetRule = 'tool-budget' | 'identical-name' | 'identical-streak' | 'cost-cap';

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
):
  | { exceeded: false }
  | { exceeded: true; rule: BudgetRule; toolName: string; count?: number; message: string } {
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
