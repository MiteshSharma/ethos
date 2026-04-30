// Per-turn timing data collected during an agent turn.
export interface TurnTiming {
  turnStart: number;
  turnEnd: number;
  firstTextDeltaAt: number | null;
  toolDurations: number[];
  turnUsage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null;
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function formatVerboseSummary(t: TurnTiming): string {
  const total = t.turnEnd - t.turnStart;
  const toolsTotal = t.toolDurations.reduce((a, b) => a + b, 0);
  const llm = Math.max(0, total - toolsTotal);
  const ttft = t.firstTextDeltaAt !== null ? t.firstTextDeltaAt - t.turnStart : null;

  const parts: string[] = [];
  parts.push(`llm ${fmtSecs(llm)}${ttft !== null ? ` (TTFT ${fmtSecs(ttft)})` : ''}`);
  if (t.toolDurations.length > 0) {
    const n = t.toolDurations.length;
    parts.push(`tools ${fmtSecs(toolsTotal)} (${n} call${n === 1 ? '' : 's'})`);
  }
  parts.push(`total ${fmtSecs(total)}`);

  if (t.turnUsage) {
    parts.push(`${fmtTokens(t.turnUsage.inputTokens)} in`);
    parts.push(`${fmtTokens(t.turnUsage.outputTokens)} out`);
    if (t.turnUsage.estimatedCostUsd > 0) {
      parts.push(`$${t.turnUsage.estimatedCostUsd.toFixed(3)}`);
    }
  }

  return `↳ ${parts.join(' · ')}`;
}
