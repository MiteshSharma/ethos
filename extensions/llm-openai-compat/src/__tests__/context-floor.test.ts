// Phase 1d — local-model effective-context floor. Ollama/vLLM silently
// truncate below their configured window; agentic tool use needs a 16k floor.
// A sub-floor window must fail LOUDLY at provider construction.

import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../index';

describe('OpenAICompatProvider — local context floor (Phase 1d)', () => {
  it('throws loudly when an Ollama window is below the 16k floor', () => {
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'ollama',
          apiKey: 'k',
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3.2',
          maxContextTokens: 8_000,
        }),
    ).toThrow(/16000-token floor/);
  });

  it('throws for vLLM below the floor', () => {
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'vllm',
          apiKey: 'k',
          baseUrl: 'http://localhost:8000/v1',
          model: 'qwen',
          maxContextTokens: 4_096,
        }),
    ).toThrow(/floor required for agentic tool use/);
  });

  it('accepts an Ollama window at or above the floor', () => {
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'ollama',
          apiKey: 'k',
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3.2',
          maxContextTokens: 32_768,
        }),
    ).not.toThrow();
  });

  it('does NOT gate non-local (cloud openai-compat) providers', () => {
    // A cloud provider with a small configured window must not trip the floor.
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'openrouter',
          apiKey: 'k',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'some/model',
          maxContextTokens: 8_000,
        }),
    ).not.toThrow();
  });

  // Post-review FIX 6 — LM Studio and llama.cpp classifications get the floor
  // too; post-review FIX 2 — a hosted alias behind a proxy on a local port
  // never does.
  it('throws for LM Studio below the floor (FIX 6)', () => {
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'lmstudio',
          apiKey: 'k',
          baseUrl: 'http://localhost:1234/v1',
          model: 'qwen3:8b',
          maxContextTokens: 8_000,
        }),
    ).toThrow(/16000-token floor/);
  });

  it('throws for llama.cpp below the floor (FIX 6)', () => {
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'llamacpp',
          apiKey: 'k',
          baseUrl: 'http://localhost:8080/v1',
          model: 'qwen3-8b',
          maxContextTokens: 8_000,
        }),
    ).toThrow(/16000-token floor/);
  });

  it('does NOT gate a hosted alias proxied through a local-looking port (FIX 2)', () => {
    expect(
      () =>
        new OpenAICompatProvider({
          name: 'openrouter',
          apiKey: 'k',
          baseUrl: 'https://proxy.corp.example:8080/v1',
          model: 'some/model',
          maxContextTokens: 8_000,
        }),
    ).not.toThrow();
  });
});
