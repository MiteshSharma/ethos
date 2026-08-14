// `ethos listen` sub-router — routing and the `--json` contract.
//
// Driven entirely through the injected `ListenCommandDeps`, so nothing here
// loads a config, opens a socket, or touches stdin.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CaptureDevice,
  SatelliteSocketFactory,
  SatelliteSocketHandlers,
  WakeFrame,
  WakeRoute,
} from '@ethosagent/voice-satellite';
import { encodeSatelliteFrame, type SatelliteServerFrame } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ListenCommandDeps,
  type ListenPreflight,
  runListenCommand,
  startListenDaemon,
  USAGE,
} from '../commands/listen';

function preflight(overrides: Partial<ListenPreflight> = {}): ListenPreflight {
  return {
    probes: [
      { name: 'engine:transcript', ok: true, detail: 'no native bindings' },
      { name: 'models', ok: false, detail: 'model directory missing — /m' },
      { name: 'microphone', ok: true, detail: '1 input device(s): stdin' },
      { name: 'satellite-lane', ok: true, detail: 'answered 200' },
    ],
    configuredEngine: 'transcript',
    transcriptEngineOk: true,
    modelsRequired: false,
    url: 'ws://127.0.0.1:3000/satellite/ws',
    healthUrl: 'http://127.0.0.1:3000/healthz',
    nodeId: 'kitchen-pi-1a2b3c4d',
    routes: [
      {
        id: 'eng',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
      },
    ],
    edgeSttRequested: false,
    device: { id: 'stdin', label: 'raw s16le mono PCM on stdin @ 16000 Hz', isDefault: true },
    sampleRate: 16_000,
    errors: [],
    deprecations: [],
    ...overrides,
  };
}

function deps(pre: ListenPreflight = preflight()): ListenCommandDeps & {
  started: ListenPreflight[];
} {
  const started: ListenPreflight[] = [];
  return {
    started,
    preflight: async () => pre,
    start: async (p) => {
      started.push(p);
    },
  };
}

let logs: string[];
let outLines: string[];
let errLines: string[];
let stdout: string[];

beforeEach(() => {
  logs = [];
  outLines = [];
  errLines = [];
  stdout = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
    outLines.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
    errLines.push(a.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('runListenCommand routing', () => {
  it('no subcommand starts the daemon', async () => {
    const d = deps();
    await runListenCommand([], d);
    expect(d.started).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('flags before the subcommand do not become the subcommand', async () => {
    const d = deps();
    await runListenCommand(['--route', 'eng'], d);
    expect(d.started).toHaveLength(1);
  });

  it('`doctor` runs the preflight and does not start the daemon', async () => {
    const d = deps();
    await runListenCommand(['doctor'], d);
    expect(d.started).toHaveLength(0);
    expect(logs.join('\n')).toContain('wake satellite preflight');
  });

  it('an unknown subcommand prints usage and exits non-zero', async () => {
    const d = deps();
    await runListenCommand(['wat'], d);
    expect(d.started).toHaveLength(0);
    expect(logs.join('\n')).toContain(USAGE);
    expect(process.exitCode).toBe(1);
  });
});

describe('runListenCommand --json', () => {
  it('emits one parseable object carrying an exit field', async () => {
    await runListenCommand(['doctor', '--json'], deps());
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0] ?? '');
    expect(parsed.exit).toBe(0);
    expect(Array.isArray(parsed.probes)).toBe(true);
    expect(parsed.probes.map((p: { name: string }) => p.name)).toContain('engine:transcript');
    expect(parsed.nodeId).toBe('kitchen-pi-1a2b3c4d');
    // The daemon never acoustically matches, so the JSON says so rather than
    // letting a reader infer wake capability from the engine name — and it
    // says it in the two ways a script might ask.
    expect(parsed.engine.daemonMode).toBe('open-mic');
    expect(parsed.engine.phraseMatch).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('carries the non-zero exit in the object AND in process.exitCode', async () => {
    const pre = preflight({
      probes: [
        { name: 'engine:transcript', ok: true },
        { name: 'models', ok: true },
        { name: 'microphone', ok: false, detail: 'no input devices' },
        { name: 'satellite-lane', ok: true },
      ],
    });
    await runListenCommand(['doctor', '--json'], deps(pre));
    const parsed = JSON.parse(stdout[0] ?? '');
    expect(parsed.exit).toBe(2);
    expect(process.exitCode).toBe(2);
  });
});

describe('the daemon refuses to start deaf', () => {
  it('refuses when nothing is piped to stdin', async () => {
    const d = deps(preflight({ device: null }));
    await runListenCommand([], d);
    expect(d.started).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toContain('Nothing is piped to stdin');
  });

  it('zero configured routes does NOT block the daemon, and claims nothing false', async () => {
    // The server synthesizes `hey <name>` per unprivileged personality, so an
    // empty local table is the normal deployment, not a dead end. The daemon
    // starts and resolves its route against what the server pushes.
    const d = deps(preflight({ routes: [] }));
    await runListenCommand([], d);
    expect(d.started).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).not.toContain('so nothing can be sent');
    expect(out).toContain('none configured here, which is normal');
    expect(out).toContain('auto:<personalityId>');
  });

  it('--route auto:<id> is passed through, not rejected by an id charset', async () => {
    const d = deps(preflight({ routes: [], requestedRoute: 'auto:engineer' }));
    await runListenCommand(['--route', 'auto:engineer'], d);
    expect(d.started).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses when no usable wake engine remains', async () => {
    const d = deps(
      preflight({
        transcriptEngineOk: false,
        probes: [{ name: 'engine:transcript', ok: false, detail: 'boom' }],
      }),
    );
    await runListenCommand([], d);
    expect(d.started).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toContain('No usable wake engine');
  });

  it('starts in an announced degraded state when a usable engine remains', async () => {
    const d = deps(
      preflight({
        configuredEngine: 'sherpa',
        modelsRequired: true,
        probes: [
          { name: 'engine:transcript', ok: true },
          { name: 'engine:sherpa', ok: false, detail: 'wake model file missing — /m/encoder.onnx' },
          { name: 'models', ok: false, detail: 'model directory missing — /m' },
          { name: 'microphone', ok: true },
          { name: 'satellite-lane', ok: true },
        ],
      }),
    );
    await runListenCommand([], d);
    expect(d.started).toHaveLength(1);
    const out = logs.join('\n');
    expect(out).toContain('degraded');
    expect(out).toContain('wake model file missing');
  });

  it('starts with the server down — the client reconnects with backoff', async () => {
    const d = deps(
      preflight({
        probes: [
          { name: 'engine:transcript', ok: true },
          { name: 'models', ok: true },
          { name: 'microphone', ok: true },
          { name: 'satellite-lane', ok: false, detail: 'ECONNREFUSED' },
        ],
      }),
    );
    await runListenCommand([], d);
    expect(d.started).toHaveLength(1);
    expect(logs.join('\n')).toContain('not answering yet');
  });
});

// ---------------------------------------------------------------------------
// The daemon — driven through the real satellite client with a fake transport,
// so the route table it routes against is a real pushed `routes` frame.
// ---------------------------------------------------------------------------

function wakeRoute(id: string, personalityId = id): WakeRoute {
  return { id, phrase: `hey ${personalityId}`, personalityId, privileged: false, enabled: true };
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

/** A `SatelliteSocketFactory` a test can push server frames through. */
function fakeTransport(): {
  factory: SatelliteSocketFactory;
  opened: Promise<void>;
  push(frame: SatelliteServerFrame): void;
} {
  let handlers: SatelliteSocketHandlers | null = null;
  let markOpen: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve;
  });
  const factory: SatelliteSocketFactory = (_url, _init, h) => {
    handlers = h;
    h.onOpen();
    markOpen?.();
    return { send: () => {}, close: () => {} };
  };
  return {
    factory,
    opened,
    push: (frame) => handlers?.onMessage(Buffer.from(encodeSatelliteFrame(frame)), true),
  };
}

/** A `CaptureDevice` a test can push captured frames into. */
function fakeDevice(): { device: CaptureDevice; push(frame: WakeFrame): void } {
  let sink: ((frame: WakeFrame) => void) | null = null;
  return {
    device: {
      start: async (onFrame) => {
        sink = onFrame;
      },
      stop: async () => {},
      list: async () => [{ id: 'stdin', label: 'stdin' }],
    },
    push: (frame) => sink?.(frame),
  };
}

/** 20ms of frame at the daemon's declared rate. */
const FRAME_SAMPLES = 320;

/** Above `EnergyVad`'s 0.02 RMS threshold — the pipe carries something. */
function loudFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES).fill(8000), sampleRate: 16_000 };
}

function quietFrame(): WakeFrame {
  return { samples: new Int16Array(FRAME_SAMPLES), sampleRate: 16_000 };
}

/**
 * One noise blip: loud enough to open an utterance, far too short to send.
 *
 * Two loud frames plus the VAD's three hangover frames is ~80ms of speech,
 * under `CaptureMachine`'s 400ms floor, and 30 quiet frames is past its
 * 20-frame endpointer — so this is a `● speech` line followed by a local
 * discard, which is exactly what a chair scrape looks like.
 */
function blip(push: (frame: WakeFrame) => void): void {
  push(loudFrame());
  push(loudFrame());
  for (let i = 0; i < 30; i++) push(quietFrame());
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Signal handlers the daemon installs must not leak between tests. */
const signalsBefore = {
  SIGINT: process.listeners('SIGINT'),
  SIGTERM: process.listeners('SIGTERM'),
};

afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalsBefore[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
});

/**
 * Start the daemon on a fake transport and hand back the pushed-table lever.
 *
 * The success path never resolves (the daemon awaits a keep-alive), so the
 * returned promise is only awaited by the refusal cases.
 */
async function runDaemon(
  routes: WakeRoute[],
  flags: { route?: string; json?: boolean } = {},
): Promise<{
  done: Promise<void>;
  ready: Promise<void>;
  push(frame: SatelliteServerFrame): void;
  capture(frame: WakeFrame): void;
}> {
  const transport = fakeTransport();
  const device = fakeDevice();
  let markReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = startListenDaemon(
    preflight({ ...(flags.route === undefined ? {} : { requestedRoute: flags.route }) }),
    { json: flags.json === true, positional: [], ...(flags.route ? { route: flags.route } : {}) },
    {
      storage: new InMemoryStorage(),
      device: device.device,
      createSocket: transport.factory,
      onReady: () => markReady?.(),
    },
  );
  await transport.opened;
  transport.push(routesFrame(routes));
  return { done, ready, push: transport.push, capture: device.push };
}

describe('the daemon is an open mic addressed by phrase', () => {
  it('starts with several routes and no --route, naming every phrase that can address it', async () => {
    // The behaviour this replaces: two routes used to be a startup REFUSAL,
    // because the daemon had to pick a personality up front. The phrase picks
    // it now, so several routes is the ordinary case and all of them are live.
    const { ready } = await runDaemon([
      wakeRoute('auto:engineer', 'engineer'),
      wakeRoute('auto:writer', 'writer'),
    ]);
    await ready;
    const out = logs.join('\n');
    expect(process.exitCode).toBeUndefined();
    expect(out).toContain('Addressable here');
    expect(out).toContain('hey engineer');
    expect(out).toContain('hey writer');
  });

  it('states the model in one sentence: transcribed always, answered only when addressed', async () => {
    const { ready } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    const out = logs.join('\n');
    // The privacy half — the room IS transcribed — and the interaction half,
    // including the follow-up window, in the server's own seconds (8000ms in
    // `routesFrame`, not this machine's config).
    expect(out).toContain('EVERYTHING heard here is transcribed');
    expect(out).toContain('OPENS with a wake phrase');
    expect(out).toContain('follow-ups within 8s');
    expect(out).toContain('heard and discarded');
    // …and no claim of a button that does not exist.
    expect(out).not.toContain('Push-to-talk');
  });

  it('--route PINS the host to one route rather than bypassing the phrase', async () => {
    const { ready } = await runDaemon(
      [wakeRoute('auto:engineer', 'engineer'), wakeRoute('auto:writer', 'writer')],
      { route: 'auto:engineer' },
    );
    await ready;
    const out = logs.join('\n');
    expect(out).toContain('Pinned by --route');
    expect(out).toContain('hey engineer');
    // The pin narrows; it does not exempt. The other route is excluded, and
    // the pinned phrase is still required.
    expect(out).toContain('Other phrases are heard and discarded');
    expect(out).not.toContain('hey writer');
  });

  it('a --route the server never pushed fails against the PUSHED list', async () => {
    const { done } = await runDaemon([wakeRoute('auto:engineer')], { route: 'auto:enginer' });
    await done;
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toContain("no enabled route 'auto:enginer'");
  });

  it('an empty pushed table WARNS and keeps running — a Settings save can fix it live', async () => {
    const { ready } = await runDaemon([]);
    await ready;
    const out = logs.join('\n');
    expect(process.exitCode).toBeUndefined();
    expect(out).toContain('EMPTY wake route table');
    expect(out).toContain('privileged');
    expect(out).toContain('without a restart');
  });
});

describe('the daemon narrates the turn', () => {
  it('a transcript frame is printed as the operator’s own words', async () => {
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    push({ t: 'transcript', utteranceId: 'u1', text: 'what is on my calendar', final: true });
    const out = outLines.join('\n');
    expect(out).toContain('› you:');
    expect(out).toContain('what is on my calendar');
  });

  it('an empty final transcript says the server heard nothing, not a blank `› you:`', async () => {
    // The lane's answer to "there was no speech in that audio" is a final
    // transcript with an empty string, followed by `turn_end` — not an error.
    // Rendering it through the normal branch printed a bare `› you:`.
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    push({ t: 'transcript', utteranceId: 'u1', text: '', final: true });
    push({ t: 'turn_end', utteranceId: 'u1', personalityId: 'engineer' });
    const out = outLines.join('\n');
    expect(out).toContain('no speech in that audio');
    expect(out).not.toContain('› you:');
    // And nothing in it reads as a fault the operator caused.
    expect(out).not.toContain('failed');
    expect(out).not.toContain('error');
  });

  it('an unaddressed utterance is narrated calmly — heard, written down, no agent called', async () => {
    // The COMMON case in a room, and the one the daemon could not describe
    // before: `turn_end` with no personality means the server matched no wake
    // phrase and ran no turn.
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    push({ t: 'transcript', utteranceId: 'u1', text: 'pass the salt', final: true });
    push({ t: 'turn_end', utteranceId: 'u1' });
    const out = outLines.join('\n');
    // The operator still sees what the room said…
    expect(out).toContain('pass the salt');
    // …and why nothing happened, in words that blame nobody.
    expect(out).toContain('not addressed to anyone');
    expect(out).toContain('Open with a wake phrase');
    expect(out).not.toContain('turn complete');
    expect(out).not.toContain('error');
    expect(out).not.toContain('failed');
  });

  it('tells "no speech" apart from "not addressed" — both arrive with no personality', async () => {
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    push({ t: 'transcript', utteranceId: 'u1', text: '', final: true });
    push({ t: 'turn_end', utteranceId: 'u1' });
    const out = outLines.join('\n');
    expect(out).toContain('no speech in that audio');
    // Nothing was said, so nothing was left unaddressed — claiming otherwise
    // would tell the operator to say a wake phrase to a door that closed.
    expect(out).not.toContain('not addressed to anyone');
    expect(out).toContain('listening again');
  });

  it('a reply_text frame is printed as the personality’s answer', async () => {
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    push({
      t: 'reply_text',
      utteranceId: 'u1',
      personalityId: 'engineer',
      text: 'Two meetings, both after lunch.',
    });
    const out = outLines.join('\n');
    // This host has no loudspeaker, so this line is the whole answer: it must
    // name who spoke as well as what was said.
    expect(out).toContain('Two meetings, both after lunch.');
    expect(out).toContain('engineer');
  });

  it('turn_end closes the cycle without claiming a segment count', async () => {
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    push({
      t: 'speak_start',
      utteranceId: 'u1',
      segmentId: 's1',
      codec: 'pcm_s16le',
      mimeType: 'audio/pcm',
    });
    push({ t: 'turn_end', utteranceId: 'u1', personalityId: 'engineer' });
    const out = logs.join('\n');
    expect(out).toContain('turn complete');
    expect(out).toContain('Listening again');
    // The server skips synthesis for a playback: false node, so the count this
    // line used to print was always zero. Audio arriving at all is the anomaly,
    // and it gets its own warning rather than a running tally.
    expect(out).not.toContain('reply segment(s)');
    expect(out).toContain('audio is being discarded');
  });

  it('a locally discarded utterance closes the `● speech` line it opened', async () => {
    const { ready, capture } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    blip(capture);
    const out = outLines.join('\n');
    // The failure this fixes: an operator watching `●` lines appear with
    // nothing after them.
    expect(occurrences(out, '● speech')).toBe(1);
    expect(out).toContain('discarded utterance');
    expect(out).toContain('under the 400ms minimum');
  });

  it('the discard notice is paired to its open marker — one line each, never a stray', async () => {
    const { ready, capture } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    blip(capture);
    blip(capture);
    // Quiet after the second discard: the machine re-arms through `listening`
    // and must not narrate a third time with no `●` to close.
    for (let i = 0; i < 40; i++) capture(quietFrame());
    const out = outLines.join('\n');
    expect(occurrences(out, '● speech')).toBe(2);
    expect(occurrences(out, 'discarded utterance')).toBe(2);
  });

  it('under --json nothing the daemon narrates reaches stdout', async () => {
    const { ready, push, capture } = await runDaemon([wakeRoute('auto:engineer', 'engineer')], {
      json: true,
    });
    await ready;
    push({ t: 'transcript', utteranceId: 'u1', text: 'hello there', final: true });
    push({ t: 'reply_text', utteranceId: 'u1', personalityId: 'engineer', text: 'hello yourself' });
    push({ t: 'transcript', utteranceId: 'u2', text: '', final: true });
    // Ordered: the blip needs a live microphone, so it goes before the mute.
    blip(capture);
    push({ t: 'set_wake_enabled', enabled: false });
    const err = errLines.join('\n');
    expect(err).toContain('hello there');
    expect(err).toContain('hello yourself');
    expect(err).toContain('no speech in that audio');
    expect(err).toContain('discarded utterance');
    expect(err).toContain('muted');
    expect(outLines).toHaveLength(0);
    expect(stdout).toHaveLength(0);
  });

  it('a PINNED route that vanishes is warned about once, and its return is narrated', async () => {
    // Only a pinned host has a route to lose. Unpinned, the server matches
    // against whatever table it holds and this daemon has no opinion to stale.
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')], {
      route: 'auto:engineer',
    });
    await ready;
    // Every reconnect and Settings save re-pushes the table.
    push(routesFrame([wakeRoute('auto:writer', 'writer')]));
    push(routesFrame([wakeRoute('auto:writer', 'writer')]));
    push(routesFrame([wakeRoute('auto:engineer', 'engineer')]));
    const out = outLines.join('\n');
    expect(occurrences(out, 'no longer has an enabled route')).toBe(1);
    expect(out).toContain("route 'auto:engineer' is back");
  });

  it('a server-side mute is narrated — a deaf satellite never looks like a live one', async () => {
    const { ready, push } = await runDaemon([wakeRoute('auto:engineer', 'engineer')]);
    await ready;
    push({ t: 'set_wake_enabled', enabled: false });
    push({ t: 'set_wake_enabled', enabled: false });
    push({ t: 'set_wake_enabled', enabled: true });
    const out = outLines.join('\n');
    // Once per CHANGE: a repeated toggle of the same value says nothing new.
    expect(occurrences(out, 'this node is muted')).toBe(1);
    expect(occurrences(out, 'wake re-enabled')).toBe(1);
  });
});
