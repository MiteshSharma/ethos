import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodeVoiceServerFrame,
  encodeVoiceFrame,
  pcm16ToBytes,
  VOICE_SOCKET_PATH,
  type VoiceClientFrame,
  type VoiceServerFrame,
} from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { VoiceService } from '../../services/voice.service';
import { createVoiceSocket, originAllowed, readCookie, type VoiceSocket } from '../voice-socket';

// The socket half: upgrade policy (path, Origin, credentials) and the round
// trip over a REAL `ws` connection. The conversation protocol itself is tested
// against `VoiceLane` directly in voice-lane.test.ts.

const COOKIE = 'ethos_auth=good-token';

/** A VoiceService stand-in — only the two methods the lane actually calls. */
function fakeVoiceService(): VoiceService {
  return {
    transcribeBytes: () => Promise.resolve({ text: 'over the wire', provider: 'fake-stt' }),
    synthesizeStream: async function* () {
      yield { audio: new Uint8Array([7, 8, 9]), format: 'opus' as const, provider: 'fake-tts' };
    },
  } as unknown as VoiceService;
}

describe('voice socket', () => {
  let server: Server;
  let socketLane: VoiceSocket;
  let url: string;

  beforeEach(async () => {
    server = createServer((_req, res) => res.end('ok'));
    socketLane = createVoiceSocket({
      voice: fakeVoiceService(),
      authenticate: (req) =>
        Promise.resolve(readCookie(req.headers.cookie, 'ethos_auth') === 'good-token'),
    });
    socketLane.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await socketLane.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(headers: Record<string, string> = { cookie: COOKIE }, path = VOICE_SOCKET_PATH) {
    const ws = new WebSocket(`${url}${path}`, { headers });
    const frames: VoiceServerFrame[] = [];
    const payloads: Uint8Array[] = [];
    ws.on('message', (data: Buffer) => {
      const decoded = decodeVoiceServerFrame(new Uint8Array(data));
      if (decoded) {
        frames.push(decoded.header);
        payloads.push(decoded.payload);
      }
    });
    const send = (frame: VoiceClientFrame, payload?: Uint8Array) =>
      ws.send(encodeVoiceFrame(frame, payload));
    return { ws, frames, payloads, send };
  }

  it('refuses an upgrade without the auth cookie', async () => {
    const { ws } = open({});
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(401);
    expect(socketLane.laneCount).toBe(0);
  });

  it('refuses an upgrade on a non-voice path', async () => {
    const { ws } = open({ cookie: COOKIE }, '/not-voice');
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(404);
  });

  it('refuses an upgrade from a foreign Origin', async () => {
    const { ws } = open({ cookie: COOKIE, origin: 'https://evil.example' });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(403);
  });

  it('carries an utterance up and synthesized audio down as binary frames', async () => {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));

    client.send({ t: 'hello', sessionId: 'cli:test' });
    client.send({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 });
    client.send(
      { t: 'audio', utteranceId: 'u1', seq: 0 },
      pcm16ToBytes(Int16Array.from([1, 2, 3])),
    );
    client.send({ t: 'utterance_end', utteranceId: 'u1' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'transcript')).toBe(true));

    client.send({ t: 'synthesize', utteranceId: 'u1', segmentId: 's0', text: 'Hello back.' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'segment_end')).toBe(true));

    expect(client.frames[0]).toMatchObject({ t: 'ready', protocolVersion: 1 });
    expect(client.frames.find((f) => f.t === 'transcript')).toMatchObject({
      utteranceId: 'u1',
      text: 'over the wire',
    });
    const audioIndex = client.frames.findIndex((f) => f.t === 'audio');
    expect(Array.from(client.payloads[audioIndex] ?? [])).toEqual([7, 8, 9]);
    expect(socketLane.laneCount).toBe(1);
    client.ws.close();
  });

  it('ignores a malformed frame with an error rather than dropping the call', async () => {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    client.ws.send(Buffer.from([1, 2, 3, 4]));
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('releases the lane when the client goes away mid-utterance', async () => {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    client.send({ t: 'utterance_start', utteranceId: 'u1', sampleRate: 16_000 });
    client.send({ t: 'audio', utteranceId: 'u1', seq: 0 }, pcm16ToBytes(Int16Array.from([5])));
    await vi.waitFor(() => expect(socketLane.laneCount).toBe(1));

    client.ws.terminate();
    // The half-captured utterance dies with the lane — no server-side state
    // survives to be resumed, which is exactly the defined WS-drop behavior.
    await vi.waitFor(() => expect(socketLane.laneCount).toBe(0));
  });
});

describe('voice socket upgrade helpers', () => {
  it('allows loopback and configured origins, refuses everything else', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('http://127.0.0.1:3000')).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('https://ethos.example', ['https://ethos.example'])).toBe(true);
    expect(originAllowed('not a url')).toBe(false);
  });

  it('reads one cookie out of a header without matching a prefix', () => {
    expect(readCookie('a=1; ethos_auth=tok; b=2', 'ethos_auth')).toBe('tok');
    expect(readCookie('not_ethos_auth=tok', 'ethos_auth')).toBeNull();
    expect(readCookie(undefined, 'ethos_auth')).toBeNull();
  });
});
