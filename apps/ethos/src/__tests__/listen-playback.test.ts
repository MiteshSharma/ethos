// `ethos listen` audio OUT — the loudspeaker this host used to declare it had
// not got.
//
// Two halves. The first is the command player itself: which command is chosen,
// what argv it gets for which codec, and the staleness discipline that keeps
// yesterday's sentence out of today's speaker. The second is the daemon around
// it — what it registers, when the microphone comes back, and what it does on a
// machine where nothing can make a sound, which is still the common case and
// must stay a text-only reply rather than a crash.

import { ethosDir } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import type {
  CaptureDevice,
  CaptureEnd,
  PlaybackDevice,
  PlaybackFormat,
  SatelliteSocketFactory,
  SatelliteSocketHandlers,
  WakeFrame,
  WakeRoute,
} from '@ethosagent/voice-satellite';
import {
  decodeSatelliteClientFrame,
  encodeSatelliteFrame,
  type SatelliteClientFrame,
  type SatelliteServerFrame,
} from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCommandPlaybackDevice,
  type ListenPreflight,
  type PlayerProcess,
  playerArgv,
  resolvePlayer,
  startListenDaemon,
} from '../commands/listen';

// ---------------------------------------------------------------------------
// Choosing a player
// ---------------------------------------------------------------------------

describe('resolvePlayer', () => {
  it('takes --play at face value — the operator knows their machine', () => {
    const resolved = resolvePlayer('mpv --no-video -', () => true);
    expect(resolved.player).toEqual({ kind: 'custom', command: 'mpv --no-video -' });
    expect(resolved.detail).toContain('--play');
  });

  it('probes PATH in order and reports the command it actually found', () => {
    const resolved = resolvePlayer(undefined, (bin) => bin === 'aplay');
    expect(resolved.player?.kind).toBe('aplay');
    expect(resolved.detail).toContain('aplay on PATH');
    // A raw-only player has to say so, or an operator whose replies are silent
    // has no way to learn that opus was the problem.
    expect(resolved.detail).toContain('Raw PCM only');
  });

  it('prefers ffplay, the only probed player that can open what the server usually sends', () => {
    const resolved = resolvePlayer(undefined, () => true);
    expect(resolved.player?.kind).toBe('ffplay');
    expect(resolved.detail).not.toContain('Raw PCM only');
  });

  it('finding nothing is a null player and the names of the three it looked for', () => {
    const resolved = resolvePlayer(undefined, () => false);
    expect(resolved.player).toBeNull();
    expect(resolved.detail).toContain('ffplay');
    expect(resolved.detail).toContain('aplay');
    expect(resolved.detail).toContain('play');
    expect(resolved.detail).toContain('TEXT ONLY');
    expect(resolved.detail).toContain('--play');
  });

  it('an empty --play is not a player', () => {
    expect(resolvePlayer('   ', () => false).player).toBeNull();
  });
});

function format(codec: PlaybackFormat['codec']): PlaybackFormat {
  return {
    sampleRate: 24_000,
    channels: 1,
    codec,
    mimeType: codec === 'pcm_s16le' ? 'audio/pcm' : 'audio/ogg;codecs=opus',
  };
}

describe('playerArgv', () => {
  it('spells the format out for raw PCM, which carries no header', () => {
    const built = playerArgv({ kind: 'ffplay', command: '' }, format('pcm_s16le'));
    expect(built.argv).toContain('s16le');
    expect(built.argv).toContain('24000');
  });

  it('leaves an encoded stream for ffplay to demux', () => {
    const built = playerArgv({ kind: 'ffplay', command: '' }, format('encoded'));
    expect(built.argv).not.toContain('s16le');
    expect(built.argv).toEqual(['ffplay', '-nodisp', '-autoexit', '-loglevel', 'error', '-i', '-']);
  });

  it('REFUSES an encoded stream on a raw-only player rather than playing the container', () => {
    // `aplay` handed an ogg stream does not error — it plays the header as
    // samples, which is a burst of noise in somebody's kitchen. The refusal is
    // what turns that into a text reply.
    const built = playerArgv({ kind: 'aplay', command: '' }, format('encoded'));
    expect(built.argv).toBeUndefined();
    expect(built.refusal).toContain('RAW PCM only');
    expect(built.refusal).toContain('audio/ogg;codecs=opus');
  });

  it('substitutes the operator template and runs it through sh -c', () => {
    const built = playerArgv(
      { kind: 'custom', command: 'mpv --audio-samplerate={rate} --channels={channels} -' },
      format('pcm_s16le'),
    );
    expect(built.argv).toEqual(['sh', '-c', 'mpv --audio-samplerate=24000 --channels=1 -']);
  });
});

// ---------------------------------------------------------------------------
// The command playback device
// ---------------------------------------------------------------------------

function fakeProcess(): PlayerProcess & { written: string[]; killed: boolean; ended: boolean } {
  const state = {
    written: [] as string[],
    killed: false,
    ended: false,
    write(chunk: Uint8Array): void {
      state.written.push(new TextDecoder().decode(chunk));
    },
    async end(): Promise<void> {
      state.ended = true;
    },
    kill(): void {
      state.killed = true;
    },
  };
  return state;
}

describe('createCommandPlaybackDevice', () => {
  it('drops a write for an utterance that is not the one in flight', async () => {
    const proc = fakeProcess();
    const device = createCommandPlaybackDevice({
      player: { kind: 'ffplay', command: '' },
      spawnPlayer: () => proc,
    });
    await device.start('u1', format('pcm_s16le'));
    device.write('u1', new TextEncoder().encode('mine'));
    device.write('u2', new TextEncoder().encode('stale'));
    expect(proc.written).toEqual(['mine']);
  });

  it('cancel kills the player and end() is never reached for that utterance', async () => {
    const proc = fakeProcess();
    const device = createCommandPlaybackDevice({
      player: { kind: 'ffplay', command: '' },
      spawnPlayer: () => proc,
    });
    await device.start('u1', format('pcm_s16le'));
    device.cancel('u1');
    expect(proc.killed).toBe(true);
    await device.end('u1');
    expect(proc.ended).toBe(false);
  });

  it('end() for a stale utterance does not drain the live one', async () => {
    const proc = fakeProcess();
    const device = createCommandPlaybackDevice({
      player: { kind: 'ffplay', command: '' },
      spawnPlayer: () => proc,
    });
    await device.start('u1', format('pcm_s16le'));
    await device.end('u2');
    expect(proc.ended).toBe(false);
    await device.end('u1');
    expect(proc.ended).toBe(true);
  });

  it('throws the refusal rather than spawning a player that would make noise', async () => {
    let spawned = 0;
    const device = createCommandPlaybackDevice({
      player: { kind: 'aplay', command: '' },
      spawnPlayer: () => {
        spawned += 1;
        return fakeProcess();
      },
    });
    await expect(device.start('u1', format('encoded'))).rejects.toThrow(/RAW PCM only/);
    expect(spawned).toBe(0);
    // A structured refusal, not a bare Error: the remedy travels on `action`
    // rather than being glued onto the diagnosis.
    const thrown = await device.start('u1', format('encoded')).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(EthosError);
    expect(thrown instanceof EthosError ? thrown.action : '').toContain('ffmpeg');
  });

  it('a new playout kills the one that was still running', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = [];
    const device = createCommandPlaybackDevice({
      player: { kind: 'ffplay', command: '' },
      spawnPlayer: () => {
        const proc = fakeProcess();
        procs.push(proc);
        return proc;
      },
    });
    await device.start('u1', format('pcm_s16le'));
    await device.start('u2', format('pcm_s16le'));
    expect(procs[0]?.killed).toBe(true);
    expect(procs[1]?.killed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The daemon — driven through the real satellite client with a taped transport
// ---------------------------------------------------------------------------

const FRAME_SAMPLES = 320;

function loudFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES).fill(8000), sampleRate: 16_000 };
}

function quietFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES), sampleRate: 16_000 };
}

function wakeRoute(id: string, personalityId = id): WakeRoute {
  return { id, phrase: personalityId, personalityId, privileged: false, enabled: true };
}

function routesFrame(routes: WakeRoute[]): SatelliteServerFrame {
  return {
    t: 'routes',
    routes,
    settings: {
      engine: 'transcript',
      sensitivity: 0.5,
      confirmationFrames: 1,
      edgeStt: false,
      idleTimeoutMs: 8000,
      wakeEnabled: true,
    },
  };
}

function preflight(overrides: Partial<ListenPreflight> = {}): ListenPreflight {
  return {
    probes: [],
    configuredEngine: 'transcript',
    transcriptEngineOk: true,
    modelsRequired: false,
    url: 'ws://127.0.0.1:3000/satellite/ws',
    healthUrl: 'http://127.0.0.1:3000/healthz',
    nodeId: 'pi-playback',
    routes: [],
    edgeStt: { requested: false, enabled: false, detail: 'voice.wake.edgeStt is off' },
    player: { player: null, detail: 'none of ffplay, aplay or play is on PATH' },
    device: { id: 'stdin', label: 'stdin', isDefault: true },
    sampleRate: 16_000,
    errors: [],
    deprecations: [],
    ...overrides,
  };
}

let logs: string[];

const signalsBefore = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM'),
};

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
});

afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalsBefore[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
});

/** Start the daemon; hand back the levers a playback test needs. */
async function runDaemon(
  overrides: Partial<ListenPreflight>,
  playbackDevice?: PlaybackDevice,
): Promise<{
  ready: Promise<void>;
  push(frame: SatelliteServerFrame, payload?: Uint8Array): void;
  capture(frame: WakeFrame): void;
  /** Every frame the client actually put on the wire, decoded. */
  sent: SatelliteClientFrame[];
}> {
  let handlers: SatelliteSocketHandlers | null = null;
  const sent: SatelliteClientFrame[] = [];
  let markOpen: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve;
  });
  const factory: SatelliteSocketFactory = (_url, _init, h) => {
    handlers = h;
    // ASYNCHRONOUSLY, like the real transport. The client assigns its socket
    // only after this factory returns, so an `onOpen` fired inline has its
    // `register` dropped as "socket is not open" — and a test that asserts on
    // capabilities would be asserting on a frame that was never sent.
    setTimeout(() => {
      h.onOpen();
      markOpen?.();
    }, 0);
    return {
      send: (data) => {
        const decoded = decodeSatelliteClientFrame(data);
        if (decoded.ok) sent.push(decoded.header);
      },
      close: () => {},
    };
  };

  let sink: ((frame: WakeFrame) => void) | null = null;
  const device: CaptureDevice = {
    start: async (onFrame, _onEnd: (end: CaptureEnd) => void) => {
      sink = onFrame;
    },
    stop: async () => {},
    list: async () => [{ id: 'stdin', label: 'stdin' }],
  };

  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  let markReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  void startListenDaemon(
    preflight(overrides),
    { json: false, positional: [] },
    {
      storage,
      device,
      ...(playbackDevice === undefined ? {} : { playbackDevice }),
      createSocket: factory,
      onReady: () => markReady?.(),
      exit: () => {},
    },
  );
  // Declared as a closure so it is the one path frames take in — reading
  // `handlers` at statement level would have TypeScript narrow it to the `null`
  // it was initialized with, since the only assignment happens in a callback.
  const push = (frame: SatelliteServerFrame, payload?: Uint8Array): void => {
    handlers?.onMessage(Buffer.from(encodeSatelliteFrame(frame, payload)), true);
  };

  await opened;
  push(routesFrame([wakeRoute('engineer')]));
  return {
    ready,
    push,
    capture: (frame) => sink?.(frame),
    sent,
  };
}

/** Speak for ~800 ms, then go quiet long enough for the endpointer to fire. */
function saySomething(capture: (frame: WakeFrame) => void): void {
  for (let i = 0; i < 40; i++) capture(loudFrame());
  for (let i = 0; i < 30; i++) capture(quietFrame());
}

function speakStart(utteranceId: string): SatelliteServerFrame {
  return {
    t: 'speak_start',
    utteranceId,
    segmentId: 's1',
    codec: 'pcm_s16le',
    mimeType: 'audio/pcm',
  };
}

describe('a host with no player', () => {
  it('registers playback: false, replies with text, and warns exactly once', async () => {
    const { ready, push, sent } = await runDaemon({});
    await ready;

    // Asserted on the frame ITSELF, not on a boolean expression that a missing
    // register would satisfy for free — a capability claim that cannot fail is
    // not a test.
    const register = sent.find((f) => f.t === 'register');
    expect(register?.t).toBe('register');
    expect(register?.t === 'register' ? register.capabilities.playback : 'no register').toBe(false);

    // Two segments, one warning. The condition has not changed between them,
    // and a line per segment is how a long reply buries its own transcript.
    push(speakStart('u1'));
    push(speakStart('u1'));
    push({
      t: 'reply_text',
      utteranceId: 'u1',
      personalityId: 'engineer',
      text: 'Nothing is on fire.',
    });
    push({ t: 'turn_end', utteranceId: 'u1', personalityId: 'engineer' });

    const out = logs.join('\n');
    expect(out.split('audio is being discarded').length - 1).toBe(1);
    // The answer still arrives — voice failures degrade to text, they do not
    // remove the reply.
    expect(out).toContain('Nothing is on fire.');
    // And the operator was told at STARTUP, not on the first silent reply.
    expect(out).toContain('TEXT ONLY');
    // The re-arm is immediate: there is no speaker to wait for.
    expect(sent.some((f) => f.t === 'playback_done')).toBe(true);
  });
});

describe('a host with a player', () => {
  it('registers playback: true and feeds the reply to the device', async () => {
    let released: (() => void) | null = null;
    // Read through a closure: assigning inside a Promise executor leaves
    // TypeScript narrowing the variable to its `null` initializer at statement
    // level, which is a type error rather than a fact about the test.
    const drain = (): void => released?.();
    const played: string[] = [];
    const device: PlaybackDevice = {
      start: async () => {},
      write: (_id, pcm) => played.push(new TextDecoder().decode(pcm)),
      end: () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
      cancel: () => {},
      list: async () => [],
    };
    const { ready, push, sent } = await runDaemon(
      { player: { player: { kind: 'ffplay', command: 'ffplay' }, detail: 'ffplay on PATH' } },
      device,
    );
    await ready;

    const register = sent.find((f) => f.t === 'register');
    expect(register?.t).toBe('register');
    expect(register?.t === 'register' ? register.capabilities.playback : 'no register').toBe(true);
    expect(logs.join('\n')).toContain('Replies are spoken through');

    push(speakStart('u1'));
    push(
      { t: 'audio', utteranceId: 'u1', segmentId: 's1', seq: 0 },
      new TextEncoder().encode('samples'),
    );
    await vi.waitFor(() => expect(played).toEqual(['samples']));

    push({ t: 'turn_end', utteranceId: 'u1', personalityId: 'engineer' });
    // THE RECEIPT WAITS FOR THE SPEAKER. `turn_end` has landed; the audio has
    // not finished leaving the device, so the microphone stays shut.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.some((f) => f.t === 'playback_done')).toBe(false);
    // …and so does the sentence that claims it. "Listening again" printed over
    // a speaker that is still talking is the same lie in a different medium.
    expect(logs.join('\n')).not.toContain('Listening again');

    drain();
    await vi.waitFor(() => expect(sent.some((f) => f.t === 'playback_done')).toBe(true));
    expect(logs.join('\n')).toContain('turn complete. Listening again.');
  });

  it('self-wake suppression covers the playout: frames heard while speaking do not wake', async () => {
    let released: (() => void) | null = null;
    // Read through a closure: assigning inside a Promise executor leaves
    // TypeScript narrowing the variable to its `null` initializer at statement
    // level, which is a type error rather than a fact about the test.
    const drain = (): void => released?.();
    const device: PlaybackDevice = {
      start: async () => {},
      write: () => {},
      end: () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
      cancel: () => {},
      list: async () => [],
    };
    const { ready, push, capture, sent } = await runDaemon(
      { player: { player: { kind: 'ffplay', command: 'ffplay' }, detail: 'ffplay on PATH' } },
      device,
    );
    await ready;

    // One real turn: the utterance opens, closes, and the machine drops into
    // `speaking` for the reply.
    saySomething(capture);
    await vi.waitFor(() => expect(sent.some((f) => f.t === 'utterance_end')).toBe(true));
    const wakesBefore = sent.filter((f) => f.t === 'wake').length;
    expect(wakesBefore).toBe(1);

    push(speakStart('u1'));
    // THE AGENT'S OWN VOICE, arriving back down the microphone at full volume
    // while the reply is playing. Not one frame of it may open an utterance.
    saySomething(capture);
    saySomething(capture);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.filter((f) => f.t === 'wake')).toHaveLength(wakesBefore);

    // …and the microphone comes back only once the speaker has drained.
    push({ t: 'turn_end', utteranceId: 'u1', personalityId: 'engineer' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.filter((f) => f.t === 'wake')).toHaveLength(wakesBefore);

    drain();
    await vi.waitFor(() => expect(sent.some((f) => f.t === 'playback_done')).toBe(true));
    saySomething(capture);
    await vi.waitFor(() => expect(sent.filter((f) => f.t === 'wake').length).toBe(wakesBefore + 1));
  });

  it('a device that refuses the codec says so once and keeps replying as text', async () => {
    const device: PlaybackDevice = {
      start: async () => {
        throw new Error('aplay plays RAW PCM only and the server sent audio/ogg;codecs=opus');
      },
      write: () => {},
      end: async () => {},
      cancel: () => {},
      list: async () => [],
    };
    const { ready, push, sent } = await runDaemon(
      { player: { player: { kind: 'aplay', command: 'aplay' }, detail: 'aplay on PATH' } },
      device,
    );
    await ready;

    push(speakStart('u1'));
    push(speakStart('u2'));
    push({
      t: 'reply_text',
      utteranceId: 'u1',
      personalityId: 'engineer',
      text: 'Still readable.',
    });
    push({ t: 'turn_end', utteranceId: 'u1', personalityId: 'engineer' });

    await vi.waitFor(() => expect(sent.some((f) => f.t === 'playback_done')).toBe(true));
    const out = logs.join('\n');
    expect(out.split('RAW PCM only').length - 1).toBe(1);
    expect(out).toContain('Still readable.');
  });
});
