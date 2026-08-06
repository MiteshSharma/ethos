// Lane 2a — deterministic tool ordering at the Anthropic serialization
// boundary, asserted on the EXACT wire bytes captured through the SDK's fetch
// seam. The tools array ships ahead of the messages and is part of the
// cacheable prefix. The ordering is a caching device, not a priority signal.

import type { CompletionChunk, ToolDefinitionLite } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, type AnthropicProviderConfig } from '../index';

function tool(name: string): ToolDefinitionLite {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
  };
}

const SSE_TEXT_RESPONSE = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-5',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })}`,
  '',
  'event: content_block_start',
  `data: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })}`,
  '',
  'event: content_block_delta',
  `data: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'ok' },
  })}`,
  '',
  'event: content_block_stop',
  `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n');

/** Fetch stub: answers count_tokens with a fixed count and /v1/messages with
 *  a minimal SSE text stream, recording each messages-request body. */
function makeFetchStub(bodies: string[]): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('count_tokens')) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    bodies.push(String(init?.body ?? ''));
    return new Response(SSE_TEXT_RESPONSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

async function captureBody(
  tools: ToolDefinitionLite[],
  config?: Partial<AnthropicProviderConfig>,
): Promise<string> {
  const bodies: string[] = [];
  const provider = new AnthropicProvider({
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    fetchImpl: makeFetchStub(bodies),
    ...config,
  });
  const chunks: CompletionChunk[] = [];
  for await (const chunk of provider.complete([{ role: 'user', content: 'hello' }], tools, {
    system: 'You are a test.',
  })) {
    chunks.push(chunk);
  }
  expect(chunks.some((c) => c.type === 'done')).toBe(true);
  expect(bodies).toHaveLength(1);
  return bodies[0] ?? '';
}

function toolNames(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: Array<{ name: string }> };
  return (parsed.tools ?? []).map((t) => t.name);
}

describe('Lane 2a — Anthropic tool ordering (wire bytes)', () => {
  it('produces byte-identical request bodies for the same tool set in two registration orders', async () => {
    const a = await captureBody([tool('write_file'), tool('bash'), tool('read_file')]);
    const b = await captureBody([tool('read_file'), tool('write_file'), tool('bash')]);
    expect(a).toBe(b);
  });

  it('defaults to ASCII-stable order', async () => {
    const body = await captureBody([tool('zeta'), tool('beta'), tool('Alpha')]);
    expect(toolNames(body)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it("toolOrder: 'insertion' restores legacy registration-order bytes", async () => {
    const body = await captureBody([tool('zeta'), tool('beta'), tool('Alpha')], {
      toolOrder: 'insertion',
    });
    expect(toolNames(body)).toEqual(['zeta', 'beta', 'Alpha']);
  });
});
