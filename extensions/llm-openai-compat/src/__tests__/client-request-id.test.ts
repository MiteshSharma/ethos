// B2 — outbound provider correlation. The agent loop mints one `requestId` per
// LLM call; openai-compat sends it as the `X-Client-Request-Id` request header
// so a provider-side log line can be matched back to our trace.
//
// Asserted against a MOCK transport — the header is a property of the request
// we hand the SDK, so no network call is needed (or wanted) to prove it.

import { describe, expect, it, vi } from 'vitest';

interface CapturedCall {
  body: unknown;
  options: { headers?: Record<string, string> } | undefined;
}

const calls: CapturedCall[] = [];

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async (body: unknown, options?: { headers?: Record<string, string> }) => {
          calls.push({ body, options });
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
              yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
            },
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

async function drive(options: { requestId?: string }): Promise<CapturedCall> {
  calls.length = 0;
  const { OpenAICompatProvider } = await import('../index');
  const provider = new OpenAICompatProvider({
    name: 'openai',
    model: 'gpt-4o',
    apiKey: 'k',
    baseUrl: 'https://example.invalid/v1',
  });
  for await (const _c of provider.complete([{ role: 'user', content: 'hi' }], [], options)) {
    // drain
  }
  const call = calls[0];
  if (!call) throw new Error('transport was never called');
  return call;
}

describe('openai-compat outbound request correlation (B2)', () => {
  it('sends the loop requestId as the X-Client-Request-Id header', async () => {
    const call = await drive({ requestId: 'a1b2c3d4-0000-4000-8000-000000000001' });
    // Pre-fix: `options` is `{ signal: undefined }` — no headers at all.
    expect(call.options?.headers).toEqual({
      'X-Client-Request-Id': 'a1b2c3d4-0000-4000-8000-000000000001',
    });
  });

  it('does not put the id in the request body (headers only — the body stays byte-stable)', async () => {
    const call = await drive({ requestId: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(JSON.stringify(call.body)).not.toContain('a1b2c3d4-0000-4000-8000-000000000001');
  });

  it('sends no correlation header when the caller minted no requestId', async () => {
    const call = await drive({});
    expect(call.options?.headers).toBeUndefined();
  });
});
