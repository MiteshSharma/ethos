// Lane 4a(d) — configurable timeout + retry, pinned to the SDK defaults.
//
// CRITICAL acceptance criterion (plan Lane 4): with NO keys configured, the
// constructed client's effective timeout and retry count must be IDENTICAL to
// the inherited OpenAI SDK defaults (10-minute timeout, 2 retries) — asserted
// here at the construction site, against both the literal values and a bare
// SDK client, so an unconfigured hosted provider sees zero behavior change.
//
// The default stays LONG on purpose: a cold local model load (Ollama paging
// weights into RAM/VRAM) legitimately takes minutes; a short default would
// break the first turn on every fresh server start.
//
// This file must NOT mock the `openai` module — the whole point is asserting
// what the real SDK client got at construction.

import type { Logger, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider, openaiCompatFactory } from '../index';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const noopSecrets: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

interface ClientView {
  client: { timeout: number; maxRetries: number };
}

function clientOf(provider: OpenAICompatProvider): ClientView['client'] {
  return (provider as unknown as ClientView).client;
}

const SDK_DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const SDK_DEFAULT_MAX_RETRIES = 2;

describe('OpenAICompatProvider — client timeout/retries (Lane 4a(d))', () => {
  it('with NO keys set, the client inherits the SDK defaults exactly (10-minute timeout, 2 retries)', async () => {
    const provider = new OpenAICompatProvider({
      name: 'openrouter',
      model: 'qwen/qwen3-8b',
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const client = clientOf(provider);
    expect(client.timeout).toBe(SDK_DEFAULT_TIMEOUT_MS);
    expect(client.maxRetries).toBe(SDK_DEFAULT_MAX_RETRIES);

    // Belt and braces: identical to a bare SDK client constructed with no
    // timeout/retry options at all — if the SDK defaults ever move, this
    // catches the drift without silently pinning stale literals.
    const OpenAI = (await import('openai')).default;
    const bare = new OpenAI({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1' });
    expect(client.timeout).toBe(bare.timeout);
    expect(client.maxRetries).toBe(bare.maxRetries);
  });

  it('configured requestTimeoutMs and maxRetries reach the client', () => {
    const provider = new OpenAICompatProvider({
      name: 'ollama',
      model: 'qwen3:8b',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      maxContextTokens: 32_000,
      requestTimeoutMs: 120_000,
      maxRetries: 0,
    });
    const client = clientOf(provider);
    expect(client.timeout).toBe(120_000);
    expect(client.maxRetries).toBe(0);
  });

  it('the factory threads requestTimeoutMs/maxRetries from config to the provider', async () => {
    const provider = await openaiCompatFactory({
      config: {
        provider: 'openai-compat',
        model: 'gpt-4o',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        requestTimeoutMs: 45_000,
        maxRetries: 5,
      },
      secrets: noopSecrets,
      logger: noopLogger,
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    const client = clientOf(provider as OpenAICompatProvider);
    expect(client.timeout).toBe(45_000);
    expect(client.maxRetries).toBe(5);
  });

  it('the factory leaves the SDK defaults in force when config carries no keys', async () => {
    const provider = await openaiCompatFactory({
      config: {
        provider: 'openai-compat',
        model: 'gpt-4o',
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
      },
      secrets: noopSecrets,
      logger: noopLogger,
    });
    const client = clientOf(provider as OpenAICompatProvider);
    expect(client.timeout).toBe(SDK_DEFAULT_TIMEOUT_MS);
    expect(client.maxRetries).toBe(SDK_DEFAULT_MAX_RETRIES);
  });
});
