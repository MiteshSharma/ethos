// `voice.bargeIn.satellite` → the satellite's own VAD.
//
// The block parsed, validated and round-tripped through the web Settings page
// and was read by NOTHING: an operator could raise a noisy room's energy floor
// and change no behaviour at all. `ethos listen` is the satellite surface's one
// production construction site, so this drives the REAL daemon with a fake
// socket and a fake microphone and asserts on the frames the client actually
// put on the wire. A daemon that ignored the tuning would still wake here.

import { ethosDir } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CaptureDevice,
  SatelliteSocketFactory,
  SatelliteSocketHandlers,
  WakeFrame,
} from '@ethosagent/voice-satellite';
import {
  decodeSatelliteClientFrame,
  encodeSatelliteFrame,
  type SatelliteClientFrame,
} from '@ethosagent/web-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ListenPreflight,
  readSatelliteVadTuning,
  startListenDaemon,
} from '../commands/listen';

/** 20 ms at the daemon's declared rate — the frame size the pipe device emits. */
const FRAME_SAMPLES = 320;

/** RMS 0.244: comfortably over `EnergyVad`'s 0.02 default, under a 0.9 floor. */
function loudFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES).fill(8000), sampleRate: 16_000 };
}

function quietFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES), sampleRate: 16_000 };
}

/** The `routes` frame the daemon waits for before it builds anything. */
function routesFrame(): Uint8Array {
  return encodeSatelliteFrame({
    t: 'routes',
    routes: [
      {
        id: 'auto:engineer',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
      },
    ],
    settings: {
      engine: 'fallback',
      sensitivity: 0.5,
      confirmationFrames: 1,
      edgeStt: false,
      idleTimeoutMs: 30_000,
      wakeEnabled: true,
    },
  });
}

interface Daemon {
  /** Push one captured frame into the daemon's microphone. */
  capture(frame: WakeFrame): void;
  /** Every frame the client put on the wire, decoded from the bytes. */
  sent: SatelliteClientFrame[];
  stop(): void;
}

const signalsBefore = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM'),
};

/** Boot the real daemon on a fake socket and a fake microphone. */
async function bootDaemon(vadTuning: ListenPreflight['vadTuning']): Promise<Daemon> {
  const sent: SatelliteClientFrame[] = [];
  // Collected rather than assigned to `let`s: both hand-offs happen inside
  // callbacks control-flow analysis cannot see, so a nullable local would still
  // read as `null` where the test needs to call it.
  const sinks: Array<(frame: WakeFrame) => void> = [];
  const device: CaptureDevice = {
    start: async (onFrame) => {
      sinks.push(onFrame);
    },
    stop: async () => {},
    list: async () => [{ id: 'stdin', label: 'stdin' }],
  };

  const sockets: SatelliteSocketHandlers[] = [];
  const createSocket: SatelliteSocketFactory = (_url, _init, handlers) => {
    sockets.push(handlers);
    return {
      send: (data) => {
        const decoded = decodeSatelliteClientFrame(data);
        if (decoded.ok) sent.push(decoded.header);
      },
      close: () => {},
    };
  };

  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());

  const pre: ListenPreflight = {
    probes: [],
    configuredEngine: 'transcript',
    transcriptEngineOk: true,
    modelsRequired: false,
    url: 'ws://127.0.0.1:1/satellite/ws',
    healthUrl: 'http://127.0.0.1:1/healthz',
    nodeId: 'vad-tuning-test',
    routes: [],
    edgeStt: { requested: false, enabled: false, detail: 'voice.wake.edgeStt is off' },
    player: { player: null, detail: 'no player' },
    device: { id: 'stdin', label: 'stdin', isDefault: true },
    sampleRate: 16_000,
    errors: [],
    deprecations: [],
    ...(vadTuning === undefined ? {} : { vadTuning }),
  };

  let markReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  void startListenDaemon(
    pre,
    { json: false, positional: [] },
    { storage, device, createSocket, onReady: () => markReady?.(), exit: () => {} },
  );

  // The client opens on the next tick; the route table is what unblocks the
  // rest of the boot.
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const handlers = sockets[0];
  if (!handlers) throw new Error('the daemon never opened a socket');
  handlers.onOpen();
  handlers.onMessage(routesFrame(), true);
  await ready;
  await vi.waitFor(() => expect(sinks).toHaveLength(1));
  const push = sinks[0];
  if (!push) throw new Error('the daemon never started its capture device');

  return {
    capture: (frame) => push(frame),
    sent,
    stop: () => {
      for (const name of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(name)) {
          if (!signalsBefore[name].includes(listener)) {
            (listener as NodeJS.SignalsListener)(name);
          }
        }
      }
    },
  };
}

describe('voice.bargeIn.satellite reaches the satellite VAD', () => {
  afterEach(() => {
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(name)) {
        if (!signalsBefore[name].includes(listener)) process.removeListener(name, listener);
      }
    }
    vi.restoreAllMocks();
  });

  /** Speak for ~800 ms, then go quiet long enough for the endpointer to fire. */
  async function wokeAfterSpeaking(vadTuning: ListenPreflight['vadTuning']): Promise<boolean> {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const daemon = await bootDaemon(vadTuning);
    for (let i = 0; i < 40; i++) daemon.capture(loudFrame());
    for (let i = 0; i < 30; i++) daemon.capture(quietFrame());
    daemon.stop();
    return daemon.sent.some((f) => f.t === 'wake');
  }

  it('wakes on ordinary speech when nothing is tuned', async () => {
    await expect(wokeAfterSpeaking(undefined)).resolves.toBe(true);
  });

  it('applies voice.bargeIn.satellite.energyThreshold — a loud room stops being speech', async () => {
    await expect(wokeAfterSpeaking({ threshold: 0.9 })).resolves.toBe(false);
  });

  it('applies voice.bargeIn.satellite.minSpeechMs as the attack filter', async () => {
    // 40 frames × 20 ms = 800 ms of energy. Under a 2000 ms attack floor the
    // detector never reports speech at all, so no utterance ever opens.
    await expect(wokeAfterSpeaking({ minSpeechMs: 2000 })).resolves.toBe(false);
  });
});

describe('readSatelliteVadTuning', () => {
  it('carries nothing at all when the operator tuned nothing', () => {
    expect(readSatelliteVadTuning(undefined)).toBeUndefined();
    expect(readSatelliteVadTuning({})).toBeUndefined();
    // `silenceMs` has no counterpart on this surface — see the field's doc.
    expect(readSatelliteVadTuning({ silenceMs: 700 } as never)).toBeUndefined();
  });

  it('maps the two fields the detector has', () => {
    expect(readSatelliteVadTuning({ energyThreshold: 0.4, minSpeechMs: 220 })).toEqual({
      threshold: 0.4,
      minSpeechMs: 220,
    });
    expect(readSatelliteVadTuning({ minSpeechMs: 220 })).toEqual({ minSpeechMs: 220 });
  });
});
