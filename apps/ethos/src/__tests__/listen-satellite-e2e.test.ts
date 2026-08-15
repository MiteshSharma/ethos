// `ethos listen` against the REAL satellite lane, over a REAL socket.
//
// THE GAP THIS SUITE EXISTS TO CLOSE. Both halves of the wake lane were already
// well covered and both were covered against FIXTURES: `node-client.test.ts`
// drives the client and decodes what it sent; `apps/web-api/.../satellite-socket
// .test.ts` stands up the server and feeds it frames a test wrote by hand. Ten
// thousand tests, and not one of them ever let a frame the CLIENT constructed
// reach the code that actually RECEIVES it. A field the client omitted and the
// server required could therefore be green on both sides and dead in a kitchen —
// which is exactly what happened: an open-mic node's every `wake` was refused
// with `bad_frame`, every utterance behind it with `no_wake`, and no test
// noticed because no test wired the two ends together.
//
// So this file wires them together and nothing else. The client is the real
// `createSatelliteClient` inside the real `startListenDaemon`, on the real `ws`
// transport. The server is the real `createSatelliteSocket` and the real
// `SatelliteLane`, on a real `http.Server` on an ephemeral port. Only the four
// things that would make a test need the outside world — STT, TTS, the agent
// loop, and the personality registry — are stubbed, and each of them is behind
// the lane's own injected seam.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ethosDir } from '@ethosagent/config';
import { satelliteLaneKey } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentEvent } from '@ethosagent/types';
import type { CaptureDevice, SatelliteSocketFactory, WakeFrame } from '@ethosagent/voice-satellite';
import { createWsSatelliteSocket } from '@ethosagent/voice-satellite';
import type { WakeRoutingTable } from '@ethosagent/web-api';
import {
  createSatelliteSocket,
  type SatelliteLaneDeps,
  SatelliteRegistry,
  type SatelliteSocket,
} from '@ethosagent/web-api';
import {
  decodeSatelliteClientFrame,
  SATELLITE_SOCKET_PATH,
  type SatelliteClientFrame,
} from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ListenPreflight, startListenDaemon } from '../commands/listen';

const NODE_ID = 'kitchen-pi-e2e';

function routingTable(): WakeRoutingTable {
  return {
    routes: [
      {
        id: 'auto:engineer',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: true,
      },
    ],
    nodes: {},
    settings: {
      engine: 'fallback',
      sensitivity: 0.5,
      confirmationFrames: 1,
      edgeStt: false,
      idleTimeoutMs: 30_000,
      wakeEnabled: true,
    },
  };
}

/** 20 ms at the daemon's declared rate — the frame size the pipe device emits. */
const FRAME_SAMPLES = 320;

/** Above `EnergyVad`'s RMS floor: the pipe is carrying something. */
function loudFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES).fill(8000), sampleRate: 16_000 };
}

function quietFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES), sampleRate: 16_000 };
}

describe('ethos listen ↔ the real satellite lane', () => {
  let server: Server;
  let socket: SatelliteSocket;
  /** Every line the daemon narrated, including the server errors it echoes. */
  let lines: string[];
  /** What the fake agent loop was asked to run, and on which lane key. */
  let turns: Array<{ text: string; sessionKey: string; personalityId: string }>;
  /** Audit rows the lane wrote. */
  let observed: Array<{ code: string; details: Record<string, unknown> }>;
  /** What STT returns for the next utterance. */
  let transcript: string;
  /** How many utterances actually reached the recognizer. */
  let transcribeCalls: number;
  let table: WakeRoutingTable;
  let stopDaemon: (() => void) | null;
  /** Push one captured frame into the daemon's capture device. */
  let capture: (frame: WakeFrame) => void;
  /**
   * Every frame the client actually put on the wire, decoded from the bytes.
   *
   * Tapped at the transport seam rather than reconstructed from what the test
   * thinks the client should have sent — the point of this file is that the two
   * are not the same thing.
   */
  let sent: SatelliteClientFrame[];

  const signalsBefore = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  };

  function deps(): SatelliteLaneDeps {
    return {
      transcribe: () => {
        transcribeCalls += 1;
        return Promise.resolve({ text: transcript, provider: 'fake-stt' });
      },
      // Unreachable, and asserted so by throwing: this host registers
      // `playback: false`, and the lane must not spend a TTS call on audio it
      // has nowhere to send.
      synthesize: () => {
        throw new Error('synthesize must not run for a playback:false node');
      },
      resolvePersonality: () => Promise.resolve({ exists: true, privileged: false }),
      runTurn: ({ text, sessionKey, personalityId }): AsyncIterable<AgentEvent> => {
        turns.push({ text, sessionKey, personalityId });
        return (async function* () {
          yield { type: 'text_delta' as const, text: 'Nothing is on fire.' };
          yield { type: 'done' as const, text: 'Nothing is on fire.', turnCount: 1 };
        })();
      },
      voiceMode: () => Promise.resolve('mirror_inbound'),
      laneKey: (nodeId, personalityId) => satelliteLaneKey('web', nodeId, personalityId),
      observe: (code, details) => observed.push({ code, details }),
    };
  }

  beforeEach(async () => {
    lines = [];
    turns = [];
    observed = [];
    transcribeCalls = 0;
    transcript = 'hey engineer is anything on fire';
    table = routingTable();
    stopDaemon = null;
    sent = [];

    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });

    const registry = new SatelliteRegistry({ readTable: () => Promise.resolve(table) });
    server = createServer((_req, res) => res.end('ok'));
    socket = createSatelliteSocket({
      registry,
      deps,
      // The upgrade policy is exercised by the web-api suite; here the point is
      // the frames, so the credential check is a constant.
      authenticate: () => Promise.resolve(true),
    });
    socket.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    let sink: ((frame: WakeFrame) => void) | null = null;
    const device: CaptureDevice = {
      start: async (onFrame) => {
        sink = onFrame;
      },
      stop: async () => {},
      list: async () => [{ id: 'stdin', label: 'stdin' }],
    };
    capture = (frame) => sink?.(frame);

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());

    const pre: ListenPreflight = {
      probes: [],
      configuredEngine: 'transcript',
      transcriptEngineOk: true,
      modelsRequired: false,
      url: `ws://127.0.0.1:${port}${SATELLITE_SOCKET_PATH}`,
      healthUrl: `http://127.0.0.1:${port}/healthz`,
      nodeId: NODE_ID,
      routes: [],
      edgeStt: { requested: false, enabled: false, detail: 'voice.wake.edgeStt is off' },
      player: { player: null, detail: 'none of ffplay, aplay or play is on PATH' },
      device: { id: 'stdin', label: 'stdin', isDefault: true },
      sampleRate: 16_000,
      errors: [],
      deprecations: [],
    };

    let markReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    // The production transport with a tap on it: the real `ws` socket does the
    // moving, and every outbound frame is decoded on its way past.
    const spy: SatelliteSocketFactory = (u, init, handlers) => {
      const inner = createWsSatelliteSocket(u, init, handlers);
      return {
        send: (data) => {
          const decoded = decodeSatelliteClientFrame(data);
          if (decoded.ok) sent.push(decoded.header);
          inner.send(data);
        },
        close: () => inner.close(),
      };
    };
    void startListenDaemon(
      pre,
      { json: false, positional: [] },
      {
        storage,
        device,
        // THE PRODUCTION TRANSPORT, wrapped. Injected only to skip the
        // auth-cookie lookup (which would pull in the whole web-api boot graph)
        // and to tap the bytes; they are the bytes a real satellite sends.
        createSocket: spy,
        onReady: () => markReady?.(),
        exit: () => {},
      },
    );
    await ready;
    stopDaemon = () => {
      for (const name of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(name)) {
          if (!signalsBefore[name].includes(listener)) {
            (listener as NodeJS.SignalsListener)(name);
          }
        }
      }
    };
  });

  afterEach(async () => {
    stopDaemon?.();
    await socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(name)) {
        if (!signalsBefore[name].includes(listener)) process.removeListener(name, listener);
      }
    }
    vi.restoreAllMocks();
  });

  /** Speak for ~800 ms, then go quiet long enough for the endpointer to fire. */
  function saySomething(): void {
    for (let i = 0; i < 40; i++) capture(loudFrame());
    for (let i = 0; i < 30; i++) capture(quietFrame());
  }

  /** A chair scrape: loud enough to trip the VAD, far under the 400 ms floor. */
  function blip(): void {
    capture(loudFrame());
    capture(loudFrame());
    for (let i = 0; i < 30; i++) capture(quietFrame());
  }

  it('an open-mic node wakes, streams, and reaches the transcript gate with no refusals', async () => {
    saySomething();
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000 });

    const out = lines.join('\n');
    // The two refusals the real session drowned in. Asserted on the DAEMON's
    // own output, because that is where an operator would have seen them: the
    // client echoes every server `error` frame through `onError`.
    expect(out).not.toContain('bad_frame');
    expect(out).not.toContain('no_wake');
    expect(out).not.toContain('satellite server error');

    // The turn it should have produced.
    expect(transcribeCalls).toBe(1);
    expect(turns[0]?.personalityId).toBe('engineer');
    expect(turns[0]?.sessionKey).toContain(NODE_ID);
    await vi.waitFor(() => expect(lines.join('\n')).toContain('Nothing is on fire.'));
    // `playback_done` is the last frame of the cycle — the node's re-arm
    // receipt, sent on `turn_end`. Waiting for it is what makes the sequence
    // below a complete turn rather than a snapshot of one in flight.
    await vi.waitFor(() => expect(sent.some((f) => f.t === 'playback_done')).toBe(true));

    // The frames the client ACTUALLY constructed, in order — the shape the
    // server decodes. An open-mic node names no phrase and no personality, and
    // this is the assertion that would have failed against the contract that
    // required them.
    expect(sent.find((f) => f.t === 'wake')).toEqual({
      t: 'wake',
      wakeId: expect.any(String),
      confidence: 1,
    });
    // `state` and `audio` filtered out: one is a heartbeat of the capture
    // machine's transitions and the other is however many 20 ms frames the
    // utterance happened to contain — neither is the lifecycle this pins.
    expect(sent.map((f) => f.t).filter((t) => t !== 'state' && t !== 'audio')).toEqual([
      'register',
      'wake',
      'utterance_start',
      'utterance_end',
      'playback_done',
    ]);
  });

  it('says nothing upstream for a chair scrape — no wake, no utterance, no turn', async () => {
    // The wake is HELD until the utterance qualifies, so a blip costs the
    // server nothing at all: no `wake`, no `utterance_start`, and therefore no
    // half-open utterance for a `turn_end` that will never come.
    blip();
    blip();
    await vi.waitFor(() =>
      expect(lines.join('\n').split('discarded utterance').length - 1).toBe(2),
    );
    // Give anything that WOULD have gone upstream time to arrive and be refused.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing but the registration and the state frames that keep the mic
    // indicator honest. Two chair scrapes, zero wakes.
    expect(sent.filter((f) => f.t === 'wake')).toHaveLength(0);
    expect(sent.filter((f) => f.t === 'utterance_start')).toHaveLength(0);
    expect(sent.filter((f) => f.t === 'audio')).toHaveLength(0);
    expect(transcribeCalls).toBe(0);
    expect(turns).toHaveLength(0);
    expect(observed).toHaveLength(0);
    expect(lines.join('\n')).not.toContain('satellite server error');
    // The operator still sees the microphone working — the `●` is a terminal
    // event, and holding the wake must not make a noisy room look like a dead
    // pipe.
    expect(lines.join('\n').split('● speech').length - 1).toBe(2);
  });

  it('a blip does not poison the real utterance behind it', async () => {
    blip();
    saySomething();
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000 });
    expect(lines.join('\n')).not.toContain('satellite server error');
    expect(turns[0]?.personalityId).toBe('engineer');
  });

  it('an unaddressed utterance is heard, transcribed, and answered by nobody', async () => {
    transcript = 'pass the salt please';
    saySomething();
    await vi.waitFor(() =>
      expect(observed.some((row) => row.code === 'satellite.no_match')).toBe(true),
    );
    expect(turns).toHaveLength(0);
    expect(lines.join('\n')).toContain('not addressed to anyone');
    expect(lines.join('\n')).not.toContain('satellite server error');
  });
});
