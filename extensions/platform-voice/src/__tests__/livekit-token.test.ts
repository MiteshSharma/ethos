import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLiveKitSipJwt, createLiveKitTokenMinter } from '../livekit/token';

const API_KEY = 'devkey';
const API_SECRET = 'devsecret-devsecret-devsecret-32';

function decode(token: string): { header: unknown; claims: Record<string, unknown> } {
  const [encodedHeader = '', encodedPayload = ''] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')),
  };
}

describe('createLiveKitTokenMinter', () => {
  it('mints a room-join token with the expected claims', () => {
    const minter = createLiveKitTokenMinter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      now: () => 1_700_000_000_000,
    });
    const { header, claims } = decode(minter.mint('room-7', 'agent-1'));

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(claims.iss).toBe(API_KEY);
    expect(claims.sub).toBe(API_KEY);
    expect(claims.identity).toBe('agent-1');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'room-7',
      canPublish: true,
      canSubscribe: true,
    });
    // The room-join token must NOT carry the SIP grant — it is a different
    // capability and a wider token than the media leg needs.
    expect(claims.sip).toBeUndefined();
  });

  it('honours the injected clock for nbf/exp and the ttl default', () => {
    const nowMs = 1_700_000_000_000;
    const nowSeconds = nowMs / 1000;

    const defaulted = decode(
      createLiveKitTokenMinter({ apiKey: API_KEY, apiSecret: API_SECRET, now: () => nowMs }).mint(
        'r',
        'i',
      ),
    ).claims;
    expect(defaulted.nbf).toBe(nowSeconds - 10);
    expect(defaulted.exp).toBe(nowSeconds + 3600);

    const short = decode(
      createLiveKitTokenMinter({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        ttlSeconds: 60,
        now: () => nowMs,
      }).mint('r', 'i'),
    ).claims;
    expect(short.exp).toBe(nowSeconds + 60);
  });

  it('signs HS256 over the header.payload input with the apiSecret', () => {
    const token = createLiveKitTokenMinter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      now: () => 1_700_000_000_000,
    }).mint('room-7', 'agent-1');

    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const [encodedHeader, encodedPayload, signature] = parts;
    // Independently computed — if the signer ever changes shape this fails.
    const expected = createHmac('sha256', API_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    // base64url, unpadded.
    expect(signature).not.toContain('=');
    expect(signature).not.toMatch(/[+/]/);
  });
});

describe('createLiveKitSipJwt', () => {
  it('adds the sip call grant on top of the room grant', () => {
    const { claims } = decode(
      createLiveKitSipJwt({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        roomName: 'call-1555-1666',
        now: () => 1_700_000_000_000,
      }),
    );

    expect(claims.sip).toEqual({ call: true });
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'call-1555-1666',
      canPublish: true,
      canSubscribe: true,
    });
    expect(claims.iss).toBe(API_KEY);
  });

  it('uses the same signer as the room-join minter', () => {
    const token = createLiveKitSipJwt({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      roomName: 'r',
      now: () => 1_700_000_000_000,
    });
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    expect(signature).toBe(
      createHmac('sha256', API_SECRET)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url'),
    );
  });
});
