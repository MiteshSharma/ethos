import { estimateCost } from '@ethosagent/pricing';
import type { CompletionChunk, TokenUsage } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamGeminiGenerate } from '../transport';

// A5 — Gemini's transport used to hardcode `estimatedCostUsd: 0` on every usage
// chunk, so a Gemini deployment reported its whole spend as free. These drive
// the real SSE parser over a stubbed fetch.

function sseResponse(events: object[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const text = events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n');
      controller.enqueue(new TextEncoder().encode(`${text}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collectUsage(model: string): Promise<TokenUsage | undefined> {
  const chunks: CompletionChunk[] = [];
  for await (const chunk of streamGeminiGenerate(
    { apiKey: 'k', model },
    [{ role: 'user', content: 'hi' }],
    [],
    {},
  )) {
    chunks.push(chunk);
  }
  const usage = chunks.find((c) => c.type === 'usage');
  return usage?.type === 'usage' ? usage.usage : undefined;
}

function stubFetch(usageMetadata: Record<string, number>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      sseResponse([
        {
          candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
          usageMetadata,
        },
      ]),
    ),
  );
}

describe('Gemini usage pricing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prices a Gemini turn instead of reporting $0', async () => {
    const meta = { promptTokenCount: 10_000, candidatesTokenCount: 2000 };
    stubFetch(meta);

    const usage = (await collectUsage('gemini-2.5-pro')) as TokenUsage;
    expect(usage.inputTokens).toBe(10_000);
    expect(usage.outputTokens).toBe(2000);
    // 10_000 * 1.25 + 2000 * 10 = 32_500 per 1M
    expect(usage.estimatedCostUsd).toBeCloseTo(32_500 / 1_000_000, 12);
  });

  it('does not bill cached content twice', async () => {
    // Gemini's promptTokenCount INCLUDES cachedContentTokenCount, so pricing the
    // full prompt at the input rate AND the cached slice at the cache rate would
    // charge the cached tokens twice.
    const meta = {
      promptTokenCount: 10_000,
      candidatesTokenCount: 2000,
      cachedContentTokenCount: 8000,
    };
    stubFetch(meta);

    const usage = (await collectUsage('gemini-2.5-pro')) as TokenUsage;
    expect(usage.cacheReadTokens).toBe(8000);

    const expected = estimateCost('gemini-2.5-pro', {
      inputTokens: 2000,
      outputTokens: 2000,
      cacheReadTokens: 8000,
    }).costUsd;
    expect(usage.estimatedCostUsd).toBeCloseTo(expected, 12);

    // Strictly cheaper than the same turn with nothing cached.
    const uncached = estimateCost('gemini-2.5-pro', {
      inputTokens: 10_000,
      outputTokens: 2000,
    }).costUsd;
    expect(usage.estimatedCostUsd).toBeLessThan(uncached);
  });

  it('reports 0 for a model with no rate rather than guessing', async () => {
    const meta = { promptTokenCount: 10_000, candidatesTokenCount: 2000 };
    stubFetch(meta);

    const usage = (await collectUsage('gemini-9.9-imaginary')) as TokenUsage;
    expect(usage.estimatedCostUsd).toBe(0);
  });
});
