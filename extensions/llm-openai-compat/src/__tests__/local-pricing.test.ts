// A5 — the local-runtime seam that keeps an intentional $0 distinguishable from
// an unpriced one. Pricing reads the runtime classification, not the model name:
// `deepseek-r1` and `mistral` each name both an Ollama pull and a paid hosted
// model, so a name-only rule would either bill a local box or silently zero a
// hosted invoice.

import { estimateCost } from '@ethosagent/pricing';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';
import { buildChatCompletionsParams } from '../transport';

describe('local-runtime propagation into pricing', () => {
  it('marks params from a local runtime', () => {
    const params = buildChatCompletionsParams([], [], {}, 'deepseek-r1', {
      localRuntime: 'ollama',
    });
    expect(params.localRuntime).toBe(true);
  });

  it('leaves params from a hosted provider unmarked', () => {
    const params = buildChatCompletionsParams([], [], {}, 'deepseek-r1', {});
    expect(params.localRuntime).toBe(false);
  });

  it('classifies an Ollama provider as a local runtime', () => {
    const ollama = new OpenAICompatProvider({
      name: 'ollama',
      apiKey: 'unused',
      baseUrl: 'http://localhost:11434/v1',
      model: 'deepseek-r1',
      maxContextTokens: 32_768,
    });
    expect(ollama.localRuntime).toBe('ollama');

    const hosted = new OpenAICompatProvider({
      name: 'deepseek',
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-r1',
    });
    expect(hosted.localRuntime).toBeUndefined();
  });

  it('yields two different zeros for the same model id', () => {
    const local = estimateCost(
      'deepseek-r1',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { localRuntime: true },
    );
    const hosted = estimateCost('deepseek-r1', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(local).toEqual({ costUsd: 0, basis: 'local' });
    expect(hosted.basis).toBe('priced');
    expect(hosted.costUsd).toBeGreaterThan(0);
  });
});
