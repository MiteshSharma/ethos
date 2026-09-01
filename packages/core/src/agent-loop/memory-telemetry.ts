import type { ToolResult } from '@ethosagent/types';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';

/**
 * P2-counters — `ethos_memory_writes_total`, in one place.
 *
 * Deliberately NOT derived from the `tool_call` span's `attrs.args` (unlike
 * `ethos_tool_calls_total`): that JSON is truncated to 4096 chars when the
 * span opens (tool-processing.ts), and a large `memory_write` content payload
 * can blow past that and corrupt the parse. This reads the full, untruncated
 * args object already in scope at the call site instead, and only after the
 * tool has actually executed successfully — a rejected or `input_invalid`
 * call must not count as a write.
 */

/** Record a successful `memory_write` / `team_memory_write` call. No-op for
 *  any other tool, and no-op unless `result.ok` — a rejected or invalid call
 *  never reaches memory.sync() and must not increment the counter. */
export function recordMemoryWriteIfApplicable(
  observability: AgentLoopObservability | undefined,
  toolName: string,
  args: unknown,
  result: ToolResult,
  traceId: string | undefined,
): void {
  if (!observability?.recordMemoryWrite || !result.ok) return;
  if (toolName !== 'memory_write' && toolName !== 'team_memory_write') return;

  const a = args as { store?: unknown; action?: unknown } | undefined;
  const action = typeof a?.action === 'string' ? a.action : 'unknown';
  const store = toolName === 'team_memory_write' ? 'team' : String(a?.store ?? 'unknown');

  observability.recordMemoryWrite({
    ...(traceId ? { traceId } : {}),
    store,
    action,
  });
}
