// B2 — inbound provider correlation. Anthropic assigns every request a server
// side id and returns it on the `request-id` response header; it is the value a
// provider support ticket asks for.
//
// On a STREAMING call the SDK does not hand us `_request_id` (that non-
// enumerable property is attached to decoded JSON response bodies, i.e. the
// non-streaming `messages.create` path). The streaming equivalent is
// `MessageStream.request_id`, a typed public getter over the same header — so
// this needs no `any` cast, unlike the `cache_read_input_tokens` fields the
// transport reads in `message_start`.
//
// The transport is driven against a mock stream: no network call.

import type Anthropic from '@anthropic-ai/sdk';
import type { CompletionChunk } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { streamAnthropicMessages } from '../transport';

const EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 100 } } },
  { type: 'content_block_start', content_block: { type: 'text' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop' },
  { type: 'message_delta', usage: { output_tokens: 20 }, delta: { stop_reason: 'end_turn' } },
];

/** A stand-in for the SDK's `MessageStream`: async-iterable, abortable, and
 *  carrying the `request_id` the real one derives from the response header. */
function fakeClient(requestId: string | null): Anthropic {
  return {
    messages: {
      stream: () => ({
        request_id: requestId,
        abort() {},
        async *[Symbol.asyncIterator]() {
          for (const e of EVENTS) yield e;
        },
      }),
    },
  } as unknown as Anthropic;
}

async function collect(requestId: string | null): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const c of streamAnthropicMessages(fakeClient(requestId), {
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    chunks.push(c);
  }
  return chunks;
}

function usageChunk(chunks: CompletionChunk[]): Extract<CompletionChunk, { type: 'usage' }> {
  const chunk = chunks.find((c) => c.type === 'usage');
  if (chunk?.type !== 'usage') throw new Error('no usage chunk');
  return chunk;
}

describe('anthropic inbound request correlation (B2)', () => {
  it("captures the SDK's server-assigned request id onto the usage chunk", async () => {
    const chunks = await collect('req_011CQoiTPabcdef123456');
    // Pre-fix: the field was never populated on any chunk.
    expect(usageChunk(chunks).providerRequestId).toBe('req_011CQoiTPabcdef123456');
  });

  it('leaves the field absent when the response carried no request id', async () => {
    const chunks = await collect(null);
    expect(usageChunk(chunks).providerRequestId).toBeUndefined();
  });

  it('still reports usage and finish reason unchanged', async () => {
    const chunks = await collect('req_011CQoiTPabcdef123456');
    expect(usageChunk(chunks).usage.inputTokens).toBe(100);
    expect(usageChunk(chunks).usage.outputTokens).toBe(20);
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'end_turn' });
  });
});
