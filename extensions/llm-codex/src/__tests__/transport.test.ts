import type { CompletionChunk } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../index';
import { type ResponsesApiBody, streamResponsesApi } from '../transport';

/**
 * Build a ReadableStream that emits SSE-formatted events.
 * Each entry is [eventType, dataObject].
 */
function makeSSEStream(events: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`)
    .join('\n');

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

function makeMockFetch(events: Array<[string, unknown]>): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    body: makeSSEStream(events),
    text: () => Promise.resolve(''),
    status: 200,
    statusText: 'OK',
  });
}

function makeFailingFetch(status: number, text: string, statusText = 'Unauthorized'): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    body: null,
    text: () => Promise.resolve(text),
    status,
    statusText,
  });
}

async function withFetch<T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function drain(iterable: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const c of iterable) chunks.push(c);
  return chunks;
}

const MINIMAL_BODY: ResponsesApiBody = {
  model: 'grok-4.6',
  input: [],
  stream: true,
};

describe('ResponsesApiBody optionality', () => {
  it('accepts a body that omits store, reasoning and include', async () => {
    const mockFetch = makeMockFetch([
      ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
    ]);

    await withFetch(mockFetch, async () => {
      await drain(streamResponsesApi('https://api.x.ai/v1/responses', 'tok', MINIMAL_BODY));
    });

    const init = vi.mocked(mockFetch).mock.calls[0]?.[1];
    const sent = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    expect(sent.model).toBe('grok-4.6');
    expect('store' in sent).toBe(false);
    expect('reasoning' in sent).toBe(false);
    expect('include' in sent).toBe(false);
  });

  it('still sends Codex its three fields unchanged', async () => {
    const mockFetch = makeMockFetch([
      ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
    ]);

    await withFetch(mockFetch, async () => {
      const provider = new CodexProvider({
        model: 'gpt-5.4-mini',
        getAccessToken: async () => 'mock-token',
      });
      await drain(provider.complete([], [], {}));
    });

    // The first turn's model-roster discovery is call 0; the request is last.
    const init = vi.mocked(mockFetch).mock.calls.at(-1)?.[1];
    const sent = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    expect(sent.store).toBe(false);
    expect(sent.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(sent.include).toEqual(['reasoning.encrypted_content']);
  });
});

describe('streamResponsesApi error labelling', () => {
  it('names the caller-supplied vendor on a failed request', async () => {
    const mockFetch = makeFailingFetch(401, 'bad key');

    await withFetch(mockFetch, async () => {
      await expect(
        drain(
          streamResponsesApi(
            'https://api.x.ai/v1/responses',
            'tok',
            MINIMAL_BODY,
            undefined,
            undefined,
            'xAI',
          ),
        ),
      ).rejects.toThrow('xAI Responses API error 401: bad key');
    });
  });

  it('stays vendor-neutral when no label is supplied', async () => {
    const mockFetch = makeFailingFetch(500, '', 'Internal Server Error');

    await withFetch(mockFetch, async () => {
      await expect(
        drain(streamResponsesApi('https://api.x.ai/v1/responses', 'tok', MINIMAL_BODY)),
      ).rejects.toThrow('Responses API error 500: Internal Server Error');
    });
  });

  it('keeps the Codex provider error message unchanged', async () => {
    const mockFetch = makeFailingFetch(401, 'token expired');

    await withFetch(mockFetch, async () => {
      const provider = new CodexProvider({
        model: 'gpt-5.4-mini',
        getAccessToken: async () => 'mock-token',
      });
      await expect(drain(provider.complete([], [], {}))).rejects.toThrow(
        'Codex Responses API error 401: token expired',
      );
    });
  });

  it('labels a missing response body with the same vendor', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
      text: () => Promise.resolve(''),
      status: 200,
      statusText: 'OK',
    }) as unknown as typeof fetch;

    await withFetch(mockFetch, async () => {
      await expect(
        drain(
          streamResponsesApi(
            'https://api.x.ai/v1/responses',
            'tok',
            MINIMAL_BODY,
            undefined,
            undefined,
            'xAI',
          ),
        ),
      ).rejects.toThrow('xAI Responses API returned no body');
    });
  });
});

describe('streamResponsesApi cached-token usage', () => {
  async function usageFor(usage: unknown): Promise<Extract<CompletionChunk, { type: 'usage' }>> {
    const mockFetch = makeMockFetch([['response.completed', { response: { usage } }]]);
    const chunks = await withFetch(mockFetch, () =>
      drain(streamResponsesApi('https://api.x.ai/v1/responses', 'tok', MINIMAL_BODY)),
    );
    const found = chunks.find((c) => c.type === 'usage');
    if (found?.type !== 'usage') throw new Error('no usage chunk emitted');
    return found;
  }

  it('reads cached_tokens from input_tokens_details', async () => {
    const usage = await usageFor({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 64 },
    });
    expect(usage.usage.cacheReadTokens).toBe(64);
    expect(usage.usage.inputTokens).toBe(100);
    expect(usage.usage.outputTokens).toBe(20);
  });

  it('reads a flattened cached_tokens on usage', async () => {
    const usage = await usageFor({ input_tokens: 100, output_tokens: 20, cached_tokens: 32 });
    expect(usage.usage.cacheReadTokens).toBe(32);
  });

  it('reports 0 when the vendor omits cached_tokens', async () => {
    const usage = await usageFor({ input_tokens: 100, output_tokens: 20 });
    expect(usage.usage.cacheReadTokens).toBe(0);
    expect(usage.usage.cacheCreationTokens).toBe(0);
  });
});

describe('package barrel', () => {
  it('exports the Responses API building blocks a second provider needs', async () => {
    const barrel = await import('../index');
    expect(typeof barrel.streamResponsesApi).toBe('function');
    expect(typeof barrel.toResponsesInput).toBe('function');
    expect(typeof barrel.toResponsesTools).toBe('function');
  });
});
