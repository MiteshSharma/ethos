import type Anthropic from '@anthropic-ai/sdk';
import { estimateCost } from '@ethosagent/pricing';
import type { CompletionChunk } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnthropicStreamParams {
  model: string;
  messages: Anthropic.MessageParam[];
  system?: Anthropic.TextBlockParam[];
  max_tokens: number;
  tools?: Anthropic.Tool[];
  thinking?: { type: 'enabled'; budget_tokens: number };
  betas?: string[];
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  requestTokens?: { system: number; tools: number; messages: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toFinishReason(
  reason: string | null | undefined,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

// ---------------------------------------------------------------------------
// Streaming transport
// ---------------------------------------------------------------------------

export async function* streamAnthropicMessages(
  client: Anthropic,
  params: AnthropicStreamParams,
  abortSignal?: AbortSignal,
): AsyncGenerator<CompletionChunk> {
  const { requestTokens, ...rest } = params;

  // biome-ignore lint/suspicious/noExplicitAny: extended thinking params not yet in SDK types
  const streamParams: any = { ...rest };
  // Remove undefined optional fields so the SDK doesn't send them
  if (!streamParams.system) delete streamParams.system;
  if (!streamParams.tools || streamParams.tools.length === 0) delete streamParams.tools;
  if (!streamParams.thinking) delete streamParams.thinking;
  if (!streamParams.betas) delete streamParams.betas;
  if (!streamParams.stop_sequences) delete streamParams.stop_sequences;
  if (streamParams.temperature === undefined) delete streamParams.temperature;
  if (streamParams.top_p === undefined) delete streamParams.top_p;

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let currentToolId: string | null = null;
  let currentBlockType: string | null = null;

  const stream = client.messages.stream(streamParams, { signal: abortSignal });

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          // Cast to access optional cache token fields (added with prompt caching beta)
          const u = event.message.usage as Anthropic.Usage & {
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          inputTokens = u.input_tokens;
          cacheReadTokens = u.cache_read_input_tokens ?? 0;
          cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
          break;
        }

        case 'content_block_start': {
          const { content_block } = event;
          currentBlockType = content_block.type;
          if (content_block.type === 'tool_use') {
            currentToolId = content_block.id;
            yield {
              type: 'tool_use_start',
              toolCallId: content_block.id,
              toolName: content_block.name,
            };
          }
          break;
        }

        case 'content_block_delta': {
          const { delta } = event;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta' && currentToolId) {
            yield {
              type: 'tool_use_delta',
              toolCallId: currentToolId,
              partialJson: delta.partial_json,
            };
          } else if ((delta as { type: string; thinking?: string }).type === 'thinking_delta') {
            const thinking = (delta as { type: string; thinking: string }).thinking;
            yield { type: 'thinking_delta', thinking };
          }
          break;
        }

        case 'content_block_stop':
          if (currentBlockType === 'tool_use' && currentToolId) {
            yield { type: 'tool_use_end', toolCallId: currentToolId, inputJson: '' };
            currentToolId = null;
          }
          currentBlockType = null;
          break;

        case 'message_delta': {
          const outputTokens = event.usage?.output_tokens ?? 0;
          // B2 — the server-assigned request id. On a STREAMING call the SDK
          // does not expose `_request_id` on anything we hold: that property is
          // attached to decoded JSON response bodies (the non-streaming
          // `messages.create` path). The streaming equivalent is
          // `MessageStream.request_id`, a typed public getter over the
          // `request-id` response header — no cast needed, unlike the cache
          // token fields read in `message_start`. It is populated when the
          // response connects, so it is set by the time this chunk is built.
          const providerRequestId = stream.request_id ?? undefined;
          const costEstimate = estimateCost(params.model, {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
          });
          yield {
            type: 'usage',
            usage: {
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
              estimatedCostUsd: costEstimate.costUsd,
              requestTokens,
            },
            metadata: {},
            costBasis: costEstimate.basis,
            ...(providerRequestId ? { providerRequestId } : {}),
          };
          if (event.delta.stop_reason) {
            yield { type: 'done', finishReason: toFinishReason(event.delta.stop_reason) };
          }
          break;
        }
      }
    }
  } finally {
    stream.abort();
  }
}
