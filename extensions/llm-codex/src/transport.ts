import { estimateCost } from '@ethosagent/pricing';
import type { CompletionChunk, TokenUsage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>. Yields one event
 * per `event:` + `data:` pair, delimited by blank lines.
 */
async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete events (delimited by double newline).
      const parts = buffer.split('\n\n');
      // The last element is an incomplete chunk — keep it in the buffer.
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;

        let event = '';
        let data = '';

        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data = line.slice(5).trim();
          }
        }

        if (event && data) {
          yield { event, data };
        }
      }
    }

    // Flush remaining buffer — the stream may close without a trailing blank line.
    if (buffer.trim()) {
      let event = '';
      let data = '';

      for (const line of buffer.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim();
        }
      }

      if (event && data) {
        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// ResponsesApiBody
// ---------------------------------------------------------------------------

export interface ResponsesApiBody {
  model: string;
  input: unknown[];
  stream: true;
  // `store`, `reasoning` and `include` are Codex's choices, not the API's
  // requirements. They are optional so a second consumer of this transport can
  // omit what it does not want rather than send an empty placeholder.
  store?: boolean;
  reasoning?: { effort: string; summary: string };
  include?: string[];
  instructions?: string;
  tools?: unknown[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
}

// ---------------------------------------------------------------------------
// streamResponsesApi
// ---------------------------------------------------------------------------

/**
 * Stream the OpenAI Responses API endpoint, yielding `CompletionChunk`s.
 *
 * This is the raw transport: it issues the fetch, parses SSE events, and maps
 * each event to the Ethos `CompletionChunk` discriminated union. The caller is
 * responsible for building the `ResponsesApiBody`.
 */
export async function* streamResponsesApi(
  endpoint: string,
  token: string,
  body: ResponsesApiBody,
  signal?: AbortSignal,
  requestTokens?: { system: number; tools: number; messages: number },
  providerLabel?: string,
): AsyncIterable<CompletionChunk> {
  // This transport is shared by every provider that speaks the Responses API
  // (ARCHITECTURE.md:264-265), so the failure message must name the caller's
  // vendor — an xAI 401 reported as a Codex error sends the operator to the
  // wrong console. Callers pass their own label; with none, stay neutral.
  const apiLabel = providerLabel ? `${providerLabel} Responses API` : 'Responses API';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${apiLabel} error ${response.status}: ${text || response.statusText}`);
  }

  if (!response.body) {
    throw new Error(`${apiLabel} returned no body`);
  }

  // Track tool calls in flight for mapping deltas to tool IDs.
  let currentToolId = '';
  let hasToolCalls = false;

  for await (const sse of parseSSE(response.body)) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sse.data) as Record<string, unknown>;
    } catch {
      continue; // Skip malformed JSON
    }

    switch (sse.event) {
      case 'response.output_text.delta': {
        const delta = (payload as { delta?: string }).delta;
        if (delta) {
          yield { type: 'text_delta', text: delta };
        }
        break;
      }

      case 'response.output_item.added': {
        const item = payload.item as
          | { type?: string; id?: string; call_id?: string; name?: string }
          | undefined;
        const toolId = item?.call_id ?? item?.id;
        if (item?.type === 'function_call' && toolId && item.name) {
          currentToolId = toolId;
          hasToolCalls = true;
          yield { type: 'tool_use_start', toolCallId: toolId, toolName: item.name };
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const delta = (payload as { delta?: string }).delta;
        if (delta && currentToolId) {
          yield { type: 'tool_use_delta', toolCallId: currentToolId, partialJson: delta };
        }
        break;
      }

      case 'response.output_item.done': {
        const item = payload.item as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              arguments?: string;
            }
          | undefined;
        const toolId = item?.call_id ?? item?.id;
        if (item?.type === 'function_call' && toolId) {
          yield {
            type: 'tool_use_end',
            toolCallId: toolId,
            inputJson: item.arguments ?? '',
          };
          // Reset for the next tool call in the same response.
          currentToolId = '';
        }
        break;
      }

      case 'response.completed': {
        const resp = payload.response as
          | {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cached_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
              };
            }
          | undefined;
        const inputTokens = resp?.usage?.input_tokens ?? 0;
        const outputTokens = resp?.usage?.output_tokens ?? 0;
        // Prompt-cache hits. The Responses API nests them under
        // `input_tokens_details`; some vendors flatten them onto `usage`, so read
        // both and fall back to 0 when neither is reported. This reads 0 for xAI
        // until a stable per-session cache key reaches `CompletionOptions`
        // (deferred in plan/uncompleted-tasks.md) — expected, not a bug.
        const cacheReadTokens =
          resp?.usage?.input_tokens_details?.cached_tokens ?? resp?.usage?.cached_tokens ?? 0;

        // Codex model ids that the shared table knows price normally; the
        // rest resolve to 0 AND report `pricing.unknown_model`, so a
        // subscription-served model shows up as an acknowledged blind spot
        // rather than as a silent, unmarked zero.
        const costEstimate = estimateCost(body.model, { inputTokens, outputTokens });
        const usage: TokenUsage = {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens: 0,
          estimatedCostUsd: costEstimate.costUsd,
          requestTokens,
        };
        yield { type: 'usage', usage, metadata: {}, costBasis: costEstimate.basis };

        yield {
          type: 'done',
          finishReason: hasToolCalls ? 'tool_use' : 'end_turn',
        };
        break;
      }

      // Ignore other event types (response.created, response.in_progress, etc.)
    }
  }
}
