// Golden request body for the xAI Responses API, plus the guarantees that are
// wire-level rather than declarative: the pinned endpoint, the single secret
// ref, and the parameters that must never appear.
//
// The wire is captured by stubbing `globalThis.fetch` — `streamResponsesApi`
// (@ethosagent/llm-codex) issues the request itself and takes no `fetchImpl`
// seam, so this is the equivalent capture point.

import { classifyLocalRuntime } from '@ethosagent/llm-openai-compat';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XAI_SECRET_REF, XaiProvider, xaiFactory } from '../index';

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const captured: { last?: Captured } = {};
const realFetch = globalThis.fetch;

function sseOk(): Response {
  const text =
    'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n' +
    'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
  return new Response(text, { status: 200 });
}

function stubFetch(respond: () => Response) {
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    const req = init as { body?: string; headers?: Record<string, string> };
    captured.last = {
      url: String(url),
      body: JSON.parse(req?.body ?? '{}') as Record<string, unknown>,
      headers: req?.headers ?? {},
    };
    return respond();
  }) as unknown as typeof fetch;
}

async function drain(provider: XaiProvider, options = {}) {
  for await (const _ of provider.complete(
    [{ role: 'user', content: 'hello' }],
    [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    options,
  )) {
    // discard — this test asserts on the request, not the response
  }
}

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function secretsWith(value: string | null, seen: string[] = []): SecretsResolver {
  return {
    get: async (ref: string) => {
      seen.push(ref);
      return value;
    },
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };
}

describe('xAI request body', () => {
  beforeEach(() => {
    captured.last = undefined;
    stubFetch(sseOk);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('sends model, input, stream, store:false and tools', async () => {
    await drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }), { system: 'be brief' });
    const body = captured.last?.body;
    expect(body).toBeDefined();
    expect(body?.model).toBe('grok-4.6');
    expect(Array.isArray(body?.input)).toBe(true);
    expect(body?.stream).toBe(true);
    expect(body?.store).toBe(false);
    expect(body?.instructions).toBe('be brief');
    expect(body?.tools).toHaveLength(1);
    expect(body?.tool_choice).toBe('auto');
    expect(body?.parallel_tool_calls).toBe(true);
  });

  it('omits `include` by default — no consumer reads reasoning back across turns (D6)', async () => {
    await drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }));
    expect(captured.last?.body).not.toHaveProperty('include');
    expect(captured.last?.body).not.toHaveProperty('reasoning');
  });

  it('never sends stop, presence_penalty or frequency_penalty', async () => {
    // xAI's reasoning models REJECT all three with an error, and grok-4.6
    // reasons by default. `stop` is the reachable one — a caller can set
    // `CompletionOptions.stopSequences`, as this test does. The two penalties
    // are FORWARD-LOOKING guards: no transport in this repo can emit them
    // today, so their absence is not evidence of a bug that was fixed.
    await drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }), {
      stopSequences: ['\n\nHuman:'],
    });
    const body = captured.last?.body;
    expect(body).not.toHaveProperty('stop');
    expect(body).not.toHaveProperty('stop_sequences');
    expect(body).not.toHaveProperty('presence_penalty');
    expect(body).not.toHaveProperty('frequency_penalty');
  });

  it('never sends temperature, top_p or seed, even when a caller supplies them', async () => {
    // GATED ON AN UNRUN LIVE PROBE. Whether grok-4.6 accepts these is open
    // question 2 of plan/phases/xai-grok-provider.md; no xAI key was available.
    // They also arrive without a caller asking, from a model row's sampling
    // `profile` via `applySamplingDefaults`. If a live 200 later proves they are
    // accepted, this test is the deliberate gate to change — not a mistake.
    await drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }), {
      temperature: 0.7,
      topP: 0.9,
      seed: 42,
    });
    const body = captured.last?.body;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('seed');
  });

  it('posts to the pinned https://api.x.ai/v1/responses endpoint', async () => {
    await drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }));
    expect(captured.last?.url).toBe('https://api.x.ai/v1/responses');
    expect(captured.last?.headers.Authorization).toBe('Bearer k');
  });

  it('honours modelOverride', async () => {
    await drain(new XaiProvider({ model: 'grok-4.6', apiKey: 'k' }), {
      modelOverride: 'grok-4.3',
    });
    expect(captured.last?.body.model).toBe('grok-4.3');
  });
});

describe('xaiFactory', () => {
  beforeEach(() => {
    captured.last = undefined;
    stubFetch(sseOk);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('resolves the credential from the existing providers/xai/apiKey ref', async () => {
    const seen: string[] = [];
    const provider = await xaiFactory({
      config: {},
      secrets: secretsWith('secret-key', seen),
      logger: noopLogger,
    });
    expect(seen).toEqual([XAI_SECRET_REF]);
    expect(XAI_SECRET_REF).toBe('providers/xai/apiKey');
    expect(provider.model).toBe('grok-4.6');
  });

  it('a config baseUrl cannot point the provider at another host', async () => {
    const provider = await xaiFactory({
      config: { baseUrl: 'https://openrouter.ai/api/v1', model: 'grok-4.6', apiKey: 'k' },
      secrets: secretsWith(null),
      logger: noopLogger,
    });
    for await (const _ of provider.complete([], [], {})) {
      // discard
    }
    expect(captured.last?.url).toBe('https://api.x.ai/v1/responses');
  });

  it('a missing key names both the secret ref and the env var', async () => {
    await expect(
      xaiFactory({ config: {}, secrets: secretsWith(null), logger: noopLogger }),
    ).rejects.toThrow(/providers\/xai\/apiKey[\s\S]*XAI_API_KEY/);
  });
});

describe('unknown model', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('turns a 404 into an actionable error naming the model and the config key', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'The model grok-9 does not exist' }), { status: 404 }),
    );
    const provider = new XaiProvider({ model: 'grok-9', apiKey: 'k' });
    await expect(drain(provider)).rejects.toThrow(/grok-9[\s\S]*model_not_found[\s\S]*`model:`/);
  });

  it('leaves other failures alone, labelled xAI rather than Codex', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }));
    const provider = new XaiProvider({ model: 'grok-4.6', apiKey: 'bad' });
    await expect(drain(provider)).rejects.toThrow(/xAI Responses API error 401/);
  });
});

describe('local-runtime classification (constraint 15)', () => {
  // `detectLocalRuntime` is called with the CONFIG's baseUrl, not the endpoint
  // this provider pins, so a leftover or proxied baseUrl on a well-known local
  // port must not reclassify a paid hosted provider as local — that would report
  // $0 cost and take the local context-window path.
  it.each(['http://localhost:11434/v1', 'http://localhost:1234/v1', 'http://localhost:8080/v1'])(
    'xai stays hosted with baseUrl %s',
    (baseUrl) => {
      expect(classifyLocalRuntime('xai', baseUrl)).toBeUndefined();
    },
  );
});
