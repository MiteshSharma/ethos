import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AgentLoop, DefaultToolRegistry, InMemorySessionStore } from '@ethosagent/core';
import { AGENT_CONSULT_TOOL, createAgentConsultTool } from '@ethosagent/tools-voice';
import type { AgentEvent, PcmChunk } from '@ethosagent/types';
import type { VoiceSession, VoiceSessionEvent } from '@ethosagent/voice-session';
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
import { createRealtimeControlDeps } from '../realtime-control-deps';
import { RealtimeControlLane } from '../realtime-control-lane';
import type { VoiceLaneSessionOpener } from '../voice-lane';
import { createVoiceSocket, originAllowed, readCookie, type VoiceSocket } from '../voice-socket';

// The socket half: upgrade policy (path, Origin, credentials) and the round
// trip over a REAL `ws` connection. The frame TRANSLATION itself is tested
// against `VoiceLane` directly in voice-lane.test.ts; this file proves that a
// `hello`/`audio` frame off the wire reaches a lane's `openSession` opener and
// that a `VoiceSession` event comes back as the wire frame the browser
// decodes.

const COOKIE = 'ethos_auth=good-token';

/** A `VoiceSession` stand-in this file drives from outside. */
class FakeVoiceSession {
  readonly pushed: PcmChunk[] = [];
  stopCalls = 0;
  private listeners: Array<(event: VoiceSessionEvent) => void> = [];

  pushAudio(chunk: PcmChunk): void {
    this.pushed.push(chunk);
  }

  stop(): void {
    this.stopCalls += 1;
  }

  on(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: VoiceSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/**
 * One connected client, frames decoded through the REAL codec both ways.
 *
 * Module-level so the realtime describe below drives the same wire the pipeline
 * one does — a realtime frame that only ever travelled a hand-built object
 * would prove nothing about the socket.
 */
function openClient(url: string, headers: Record<string, string>, path: string) {
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

describe('voice socket', () => {
  let server: Server;
  let socketLane: VoiceSocket;
  let url: string;
  let session: FakeVoiceSession;
  let opener: VoiceLaneSessionOpener;

  beforeEach(async () => {
    session = new FakeVoiceSession();
    opener = vi.fn(() =>
      Promise.resolve({
        session: session as unknown as VoiceSession,
        laneKey: 'voice:web:browser:test',
      }),
    );
    server = createServer((_req, res) => res.end('ok'));
    socketLane = createVoiceSocket({
      session: () => opener,
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
    return openClient(url, headers, path);
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

  it('opens a session on hello and carries its events down as binary frames', async () => {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));

    client.send({ t: 'hello', sessionId: 'cli:test', sampleRate: 16_000 });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'ready')).toBe(true));

    client.send({ t: 'audio', seq: 0 }, pcm16ToBytes(Int16Array.from([1, 2, 3])));
    await vi.waitFor(() => expect(session.pushed).toHaveLength(1));
    expect(session.pushed[0]).toEqual({ data: Int16Array.from([1, 2, 3]), sampleRate: 16_000 });

    session.emit({ type: 'utterance_committed', text: 'over the wire' });
    session.emit({ type: 'reply_sentence', text: 'Hello back.', segmentId: 'seg1' });
    session.emit({
      type: 'reply_audio',
      audio: new Uint8Array([7, 8, 9]),
      format: 'opus',
      segmentId: 'seg1',
    });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'audio')).toBe(true));

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

  it('refuses audio with a clear error when no session opener is wired', async () => {
    const bareServer = createServer((_req, res) => res.end('ok'));
    const noOpener = createVoiceSocket({ authenticate: () => Promise.resolve(true) });
    noOpener.attach(bareServer);
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    const { port } = bareServer.address() as AddressInfo;

    const client = openClient(`ws://127.0.0.1:${port}`, {}, VOICE_SOCKET_PATH);
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));

    client.send({ t: 'hello', sampleRate: 16_000 });
    await vi.waitFor(() =>
      expect(client.frames.some((f) => f.t === 'error' && f.code === 'voice_unavailable')).toBe(
        true,
      ),
    );
    client.ws.close();
    await noOpener.close();
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  it('ignores a malformed frame with an error rather than dropping the call', async () => {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    client.ws.send(Buffer.from([1, 2, 3, 4]));
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('drops realtime frames when no control deps are wired, without opening a lane', async () => {
    // The honest behaviour for a deployment with no agent behind the socket:
    // the pipeline tier still works and nothing pretends to consult. A
    // `realtime_*` frame is neither serviced nor an error — it goes nowhere.
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    client.send({ t: 'realtime_start', canSay: true, sessionId: 'chat-9' });
    client.send({ t: 'realtime_tool_call', callId: 'c1', name: AGENT_CONSULT_TOOL, args: {} });
    // `hello` is the barrier: once its `ready` is back, anything the realtime
    // frames were going to produce would already have been written.
    client.send({ t: 'hello', sessionId: 'cli:test' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'ready')).toBe(true));

    expect(client.frames.map((f) => f.t)).toEqual(['ready']);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('releases the lane when the client goes away mid-call', async () => {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    client.send({ t: 'hello', sampleRate: 16_000 });
    client.send({ t: 'audio', seq: 0 }, pcm16ToBytes(Int16Array.from([5])));
    await vi.waitFor(() => expect(socketLane.laneCount).toBe(1));

    client.ws.terminate();
    await vi.waitFor(() => expect(socketLane.laneCount).toBe(0));
  });
});

// D8 (plan §7): a second browser tab on the SAME conversation is a takeover,
// not a second billed session. Both connections here resolve to the SAME
// lane key — exactly what happens when two tabs open `hello` with the same
// `sessionId` (`browser-voice-session.ts` derives the key from it, ignoring
// which socket asked). Real `ws` connections end to end, same as the suite
// above — a fake socket would prove nothing about the actual close handshake
// the client has to observe.
describe('voice socket — D8 takeover on one lane key', () => {
  let server: Server;
  let socketLane: VoiceSocket;
  let url: string;
  let sessions: FakeVoiceSession[];

  beforeEach(async () => {
    sessions = [];
    const opener: VoiceLaneSessionOpener = () => {
      const s = new FakeVoiceSession();
      sessions.push(s);
      return Promise.resolve({
        session: s as unknown as VoiceSession,
        laneKey: 'voice:web:browser:shared',
      });
    };
    server = createServer((_req, res) => res.end('ok'));
    socketLane = createVoiceSocket({
      session: () => opener,
      authenticate: () => Promise.resolve(true),
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

  async function connect() {
    const client = openClient(url, {}, VOICE_SOCKET_PATH);
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    return client;
  }

  it('closes the first connection (and stops its session) when a second opens the same lane key, and lets the second proceed', async () => {
    const first = await connect();
    first.send({ t: 'hello', sessionId: 'chat-9', sampleRate: 16_000 });
    await vi.waitFor(() => expect(first.frames.some((f) => f.t === 'ready')).toBe(true));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    const second = await connect();
    second.send({ t: 'hello', sessionId: 'chat-9', sampleRate: 16_000 });
    await vi.waitFor(() => expect(sessions).toHaveLength(2));

    // The FIRST connection is told why, its session is stopped, and its
    // socket actually closes.
    await vi.waitFor(() =>
      expect(first.frames.some((f) => f.t === 'error' && f.code === 'taken_over')).toBe(true),
    );
    await vi.waitFor(() => expect(sessions[0]?.stopCalls).toBe(1));
    await vi.waitFor(() => expect(first.ws.readyState).toBe(WebSocket.CLOSED));

    // The SECOND connection proceeds normally — it is the live one now.
    await vi.waitFor(() => expect(second.frames.some((f) => f.t === 'ready')).toBe(true));
    second.send({ t: 'audio', seq: 0 }, pcm16ToBytes(Int16Array.from([1])));
    await vi.waitFor(() => expect(sessions[1]?.pushed).toHaveLength(1));

    second.ws.close();
  });

  it('cascades: a third connection on the same key takes over the second, exactly like the second took over the first', async () => {
    const first = await connect();
    first.send({ t: 'hello', sessionId: 'chat-9', sampleRate: 16_000 });
    await vi.waitFor(() => expect(first.frames.some((f) => f.t === 'ready')).toBe(true));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    const second = await connect();
    const third = await connect();
    // Fire both `hello`s back to back, without waiting for the first
    // connection's close handshake (a real network round trip) to land —
    // the exact window that used to trip the (now-removed) `voice_lane_busy`
    // false refusal. `onLaneKey` installs its holder in `holders`
    // synchronously, so by the time `third`'s `hello` is processed, `second`
    // is already the sole, fully-live holder — `third` taking over `second`
    // is exactly as valid as `second` taking over `first` was.
    second.send({ t: 'hello', sessionId: 'chat-9', sampleRate: 16_000 });
    third.send({ t: 'hello', sessionId: 'chat-9', sampleRate: 16_000 });

    await vi.waitFor(() => expect(sessions).toHaveLength(3));

    // Both FIRST and SECOND are told they were taken over, their sessions
    // stopped, and their sockets actually closed.
    await vi.waitFor(() =>
      expect(first.frames.some((f) => f.t === 'error' && f.code === 'taken_over')).toBe(true),
    );
    await vi.waitFor(() =>
      expect(second.frames.some((f) => f.t === 'error' && f.code === 'taken_over')).toBe(true),
    );
    await vi.waitFor(() => expect(sessions[0]?.stopCalls).toBe(1));
    await vi.waitFor(() => expect(sessions[1]?.stopCalls).toBe(1));
    await vi.waitFor(() => expect(first.ws.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(second.ws.readyState).toBe(WebSocket.CLOSED));

    // THIRD is the one left standing — it is the live holder and it works.
    await vi.waitFor(() => expect(third.frames.some((f) => f.t === 'ready')).toBe(true));
    third.send({ t: 'audio', seq: 0 }, pcm16ToBytes(Int16Array.from([1])));
    await vi.waitFor(() => expect(sessions[2]?.pushed).toHaveLength(1));

    third.ws.close();
  });
});

// The realtime tier, driven over the same real socket and the same real codec.
//
// `realtime-control-lane.test.ts` proves the lane's own behaviour against a
// FAKE tool host; this file proves the seam under it — that a `realtime_*`
// frame off the wire reaches a lane at all, that the lane it reaches is the
// connection's own, and that an `agent_consult` frame comes back as a serviced,
// speakable answer. The chain is real end to end: the Zod codec, the socket's
// dispatch, `createRealtimeControlDeps`, a real `DefaultToolRegistry` holding a
// real `agent_consult`, a real `InMemorySessionStore`. The one stub is the
// AgentLoop the consult runs — nothing short of a live model replaces it.

const CONSULT_ANSWER = '**Ship it.** The migration notes agree.';
/** What the listener actually hears: `sanitizeForSpeech` has been through it. */
const SPOKEN_ANSWER = 'Ship it. The migration notes agree.';

interface ConsultCall {
  prompt: string;
  sessionKey?: string;
}

function fakeConsultLoop(calls: ConsultCall[]): AgentLoop {
  return {
    run: async function* (
      prompt: string,
      opts?: { sessionKey?: string },
    ): AsyncGenerator<AgentEvent> {
      calls.push({ prompt, ...(opts?.sessionKey ? { sessionKey: opts.sessionKey } : {}) });
      yield { type: 'text_delta', text: CONSULT_ANSWER };
      yield { type: 'done', text: CONSULT_ANSWER, turnCount: 1 };
    },
  } as unknown as AgentLoop;
}

describe('voice socket — the realtime control channel', () => {
  let server: Server;
  let socketLane: VoiceSocket;
  let url: string;
  let sessions: InMemorySessionStore;
  let consults: ConsultCall[];
  /** Every lane id the socket asked for control deps with. One per connection. */
  let depsFor: string[];

  beforeEach(async () => {
    sessions = new InMemorySessionStore();
    consults = [];
    depsFor = [];
    const registry = new DefaultToolRegistry();
    registry.register(
      createAgentConsultTool(fakeConsultLoop(consults), {
        voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
      }),
    );
    server = createServer((_req, res) => res.end('ok'));
    socketLane = createVoiceSocket({
      authenticate: (req) =>
        Promise.resolve(readCookie(req.headers.cookie, 'ethos_auth') === 'good-token'),
      realtime: (laneId) => {
        depsFor.push(laneId);
        return createRealtimeControlDeps(
          {
            toolRegistry: registry,
            sessions,
            personalities: { get: () => undefined },
            defaults: { model: 'm', provider: 'p', workingDir: '/tmp' },
          },
          laneId,
        );
      },
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

  async function connect() {
    const client = openClient(url, { cookie: COOKIE }, VOICE_SOCKET_PATH);
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    return client;
  }

  it('opens one control lane per connection, however many times the browser starts', async () => {
    const client = await connect();
    client.send({ t: 'realtime_start', canSay: true, sessionId: 'chat-9' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'realtime_ready')).toBe(true));

    // A reconnecting page re-sends `realtime_start`. It must not mint a second
    // conversation on a socket that already has one.
    client.send({ t: 'realtime_start', canSay: true, sessionId: 'chat-9' });
    client.send({ t: 'hello', sessionId: 'cli:test' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'ready')).toBe(true));

    expect(client.frames.filter((f) => f.t === 'realtime_ready')).toEqual([
      { t: 'realtime_ready', laneKey: 'voice:web:browser:chat-9', tools: [AGENT_CONSULT_TOOL] },
    ]);
    expect(depsFor).toHaveLength(1);
    client.ws.close();
  });

  it('services an agent_consult call end to end: frame in, spoken answer out', async () => {
    const client = await connect();
    client.send({ t: 'realtime_start', canSay: true, sessionId: 'chat-9' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'realtime_ready')).toBe(true));

    client.send({
      t: 'realtime_tool_call',
      callId: 'call-1',
      name: AGENT_CONSULT_TOOL,
      args: { prompt: 'What did we decide about the migration?' },
    });
    await vi.waitFor(() =>
      expect(client.frames.some((f) => f.t === 'realtime_tool_result')).toBe(true),
    );

    // The consult ran on the TALK session's lane key, not the typed chat's.
    expect(consults).toEqual([
      {
        prompt: 'What did we decide about the migration?',
        sessionKey: 'voice:web:browser:chat-9',
      },
    ]);
    // "Checking." is dispatched BEFORE the turn, not after it turns out slow.
    const ackAt = client.frames.findIndex((f) => f.t === 'realtime_speak');
    const resultAt = client.frames.findIndex((f) => f.t === 'realtime_tool_result');
    expect(ackAt).toBeGreaterThanOrEqual(0);
    expect(ackAt).toBeLessThan(resultAt);
    expect(client.frames[ackAt]).toMatchObject({ kind: 'ack' });
    // And the answer went back sanitized — the markdown never reaches a speaker.
    expect(client.frames[resultAt]).toEqual({
      t: 'realtime_tool_result',
      callId: 'call-1',
      ok: true,
      output: SPOKEN_ANSWER,
    });
    client.ws.close();
  });

  it('drops a realtime frame that arrives after the call ended, without answering it', async () => {
    const client = await connect();
    client.send({ t: 'realtime_start', canSay: true, sessionId: 'chat-9' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'realtime_ready')).toBe(true));
    client.send({ t: 'realtime_end' });
    client.send({
      t: 'realtime_tool_call',
      callId: 'call-late',
      name: AGENT_CONSULT_TOOL,
      args: { prompt: 'anyone there?' },
    });
    client.send({ t: 'hello', sessionId: 'cli:test' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'ready')).toBe(true));

    expect(client.frames.some((f) => f.t === 'realtime_tool_result')).toBe(false);
    expect(consults).toEqual([]);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('tears the control lane down exactly once when the socket closes', async () => {
    const closed = vi.spyOn(RealtimeControlLane.prototype, 'close');
    try {
      const client = await connect();
      client.send({ t: 'realtime_start', canSay: true, sessionId: 'chat-9' });
      await vi.waitFor(() =>
        expect(client.frames.some((f) => f.t === 'realtime_ready')).toBe(true),
      );

      client.ws.close();
      await vi.waitFor(() => expect(socketLane.laneCount).toBe(0));
      expect(closed).toHaveBeenCalledTimes(1);

      // The server shutting down must not close it a second time — the socket's
      // teardown is what removes it from the map, and forgetting that is how a
      // lane gets closed twice.
      await socketLane.close();
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      closed.mockRestore();
    }
  });

  it('persists a realtime transcript to the talk session, on the lane key', async () => {
    const client = await connect();
    client.send({ t: 'realtime_start', canSay: true, sessionId: 'chat-9' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'realtime_ready')).toBe(true));

    client.send({ t: 'realtime_transcript', role: 'user', text: 'spoken question' });
    client.send({ t: 'realtime_transcript', role: 'assistant', text: 'spoken answer' });

    const row = await vi.waitFor(async () => {
      const found = await sessions.getSessionByKey('voice:web:browser:chat-9');
      expect(found).toBeTruthy();
      const messages = await sessions.getMessages(found?.id ?? '');
      expect(messages).toHaveLength(2);
      return found;
    });

    const messages = await sessions.getMessages(row?.id ?? '');
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'spoken question'],
      ['assistant', 'spoken answer'],
    ]);
    client.ws.close();
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
