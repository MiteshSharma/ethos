import { describe, expect, it, vi } from 'vitest';
import { discoverTelegramChats } from '../discover';

// One-shot chat discovery — the read that turns "message your new bot" into a
// chat the server can actually deliver to.
//
// The two properties worth pinning down are not about parsing: the request must
// never long-poll, and it must never send an `offset` (which would ACK the
// user's message and destroy the update the install re-reads to authorize their
// pick). Both are asserted against the URL, because both are silent when wrong.

const TOKEN = '5555555:AA-secret';

function respond(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('discoverTelegramChats', () => {
  it('asks for updates without a long poll and without an offset', async () => {
    const fetchImpl = respond(200, { ok: true, result: [] });
    await discoverTelegramChats(TOKEN, fetchImpl);

    const url = String(vi.mocked(fetchImpl).mock.calls[0]?.[0]);
    expect(url).toContain('timeout=0');
    // An offset would confirm the updates and Telegram would drop them.
    expect(url).not.toContain('offset');
  });

  it('names each chat rather than returning a bare id', async () => {
    const result = await discoverTelegramChats(
      TOKEN,
      respond(200, {
        ok: true,
        result: [
          { message: { chat: { id: 12345, type: 'private', first_name: 'Mitesh' } } },
          { message: { chat: { id: -900, type: 'group', title: 'Briefings' } } },
          // A repeat of a chat already seen — one row per chat, not per message.
          { message: { chat: { id: 12345, type: 'private', first_name: 'Mitesh' } } },
        ],
      }),
    );

    expect(result.status).toBe('ok');
    expect(result.chats).toEqual([
      { chatId: '12345', label: 'Mitesh', kind: 'private' },
      { chatId: '-900', label: 'Briefings', kind: 'group' },
    ]);
  });

  it('reads a 409 as "the gateway owns this token", not as an error', async () => {
    const result = await discoverTelegramChats(TOKEN, respond(409, {}));
    expect(result.status).toBe('gateway_owns_token');
    expect(result.chats).toEqual([]);
  });

  it('separates a bad token from an outage', async () => {
    expect((await discoverTelegramChats(TOKEN, respond(401))).status).toBe('rejected');
    expect((await discoverTelegramChats(TOKEN, respond(200, { ok: false }))).status).toBe(
      'rejected',
    );
    expect((await discoverTelegramChats(TOKEN, respond(429))).status).toBe('unreachable');
    expect((await discoverTelegramChats(TOKEN, respond(503))).status).toBe('unreachable');
  });

  it('never puts the token in what it returns', async () => {
    for (const status of [401, 409, 429, 503]) {
      const result = await discoverTelegramChats(TOKEN, respond(status));
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it('treats a network failure as unreachable rather than throwing', async () => {
    const boom = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect((await discoverTelegramChats(TOKEN, boom)).status).toBe('unreachable');
  });
});
