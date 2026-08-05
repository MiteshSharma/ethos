// Lane 4b(g) + 4b(e) — dialect-scoped request-body policy, asserted on the
// serialized params (the exact object handed to the SDK, i.e. the wire body).
//
//   - strict: true on tool definitions for the vLLM dialect ONLY (eng review
//     D21). Hosted dialects (openai/openrouter/gemini/groq/deepseek → all map
//     to the 'openai' dialect) and ollama stay unchanged.
//   - topK/minP from providerOptions['openai-compat'] (written by
//     applySamplingDefaults in packages/core) reach the body as top_k/min_p
//     for the ollama and vllm dialects; hosted dialects never see them.

import type { CompletionOptions, ToolDefinitionLite } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
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
    (t) => (t as { function: Record<string, unknown> }).function,
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
    const body = params.oaiParams as Record<string, unknown>;
    expect(body.top_k).toBe(40);
    expect(body.min_p).toBe(0.05);
  });

  it('reaches the wire on the vllm dialect', () => {
    const params = buildChatCompletionsParams([], TOOLS, options, 'm', {
      structuredOutputDialect: 'vllm',
    });
    const body = params.oaiParams as Record<string, unknown>;
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
});
