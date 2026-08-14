import {
  decodeSatelliteClientFrame,
  encodeSatelliteFrame,
  pcm16FromBytes,
  SATELLITE_SOCKET_VERSION,
  type SatelliteClientFrame,
  type SatelliteServerFrame,
} from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSatelliteClient,
  type SatelliteClientOptions,
  type SatellitePlayoutEvent,
  type SatelliteSocketHandlers,
} from '../node-client';

class FakeSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly init: { headers?: Record<string, string> },
    readonly handlers: SatelliteSocketHandlers,
  ) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Decoded client frames, in send order. */
  frames(): SatelliteClientFrame[] {
    const out: SatelliteClientFrame[] = [];
    for (const bytes of this.sent) {
      const decoded = decodeSatelliteClientFrame(bytes);
      if (decoded !== null) out.push(decoded.header);
    }
    return out;
  }

  payloads(): Uint8Array[] {
    return this.sent.map((b) => decodeSatelliteClientFrame(b)?.payload ?? new Uint8Array(0));
  }

  deliver(header: SatelliteServerFrame, payload?: Uint8Array): void {
    this.handlers.onMessage(encodeSatelliteFrame(header, payload), true);
  }
}

interface Setup {
  sockets: FakeSocket[];
  errors: string[];
  routes: Array<Extract<SatelliteServerFrame, { t: 'routes' }>>;
  playout: SatellitePlayoutEvent[];
  wakeEnabled: boolean[];
  client: ReturnType<typeof createSatelliteClient>;
  latest(): FakeSocket;
}

function setup(over: Partial<SatelliteClientOptions> = {}): Setup {
  const sockets: FakeSocket[] = [];
  const errors: string[] = [];
  const routes: Array<Extract<SatelliteServerFrame, { t: 'routes' }>> = [];
  const playout: SatellitePlayoutEvent[] = [];
  const wakeEnabled: boolean[] = [];

  const client = createSatelliteClient({
    url: 'ws://gateway.local/satellite/ws',
    nodeId: 'kitchen-pi',
    displayName: 'Kitchen Pi',
    capabilities: { edgeStt: false, playback: true, captureSampleRate: 16000 },
    wakeEnabled: true,
    createSocket: (url, init, handlers) => {
      const socket = new FakeSocket(url, init, handlers);
      sockets.push(socket);
      return socket;
    },
    onRoutes: (frame) => routes.push(frame),
    onSpeak: (event) => playout.push(event),
    onSetWakeEnabled: (enabled) => wakeEnabled.push(enabled),
    onError: (message) => errors.push(message),
    ...over,
  });

  return {
    sockets,
    errors,
    routes,
    playout,
    wakeEnabled,
    client,
    latest: () => {
      const last = sockets[sockets.length - 1];
      if (last === undefined) throw new Error('no socket was created');
      return last;
    },
  };
}

const ROUTES_FRAME: Extract<SatelliteServerFrame, { t: 'routes' }> = {
  t: 'routes',
  routes: [
    {
      id: 'r-eng',
      phrase: 'hey engineer',
      personalityId: 'engineer',
      privileged: false,
      enabled: true,
    },
  ],
  settings: {
    engine: 'transcript',
    sensitivity: 0.5,
    confirmationFrames: 2,
    edgeStt: false,
    idleTimeoutMs: 300000,
    inputDevice: undefined,
    wakeEnabled: true,
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('satellite client — connection', () => {
  it('registers on open with the stable node id', () => {
    const s = setup();
    s.client.connect();
    s.latest().handlers.onOpen();

    expect(s.client.isOpen()).toBe(true);
    const register = s.latest().frames()[0];
    expect(register).toMatchObject({
      t: 'register',
      nodeId: 'kitchen-pi',
      displayName: 'Kitchen Pi',
      protocolVersion: SATELLITE_SOCKET_VERSION,
      wakeEnabled: true,
    });
  });

  it('sends the auth cookie as a header when one is configured', () => {
    const s = setup({ authCookie: 'ethos_session=abc' });
    s.client.connect();
    expect(s.latest().init.headers).toEqual({ Cookie: 'ethos_session=abc' });
  });

  it('applies the pushed routing table', () => {
    const s = setup();
    s.client.connect();
    s.latest().handlers.onOpen();
    s.latest().deliver(ROUTES_FRAME);

    expect(s.routes).toHaveLength(1);
    expect(s.routes[0]?.routes[0]?.personalityId).toBe('engineer');
    expect(s.routes[0]?.settings.idleTimeoutMs).toBe(300000);
  });

  it('re-registers on reconnect and takes a fresh routing table', () => {
    const s = setup({ reconnectBaseMs: 100, reconnectMaxMs: 1000 });
    s.client.connect();
    s.latest().handlers.onOpen();
    s.latest().deliver(ROUTES_FRAME);
    expect(s.routes).toHaveLength(1);

    s.latest().handlers.onClose();
    expect(s.client.isOpen()).toBe(false);
    vi.advanceTimersByTime(2000);

    expect(s.sockets).toHaveLength(2);
    s.latest().handlers.onOpen();
    expect(s.latest().frames()[0]).toMatchObject({ t: 'register', nodeId: 'kitchen-pi' });

    s.latest().deliver(ROUTES_FRAME);
    expect(s.routes).toHaveLength(2);
  });

  it('backs off across repeated failures and stops when closed', () => {
    const s = setup({ reconnectBaseMs: 100, reconnectMaxMs: 1000 });
    s.client.connect();
    for (let i = 0; i < 3; i++) {
      s.latest().handlers.onClose();
      vi.advanceTimersByTime(5000);
    }
    expect(s.sockets.length).toBeGreaterThan(3);

    const count = s.sockets.length;
    s.client.close();
    vi.advanceTimersByTime(60_000);
    expect(s.sockets).toHaveLength(count);
  });

  it('ignores callbacks from a socket that has already been replaced', () => {
    const s = setup({ reconnectBaseMs: 100 });
    s.client.connect();
    const first = s.latest();
    first.handlers.onClose();
    vi.advanceTimersByTime(1000);
    expect(s.sockets).toHaveLength(2);

    first.handlers.onOpen();
    expect(s.client.isOpen()).toBe(false);
    expect(first.frames()).toHaveLength(0);
  });
});

describe('satellite client — untrusted input', () => {
  it('drops a malformed server frame instead of throwing', () => {
    const s = setup();
    s.client.connect();
    s.latest().handlers.onOpen();

    expect(() => s.latest().handlers.onMessage(new Uint8Array([9, 9, 9]), true)).not.toThrow();
    // Truncated: the length prefix promises more header than arrived.
    const truncated = encodeSatelliteFrame(ROUTES_FRAME).slice(0, 6);
    expect(() => s.latest().handlers.onMessage(truncated, true)).not.toThrow();
    // Well-framed, valid JSON, but not a member of the server union.
    const body = new TextEncoder().encode(JSON.stringify({ t: 'not_a_frame' }));
    const framed = new Uint8Array(3 + body.length);
    framed[0] = SATELLITE_SOCKET_VERSION;
    framed[1] = (body.length >> 8) & 0xff;
    framed[2] = body.length & 0xff;
    framed.set(body, 3);
    expect(() => s.latest().handlers.onMessage(framed, true)).not.toThrow();
    // A text frame — this lane has none.
    expect(() => s.latest().handlers.onMessage('{"t":"routes"}', false)).not.toThrow();

    expect(s.routes).toHaveLength(0);
  });

  it('never lets a throwing host callback escape the socket', () => {
    const s = setup({
      onRoutes: () => {
        throw new Error('host blew up');
      },
    });
    s.client.connect();
    s.latest().handlers.onOpen();
    expect(() => s.latest().deliver(ROUTES_FRAME)).not.toThrow();
    expect(s.errors.join('\n')).toMatch(/onRoutes handler threw: host blew up/);
  });

  it('surfaces a server error frame through onError', () => {
    const s = setup();
    s.client.connect();
    s.latest().handlers.onOpen();
    s.latest().deliver({ t: 'error', code: 'unknown_personality', message: 'no such id' });
    expect(s.errors.join('\n')).toMatch(/unknown_personality/);
  });
});

describe('satellite client — playout and control', () => {
  it('flattens the reply stream into playout events', () => {
    const s = setup();
    s.client.connect();
    s.latest().handlers.onOpen();

    s.latest().deliver({
      t: 'speak_start',
      utteranceId: 'u1',
      segmentId: 's1',
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
      sampleRate: 24000,
    });
    s.latest().deliver(
      { t: 'audio', utteranceId: 'u1', segmentId: 's1', seq: 0 },
      new Uint8Array([1, 2, 3, 4]),
    );
    s.latest().deliver({ t: 'segment_end', utteranceId: 'u1', segmentId: 's1' });
    s.latest().deliver({ t: 'turn_end', utteranceId: 'u1', personalityId: 'engineer' });

    expect(s.playout.map((e) => e.type)).toEqual([
      'speak_start',
      'audio',
      'segment_end',
      'turn_end',
    ]);
    const audio = s.playout[1];
    expect(audio?.type === 'audio' && Array.from(audio.payload)).toEqual([1, 2, 3, 4]);
  });

  it('forwards set_wake_enabled', () => {
    const s = setup();
    s.client.connect();
    s.latest().handlers.onOpen();
    s.latest().deliver({ t: 'set_wake_enabled', enabled: false });
    expect(s.wakeEnabled).toEqual([false]);
  });

  it('reports rather than throws when a frame is sent on a closed socket', () => {
    const s = setup();
    s.client.connect();
    s.client.sendState('listening');
    expect(s.errors.join('\n')).toMatch(/dropped state frame/);
  });
});

describe('satellite client — utterance uplink', () => {
  function opened() {
    const s = setup();
    s.client.connect();
    s.latest().handlers.onOpen();
    s.latest().sent.length = 0; // drop the register frame
    return s;
  }

  it('sends audio frames with monotonic seq and refuses a regression', () => {
    const s = opened();
    s.client.sendUtteranceStart({ wakeId: 'w1', utteranceId: 'u1', sampleRate: 16000 });
    s.client.sendAudio('u1', 0, Int16Array.from([1, -1]));
    s.client.sendAudio('u1', 1, Int16Array.from([2, -2]));
    s.client.sendAudio('u1', 1, Int16Array.from([3, -3]));
    s.client.sendAudio('u1', 2, Int16Array.from([4, -4]));
    s.client.sendUtteranceEnd('u1');

    const frames = s.latest().frames();
    expect(frames.map((f) => f.t)).toEqual([
      'utterance_start',
      'audio',
      'audio',
      'audio',
      'utterance_end',
    ]);
    const seqs = frames.flatMap((f) => (f.t === 'audio' ? [f.seq] : []));
    expect(seqs).toEqual([0, 1, 2]);
    expect(s.errors.join('\n')).toMatch(/refused audio seq 1/);

    const payloads = s.latest().payloads();
    expect(Array.from(pcm16FromBytes(payloads[1] ?? new Uint8Array(0)))).toEqual([1, -1]);
  });

  it('restarts the seq window for a new utterance', () => {
    const s = opened();
    s.client.sendUtteranceStart({ wakeId: 'w1', utteranceId: 'u1', sampleRate: 16000 });
    s.client.sendAudio('u1', 5, Int16Array.from([1]));
    s.client.sendUtteranceEnd('u1');
    s.client.sendUtteranceStart({ wakeId: 'w2', utteranceId: 'u2', sampleRate: 16000 });
    s.client.sendAudio('u2', 0, Int16Array.from([1]));

    expect(s.errors).toEqual([]);
  });

  it('edge mode sends a transcript and no audio at all', () => {
    const s = opened();
    s.client.sendWake({
      wakeId: 'w1',
      phrase: 'hey engineer',
      routeId: 'r-eng',
      personalityId: 'engineer',
      confidence: 0.9,
    });
    s.client.sendUtteranceStart({ wakeId: 'w1', utteranceId: 'u1', sampleRate: 16000 });
    s.client.sendTranscript('u1', 'did CI pass');

    const frames = s.latest().frames();
    expect(frames.map((f) => f.t)).toEqual(['wake', 'utterance_start', 'transcript']);
    expect(frames.some((f) => f.t === 'audio')).toBe(false);
  });

  it('refuses to stream audio for an utterance that already sent a transcript', () => {
    const s = opened();
    s.client.sendUtteranceStart({ wakeId: 'w1', utteranceId: 'u1', sampleRate: 16000 });
    s.client.sendTranscript('u1', 'did CI pass');
    s.client.sendAudio('u1', 0, Int16Array.from([1, 2]));

    expect(
      s
        .latest()
        .frames()
        .some((f) => f.t === 'audio'),
    ).toBe(false);
    expect(s.errors.join('\n')).toMatch(/no audio leaves the machine/);
  });

  it('sends state, doctor, and playback-done frames', () => {
    const s = opened();
    s.client.sendState('degraded', 'model file missing');
    s.client.sendDoctor([{ name: 'engine:sherpa', ok: false, detail: 'not installed' }]);
    s.client.sendPlaybackDone('u1');

    expect(s.latest().frames()).toEqual([
      { t: 'state', state: 'degraded', detail: 'model file missing' },
      { t: 'doctor', probes: [{ name: 'engine:sherpa', ok: false, detail: 'not installed' }] },
      { t: 'playback_done', utteranceId: 'u1' },
    ]);
  });
});
