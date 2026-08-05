// Lane 4b(g) + 4b(e) — dialect-scoped request-body policy, asserted on the
// serialized params (the exact object handed to the SDK, i.e. the wire body).
//
//   - strict: true on tool definitions for the vLLM dialect ONLY (eng review
//     D21). Hosted dialects (openai/openrouter/gemini/groq/deepseek → all map
//     to the 'openai' dialect) and ollama stay unchanged.
//   - topK/minP from providerOptions['openai-compat'] (written by
//     applySamplingDefaults in packages/core) reach the body as top_k/min_p
//     for the ollama and vllm dialects; hosted dialects never see them.

import type {
  CompletionChunk,
  CompletionOptions,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';
import { buildChatCompletionsParams } from '../transport';

const TOOLS: ToolDefinitionLite[] = [
  {
    name: 'echo',
    description: 'echo tool',
    parameters: { type: 'object', properties: { x: { type: 'number' } } },
  },
];

function toolFns(params: ReturnType<typeof buildChatCompletionsParams>) {
  return (params.oaiParams.tools ?? []).map(
    (t) => (t as unknown as { function: Record<string, unknown> }).function,
  );
}

describe('strict: true on tool definitions (Lane 4b(g), D21)', () => {
  it('sets strict: true per tool on the vllm dialect', () => {
    const params = buildChatCompletionsParams([], TOOLS, {}, 'm', {
      structuredOutputDialect: 'vllm',
    });
    for (const fn of toolFns(params)) expect(fn.strict).toBe(true);
    // And it survives serialization to the wire bytes.
    expect(JSON.stringify(params.oaiParams)).toContain('"strict":true');
  });

  it('does NOT set strict on the openai (hosted) dialect', () => {
    const params = buildChatCompletionsParams([], TOOLS, {}, 'm', {
      structuredOutputDialect: 'openai',
    });
    for (const fn of toolFns(params)) expect('strict' in fn).toBe(false);
    expect(JSON.stringify(params.oaiParams)).not.toContain('strict');
  });

  it('does NOT set strict on the ollama dialect or when no dialect is given', () => {
    const ollama = buildChatCompletionsParams([], TOOLS, {}, 'm', {
      structuredOutputDialect: 'ollama',
    });
    for (const fn of toolFns(ollama)) expect('strict' in fn).toBe(false);
    const bare = buildChatCompletionsParams([], TOOLS, {}, 'm');
    for (const fn of toolFns(bare)) expect('strict' in fn).toBe(false);
  });
});

describe('topK/minP wiring (Lane 4b(e))', () => {
  const options: CompletionOptions = {
    providerOptions: { 'openai-compat': { topK: 40, minP: 0.05 } },
  };

  it('reaches the wire as top_k/min_p on the ollama dialect', () => {
    const params = buildChatCompletionsParams([], TOOLS, options, 'm', {
      structuredOutputDialect: 'ollama',
    });
    const body = params.oaiParams as unknown as Record<string, unknown>;
    expect(body.top_k).toBe(40);
    expect(body.min_p).toBe(0.05);
  });

  it('reaches the wire on the vllm dialect', () => {
    const params = buildChatCompletionsParams([], TOOLS, options, 'm', {
      structuredOutputDialect: 'vllm',
    });
    const body = params.oaiParams as unknown as Record<string, unknown>;
    expect(body.top_k).toBe(40);
    expect(body.min_p).toBe(0.05);
  });

  it('is ABSENT on hosted dialects even when the profile sets topK/minP', () => {
    const params = buildChatCompletionsParams([], TOOLS, options, 'm', {
      structuredOutputDialect: 'openai',
    });
    const body = JSON.stringify(params.oaiParams);
    expect(body).not.toContain('top_k');
    expect(body).not.toContain('min_p');
  });

  it('is absent when no providerOptions are set (no new keys on any dialect)', () => {
    for (const dialect of ['openai', 'ollama', 'vllm'] as const) {
      const params = buildChatCompletionsParams([], TOOLS, {}, 'm', {
        structuredOutputDialect: dialect,
      });
      const body = JSON.stringify(params.oaiParams);
      expect(body).not.toContain('top_k');
      expect(body).not.toContain('min_p');
    }
  });

  // Post-review FIX 6 — lmstudio/llamacpp fall through to the 'openai'
  // response-format dialect but DO accept top_k/min_p; the hardened
  // localRuntime classification carries them there. Hosted stays clean.
  it('reaches the wire for the lmstudio and llamacpp classifications (FIX 6)', () => {
    for (const localRuntime of ['lmstudio', 'llamacpp'] as const) {
      const params = buildChatCompletionsParams([], TOOLS, options, 'm', {
        structuredOutputDialect: 'openai',
        localRuntime,
      });
      const body = params.oaiParams as unknown as Record<string, unknown>;
      expect(body.top_k).toBe(40);
      expect(body.min_p).toBe(0.05);
      // response_format selection is untouched — no format/guided_json keys.
      const wire = JSON.stringify(params.oaiParams);
      expect(wire).not.toContain('guided_json');
      expect(wire).not.toContain('"format"');
    }
  });

  it('stays ABSENT on the hosted path when no local classification is present (FIX 2)', () => {
    const params = buildChatCompletionsParams([], TOOLS, options, 'm', {
      structuredOutputDialect: 'openai',
    });
    const body = JSON.stringify(params.oaiParams);
    expect(body).not.toContain('top_k');
    expect(body).not.toContain('min_p');
  });
});

// ---------------------------------------------------------------------------
// FIX 2 (residual) — dialect DETECTION goes through the hardened classifier,
// not a raw port check. Asserted on the wire bytes via the fetch seam.
// ---------------------------------------------------------------------------

const OPENAI_SSE = [
  `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
  })}`,
  '',
  `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function captureFetch(bodies: string[]): typeof globalThis.fetch {
  return (async (_input: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ''));
    return new Response(OPENAI_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
}

async function drain(iter: AsyncIterable<CompletionChunk>): Promise<void> {
  for await (const _chunk of iter) {
    // drain
  }
}

const USER: Message[] = [{ role: 'user', content: 'hi' }];

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { meets: { type: 'boolean' } },
  required: ['meets'],
  additionalProperties: false,
};

/** responseFormat (dialect-mapped) + topK/minP (local-gated) in one bag. */
const DIALECT_OPTS: CompletionOptions = {
  providerOptions: {
    'openai-compat': { responseFormat: { name: 'verdict', schema: SCHEMA }, topK: 40, minP: 0.05 },
  },
};

describe('dialect detection consults the hardened runtime classifier (FIX 2 residual)', () => {
  it('a hosted alias (openrouter) proxied on :11434 gets the openai dialect — no format/top_k/min_p', async () => {
    const bodies: string[] = [];
    const provider = new OpenAICompatProvider({
      name: 'openrouter',
      model: 'some/model',
      apiKey: 'k',
      baseUrl: 'http://corp-proxy:11434/v1',
      fetchImpl: captureFetch(bodies),
    });
    await drain(provider.complete(USER, [], DIALECT_OPTS));
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    // openai dialect: response_format json_schema, never Ollama's top-level format.
    expect(body).toContain('"response_format"');
    expect(body).not.toContain('"format"');
    // hosted → local sampling extras never fire, regardless of port.
    expect(body).not.toContain('top_k');
    expect(body).not.toContain('min_p');
  });

  it("the 'ollama' alias keeps the ollama dialect: top-level format + top_k/min_p (unchanged)", async () => {
    const bodies: string[] = [];
    const provider = new OpenAICompatProvider({
      name: 'ollama',
      model: 'llama3.2',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl: captureFetch(bodies),
    });
    await drain(provider.complete(USER, [], DIALECT_OPTS));
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';
    expect(body).toContain('"format"');
    expect(body).not.toContain('"response_format"');
    expect(body).toContain('"top_k":40');
    expect(body).toContain('"min_p":0.05');
  });

  it('a generic (unrecognized) name on :11434 still resolves to the ollama dialect', async () => {
    const bodies: string[] = [];
    const provider = new OpenAICompatProvider({
      name: 'openai-compat',
      model: 'llama3.2',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl: captureFetch(bodies),
    });
    await drain(provider.complete(USER, [], DIALECT_OPTS));
    const body = bodies[0] ?? '';
    expect(body).toContain('"format"');
    expect(body).not.toContain('"response_format"');
  });
});
