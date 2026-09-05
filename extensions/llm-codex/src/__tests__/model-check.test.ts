import type { CompletionChunk, Logger } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../index';
import { CODEX_MODELS_URL, resetModelDiscoveryCache } from '../models';
import { ResponsesApiError } from '../transport';

// The provider's first-turn model check and the 400 hint. `fetch` is routed
// by URL: the models endpoint answers discovery, everything else is the
// Responses stream.

function sseStream(events: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const text = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`)
    .join('\n');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function completedStream() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: sseStream([
      ['response.output_text.delta', { delta: 'hi' }],
      ['response.completed', { response: { usage: { input_tokens: 1, output_tokens: 1 } } }],
    ]),
    text: async () => '',
  };
}

function badRequest(detail: string) {
  const body = JSON.stringify({ detail });
  return { ok: false, status: 400, statusText: 'Bad Request', body: null, text: async () => body };
}

function liveModels(ids: string[]) {
  return { ok: true, status: 200, json: async () => ({ models: ids.map((id) => ({ id })) }) };
}

const LIVE_ROSTER = ['gpt-5.6-terra', 'gpt-5.6-sol'];

function installFetch(handlers: { models: () => unknown; responses: () => unknown }) {
  const mock = vi.fn(async (url: string | URL | Request) =>
    String(url).startsWith(CODEX_MODELS_URL) ? handlers.models() : handlers.responses(),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function modelsCalls(mock: ReturnType<typeof installFetch>): number {
  return mock.mock.calls.filter(([url]) => String(url).startsWith(CODEX_MODELS_URL)).length;
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function makeProvider(model: string, logger: Logger) {
  return new CodexProvider({ model, getAccessToken: async () => 'tok', logger });
}

async function drain(iterable: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const MESSAGES = [{ role: 'user' as const, content: 'ping' }];

const EXPECTED_WARNING =
  'Codex: model "gpt-5.6" is not available to this ChatGPT account. Supported: gpt-5.6-terra, gpt-5.6-sol — set `model:` in ~/.ethos/config.yaml to one of these.';

describe('CodexProvider model check', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => resetModelDiscoveryCache());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('warns once when the configured model is missing from the live roster', async () => {
    const fetchMock = installFetch({
      models: () => liveModels(LIVE_ROSTER),
      responses: completedStream,
    });
    const logger = makeLogger();
    const provider = makeProvider('gpt-5.6', logger);

    await drain(provider.complete(MESSAGES, [], {}));
    await drain(provider.complete(MESSAGES, [], {}));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(EXPECTED_WARNING);
    expect(modelsCalls(fetchMock)).toBe(1);
  });

  it('stays silent when the configured model is on the live roster', async () => {
    installFetch({ models: () => liveModels(LIVE_ROSTER), responses: completedStream });
    const logger = makeLogger();

    await drain(makeProvider('gpt-5.6-terra', logger).complete(MESSAGES, [], {}));

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays silent when discovery fails — the fallback roster is not authoritative', async () => {
    installFetch({
      models: () => {
        throw new Error('ECONNREFUSED');
      },
      responses: completedStream,
    });
    const logger = makeLogger();

    const chunks = await drain(makeProvider('gpt-5.6', logger).complete(MESSAGES, [], {}));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(chunks.some((chunk) => chunk.type === 'text_delta')).toBe(true);
  });

  it('appends the supported-model hint to a model-rejection 400', async () => {
    installFetch({
      models: () => liveModels(LIVE_ROSTER),
      responses: () =>
        badRequest("The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."),
    });

    await expect(
      drain(makeProvider('gpt-5.6', makeLogger()).complete(MESSAGES, [], {})),
    ).rejects.toThrow(
      `Codex Responses API error 400: {"detail":"The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."} — ${EXPECTED_WARNING}`,
    );
  });

  it('passes every other 400 through untouched', async () => {
    installFetch({
      models: () => liveModels(LIVE_ROSTER),
      responses: () => badRequest('Unsupported parameter: max_output_tokens'),
    });

    const failure = await drain(
      makeProvider('gpt-5.6-terra', makeLogger()).complete(MESSAGES, [], {}),
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ResponsesApiError);
    expect((failure as Error).message).toBe(
      'Codex Responses API error 400: {"detail":"Unsupported parameter: max_output_tokens"}',
    );
  });
});
