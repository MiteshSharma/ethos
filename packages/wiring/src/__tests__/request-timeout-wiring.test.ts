// Lane 4a(d) — requestTimeoutMs / maxRetries thread from WiringConfig through
// createLLM to the OpenAI SDK client, and — the CRITICAL acceptance criterion —
// with NO keys set the constructed client keeps the inherited SDK defaults
// exactly (10-minute timeout, 2 retries), so an unconfigured hosted provider
// sees no latency or retry-behavior change.

import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { describe, expect, it } from 'vitest';
import { createLLM } from '../index';

const SDK_DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const SDK_DEFAULT_MAX_RETRIES = 2;

function clientOf(provider: unknown): { timeout: number; maxRetries: number } {
  return (provider as { client: { timeout: number; maxRetries: number } }).client;
}

describe('createLLM — requestTimeoutMs / maxRetries threading (Lane 4a(d))', () => {
  it('no keys set → the client keeps the SDK defaults exactly', async () => {
    const provider = await createLLM({
      provider: 'openrouter',
      model: 'qwen/qwen3-8b',
      apiKey: 'k',
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    const client = clientOf(provider);
    expect(client.timeout).toBe(SDK_DEFAULT_TIMEOUT_MS);
    expect(client.maxRetries).toBe(SDK_DEFAULT_MAX_RETRIES);
  });

  it('configured values reach the client', async () => {
    const provider = await createLLM({
      provider: 'openrouter',
      model: 'qwen/qwen3-8b',
      apiKey: 'k',
      requestTimeoutMs: 120_000,
      maxRetries: 0,
    });
    const client = clientOf(provider);
    expect(client.timeout).toBe(120_000);
    expect(client.maxRetries).toBe(0);
  });
});
