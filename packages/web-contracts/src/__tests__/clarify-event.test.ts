// D3 — `ClarifyRequestEventSchema` is a strict Zod object: a key it does not
// declare is stripped SILENTLY on parse, with no error to notice. So a takeover
// event that survives `parse` with `kind` and `meta` intact is the only thing
// that proves the web surface can branch on them at all — a test that parses
// only the happy question case passes just as well against a schema that drops
// both fields on the floor.

import { describe, expect, it } from 'vitest';
import { ClarifyRequestEventSchema } from '../events';

const BASE = {
  type: 'clarify.request' as const,
  requestId: 'r1',
  question: 'stuck on a login',
  defaultDeadlineAt: '2026-09-05T00:15:00.000Z',
};

describe('ClarifyRequestEventSchema — kind/meta (D3)', () => {
  it('carries kind and meta through a parse intact', () => {
    const parsed = ClarifyRequestEventSchema.parse({
      ...BASE,
      kind: 'browser_takeover',
      meta: {
        url: 'https://accounts.example.com/signin',
        sessionId: 'browser-7',
        handbackUrl: 'https://ethos.local/chat/s1',
      },
    });

    expect(parsed.kind).toBe('browser_takeover');
    expect(parsed.meta).toEqual({
      url: 'https://accounts.example.com/signin',
      sessionId: 'browser-7',
      handbackUrl: 'https://ethos.local/chat/s1',
    });
    // The strip this test exists to catch would leave the key absent, not just
    // undefined.
    expect(Object.keys(parsed)).toContain('kind');
    expect(Object.keys(parsed)).toContain('meta');
  });

  it('accepts an event with no kind — the pre-D3 shape, read as a question', () => {
    const parsed = ClarifyRequestEventSchema.parse(BASE);
    expect(parsed.kind).toBeUndefined();
    expect(parsed.kind ?? 'question').toBe('question');
  });

  it('rejects a kind outside the union rather than passing it to the card', () => {
    const result = ClarifyRequestEventSchema.safeParse({ ...BASE, kind: 'screencast' });
    expect(result.success).toBe(false);
  });

  it('accepts a partially populated meta — every field is optional', () => {
    const parsed = ClarifyRequestEventSchema.parse({
      ...BASE,
      kind: 'browser_takeover',
      meta: { url: 'https://example.com/login' },
    });
    expect(parsed.meta?.url).toBe('https://example.com/login');
    expect(parsed.meta?.handbackUrl).toBeUndefined();
  });
});
