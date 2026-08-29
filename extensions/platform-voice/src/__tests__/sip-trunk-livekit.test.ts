import { describe, expect, it } from 'vitest';
import { createLiveKitSipJwt } from '../livekit/token';
import { createLiveKitSipTrunkClient } from '../sip/trunk-client-livekit';

const API_KEY = 'devkey';
const API_SECRET = 'super-secret-value-do-not-log';
const NOW = () => 1_700_000_000_000;

interface Capture {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recordingFetch(response: () => Response): {
  fetch: typeof globalThis.fetch;
  captured: Capture[];
} {
  const captured: Capture[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    captured.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return response();
  };
  return { fetch, captured };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeClient(fetch: typeof globalThis.fetch, url = 'https://lk.example.com') {
  return createLiveKitSipTrunkClient({
    url,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    trunkId: 'ST_trunk1',
    fetch,
    now: NOW,
  });
}

describe('createLiveKitSipTrunkClient', () => {
  it('POSTs the Twirp CreateSIPParticipant request with the signed SIP token', async () => {
    const { fetch, captured } = recordingFetch(() =>
      ok({ sip_call_id: 'SCL_1', participant_id: 'PA_1' }),
    );
    const handle = await makeClient(fetch).createOutboundCall({
      toNumber: '+15551234567',
      roomName: 'call-room',
      fromNumber: '+15550000001',
    });

    const [call] = captured;
    expect(call?.url).toBe('https://lk.example.com/twirp/livekit.SIP/CreateSIPParticipant');
    expect(call?.headers['Content-Type']).toBe('application/json');
    // The exact token the signer produces for THIS room — a room-join token or
    // a token for another room is rejected by LiveKit's SIP endpoint.
    expect(call?.headers.Authorization).toBe(
      `Bearer ${createLiveKitSipJwt({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        roomName: 'call-room',
        now: NOW,
      })}`,
    );
    expect(call?.body).toEqual({
      sip_trunk_id: 'ST_trunk1',
      sip_call_to: '+15551234567',
      room_name: 'call-room',
      participant_identity: '+15551234567',
      participant_name: '+15551234567',
      sip_number: '+15550000001',
    });
    expect(handle).toEqual({
      callId: 'SCL_1',
      roomName: 'call-room',
      toNumber: '+15551234567',
    });
  });

  it('omits sip_number when no fromNumber is set and honours participantIdentity', async () => {
    const { fetch, captured } = recordingFetch(() => ok({ sip_call_id: 'SCL_2' }));
    await makeClient(fetch).createOutboundCall({
      toNumber: '+15551234567',
      roomName: 'r',
      participantIdentity: 'caller-7',
    });

    expect(captured[0]?.body).not.toHaveProperty('sip_number');
    expect(captured[0]?.body.participant_identity).toBe('caller-7');
  });

  it('falls back to participant_id when the response carries no sip_call_id', async () => {
    const { fetch } = recordingFetch(() => ok({ participant_id: 'PA_9' }));
    const handle = await makeClient(fetch).createOutboundCall({ toNumber: '+1', roomName: 'r' });
    expect(handle.callId).toBe('PA_9');
  });

  it('throws on a non-2xx response with the status', async () => {
    const { fetch } = recordingFetch(() => new Response('trunk not found', { status: 404 }));
    await expect(
      makeClient(fetch).createOutboundCall({ toNumber: '+1', roomName: 'r' }),
    ).rejects.toThrow(/404.*trunk not found/s);
  });

  // A provider refusal must never echo an operator credential into a log. The
  // bearer token is minted FROM the apiSecret, so leaking it leaks the ability
  // to place calls on the operator's trunk.
  it('never echoes the apiSecret or the bearer token in the thrown message', async () => {
    const token = createLiveKitSipJwt({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      roomName: 'r',
      now: NOW,
    });
    const { fetch } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            msg: 'rejected request',
            echo: { authorization: `Bearer ${token}`, secret: API_SECRET },
          }),
          { status: 401 },
        ),
    );

    const error = await makeClient(fetch)
      .createOutboundCall({ toNumber: '+1', roomName: 'r' })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(Error);
    const message = String(error);
    expect(message).toContain('401');
    expect(message).not.toContain(API_SECRET);
    expect(message).not.toContain(token);
  });

  it('truncates a very long refusal body', async () => {
    const { fetch } = recordingFetch(() => new Response('x'.repeat(5000), { status: 500 }));
    const error = await makeClient(fetch)
      .createOutboundCall({ toNumber: '+1', roomName: 'r' })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(String(error).length).toBeLessThan(400);
  });

  it('surfaces a timeout as a clear error', async () => {
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const client = createLiveKitSipTrunkClient({
      url: 'https://lk.example.com',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      trunkId: 'ST_trunk1',
      fetch: hanging,
      now: NOW,
      timeoutMs: 5,
    });

    await expect(client.createOutboundCall({ toNumber: '+1', roomName: 'r' })).rejects.toThrow(
      /timed out after 5ms/,
    );
  });

  it('normalizes wss:// and ws:// URLs and strips trailing slashes', async () => {
    const wss = recordingFetch(() => ok({ sip_call_id: 'a' }));
    await makeClient(wss.fetch, 'wss://lk.example.com/').createOutboundCall({
      toNumber: '+1',
      roomName: 'r',
    });
    expect(wss.captured[0]?.url).toBe(
      'https://lk.example.com/twirp/livekit.SIP/CreateSIPParticipant',
    );

    const ws = recordingFetch(() => ok({ sip_call_id: 'a' }));
    await makeClient(ws.fetch, 'ws://localhost:7880').createOutboundCall({
      toNumber: '+1',
      roomName: 'r',
    });
    expect(ws.captured[0]?.url).toBe(
      'http://localhost:7880/twirp/livekit.SIP/CreateSIPParticipant',
    );
  });

  it('throws when the response carries no usable call id', async () => {
    const { fetch } = recordingFetch(() => ok({ unexpected: true }));
    await expect(
      makeClient(fetch).createOutboundCall({ toNumber: '+1', roomName: 'r' }),
    ).rejects.toThrow(/no sip_call_id or participant_id/);
  });
});
