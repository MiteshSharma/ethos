import type { AgentEvent, CompletionChunk } from '@ethosagent/types';
import { repairJson } from './json-repair';

export function* handleChunk(
  chunk: CompletionChunk,
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    partialJson: string;
    args?: unknown;
    // Set when the streamed arguments could not be parsed AND could not be
    // repaired. Carries a short reason; the tool must NOT execute (see
    // tool-processing.ts, which routes this through Prepped.rejected → an
    // is_error tool_result). Never silently coerced to `{}`.
    parseError?: string;
    // Outcome of a repair attempt — set only when strict parse failed and a
    // repair pass ran. Consumed by stream-step for an observability event.
    repair?: { outcome: 'repaired' | 'failed' };
  }>,
  onText: (t: string) => void,
): Generator<AgentEvent> {
  switch (chunk.type) {
    case 'text_delta':
      onText(chunk.text);
      yield { type: 'text_delta', text: chunk.text };
      break;

    case 'thinking_delta':
      yield { type: 'thinking_delta', thinking: chunk.thinking };
      break;

    case 'tool_use_start':
      pendingToolCalls.push({
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        partialJson: '',
      });
      break;

    case 'tool_use_delta': {
      const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
      if (tc) tc.partialJson += chunk.partialJson;
      break;
    }

    case 'tool_use_end': {
      const tc = pendingToolCalls.find((t) => t.toolCallId === chunk.toolCallId);
      if (tc) {
        const raw = chunk.inputJson || tc.partialJson;
        if (raw.trim() === '') {
          // Zero-argument tool call — an empty argument stream is legitimate,
          // not malformed. Parse as empty object.
          tc.args = {};
        } else {
          try {
            tc.args = JSON.parse(raw);
          } catch {
            // Never coerce malformed args to `{}` and run the tool blind.
            // Attempt one mechanical repair pass; on failure, flag a parse
            // error so tool-processing rejects the call with a visible
            // is_error result the model can retry against.
            const repaired = repairJson(raw);
            if (repaired.ok) {
              tc.args = repaired.value;
              tc.repair = { outcome: 'repaired' };
            } else {
              tc.repair = { outcome: 'failed' };
              tc.parseError = `malformed tool arguments: ${raw.slice(0, 120)}`;
            }
          }
        }
      }
      break;
    }

    case 'usage':
      // A6 — cache tokens used to be dropped here, so no AgentEvent consumer
      // could see cache activity at all. Carried through only when non-zero:
      // the provider reports 0 for a cacheless call, and an always-present 0
      // reads as "cached nothing" rather than "caching not in play".
      yield {
        type: 'usage',
        inputTokens: chunk.usage.inputTokens,
        outputTokens: chunk.usage.outputTokens,
        estimatedCostUsd: chunk.usage.estimatedCostUsd,
        ...(chunk.usage.cacheReadTokens ? { cacheReadTokens: chunk.usage.cacheReadTokens } : {}),
        ...(chunk.usage.cacheCreationTokens
          ? { cacheCreationTokens: chunk.usage.cacheCreationTokens }
          : {}),
      };
      break;

    case 'done':
      // finishReason available here for future context-compaction (Phase 3)
      break;
  }
}
