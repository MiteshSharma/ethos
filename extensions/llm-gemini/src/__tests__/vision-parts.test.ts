import type { Message } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamGeminiGenerate } from '../transport';

// C4 — Gemini carries images AND PDFs through `inlineData`. Before this was
// wired, a `document` block fell to the default branch and reached the model as
// the literal text "undefined" while the provider advertised
// `visionDocuments: true`.

function captureRequestBody(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      // Minimal well-formed SSE stream so the generator terminates.
      return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return { body: () => captured };
}

async function drain(messages: Message[]): Promise<void> {
  for await (const _ of streamGeminiGenerate(
    { apiKey: 'k', model: 'gemini-2.5-flash' },
    messages,
    [],
    {},
  )) {
    // consume
  }
}

describe('Gemini inline media parts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps image and document blocks to inlineData keyed by mime type', async () => {
    const cap = captureRequestBody();
    await drain([
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
          { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0K' },
          { type: 'text', text: 'what is in these?' },
        ],
      },
    ]);

    const contents = cap.body().contents as Array<{ parts: unknown[] }>;
    expect(contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0K' } },
      { text: 'what is in these?' },
    ]);
  });

  it('never sends a document as the string "undefined"', async () => {
    const cap = captureRequestBody();
    await drain([
      {
        role: 'user',
        content: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0K' }],
      },
    ]);
    expect(JSON.stringify(cap.body())).not.toContain('undefined');
  });
});
