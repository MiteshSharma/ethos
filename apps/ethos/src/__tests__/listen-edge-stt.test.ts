// `ethos listen` edge STT — the one claim that is worth breaking a build over.
//
// "No audio leaves the machine" is not a feature, it is a promise made to
// somebody who put a microphone in their kitchen. So the assertions here are
// deliberately negative and deliberately exact: a `transcript` frame goes up and
// the count of `audio` frames is ZERO. A test that only checked the transcript
// arrived would stay green on a node that sent the words AND the samples, which
// is the failure with the worst possible consequences and the mildest possible
// symptoms.
//
// The other half is the refusal. A cloud recognizer running "at the edge" still
// uploads the room, so declaring `edgeStt: true` for one would make the server
// stop sending audio while the audio went anyway. That is refused, and the
// reason names the provider — an operator who set `local-whisper` in their
// config and got `openai-stt` has to be told which.

import { ethosDir } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  SttProvider,
  SttProviderFactory,
  SttProviderRegistry,
  VoiceCapabilities,
} from '@ethosagent/types';
import type {
  CaptureDevice,
  CaptureEnd,
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
  edgeSttReport,
  type ListenPreflight,
  resolveEdgeSttFrom,
  startListenDaemon,
} from '../commands/listen';

// ---------------------------------------------------------------------------
// Resolution — through the one path, with the egress gate inside it
// ---------------------------------------------------------------------------

function sttCaps(local: boolean): VoiceCapabilities {
  return { kind: 'stt', formats: ['wav'], local, contractVersion: 2 };
}

function fakeStt(name: string, local: boolean, text = 'transcribed here'): SttProvider {
  return {
    name,
    caps: sttCaps(local),
    transcribeBuffer: async () => text,
  };
}

function registryWith(entries: Record<string, SttProvider>): SttProviderRegistry {
  const factories = new Map<string, SttProviderFactory>(
    Object.entries(entries).map(([name, provider]) => [name, () => provider]),
  );
  return {
    register: (name, factory) => {
      factories.set(name, factory);
    },
    unregister: (name) => {
      factories.delete(name);
    },
    get: (name) => factories.get(name),
    list: () => [...factories.keys()],
  };
}

describe('resolveEdgeSttFrom', () => {
  it('a LOCAL recognizer resolves and is what the report names', async () => {
    const registry = registryWith({ 'local-stt': fakeStt('local-stt', true) });
    const resolution = await resolveEdgeSttFrom(registry, { asr: { provider: 'local-stt' } });
    expect(resolution.provider).not.toBeNull();
    expect(resolution.providerId).toBe('local-stt');

    const report = edgeSttReport(true, resolution);
    expect(report.enabled).toBe(true);
    expect(report.detail).toContain('local-stt');
    expect(report.detail).toContain('No captured audio leaves');
  });

  it('REFUSES a non-local recognizer, and the reason names it', async () => {
    const registry = registryWith({ 'openai-stt': fakeStt('openai-stt', false) });
    const resolution = await resolveEdgeSttFrom(registry, { asr: { provider: 'openai-stt' } });

    expect(resolution.provider).toBeNull();
    // The id is carried even on the refusal: "some provider" sends an operator
    // looking through a config they already believed was right.
    expect(resolution.providerId).toBe('openai-stt');
    expect(resolution.reason).toContain('openai-stt');
    expect(resolution.reason).toContain('not local');
    expect(resolution.reason).toContain('audio WILL be streamed to the server');

    const report = edgeSttReport(true, resolution);
    expect(report.enabled).toBe(false);
    expect(report.providerId).toBe('openai-stt');
  });

  it('a roster label cannot launder a cloud provider past the local check', async () => {
    // Named `local-whisper` and backed by a non-local provider. The check keys
    // on the constructed provider's caps, never on what it was called.
    const registry = registryWith({ 'local-whisper': fakeStt('groq-stt', false) });
    const resolution = await resolveEdgeSttFrom(registry, { asr: { provider: 'local-whisper' } });
    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toContain('not local');
  });

  it('no provider configured is a reason, not a crash', async () => {
    const resolution = await resolveEdgeSttFrom(registryWith({}), { asr: undefined });
    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toContain('auxiliary.asr.provider');
  });

  it('an unknown provider name is reported as itself', async () => {
    const resolution = await resolveEdgeSttFrom(registryWith({}), { asr: { provider: 'nope' } });
    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toContain('nope');
  });

  it('the trustedVoicePlugins egress gate applies — it is the same resolution path', async () => {
    // A non-local provider absent from the allowlist is refused by the gate
    // INSIDE `resolveSttProvider`, before the local check ever runs. That is
    // the point of not opening a second resolution path here.
    const registry = registryWith({ 'openai-stt': fakeStt('openai-stt', false) });
    const resolution = await resolveEdgeSttFrom(registry, {
      asr: { provider: 'openai-stt' },
      trustedVoicePlugins: new Set<string>(),
    });
    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toContain('voice.trustedPlugins');
  });

  it('a factory that throws is a reason, not an unhandled rejection', async () => {
    const registry = registryWith({});
    registry.register('broken-stt', () => {
      throw new Error('model file missing');
    });
    const resolution = await resolveEdgeSttFrom(registry, { asr: { provider: 'broken-stt' } });
    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toContain('model file missing');
  });
});

describe('edgeSttReport when nothing was asked for', () => {
  it('says which end transcribes rather than nothing at all', () => {
    const report = edgeSttReport(false, { provider: null, reason: 'voice.wake.edgeStt is off' });
    expect(report.requested).toBe(false);
    expect(report.enabled).toBe(false);
    expect(report.detail).toContain('voice.wake.edgeStt is off');
  });
});

// ---------------------------------------------------------------------------
// The daemon — what actually goes on the wire
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

function routesFrame(): SatelliteServerFrame {
  return {
    t: 'routes',
    routes: [wakeRoute('engineer')],
    settings: {
      engine: 'transcript',
      sensitivity: 0.5,
      confirmationFrames: 1,
      edgeStt: true,
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
    nodeId: 'pi-edge',
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

async function runDaemon(
  overrides: Partial<ListenPreflight>,
  edgeSttProvider?: SttProvider,
): Promise<{
  ready: Promise<void>;
  capture(frame: WakeFrame): void;
  push(frame: SatelliteServerFrame): void;
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
    // Async, like the real transport: the client assigns its socket after this
    // returns, so an inline `onOpen` loses the `register` frame.
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
      ...(edgeSttProvider === undefined ? {} : { edgeSttProvider }),
      createSocket: factory,
      onReady: () => markReady?.(),
      exit: () => {},
    },
  );
  const push = (frame: SatelliteServerFrame): void => {
    handlers?.onMessage(Buffer.from(encodeSatelliteFrame(frame)), true);
  };

  await opened;
  push(routesFrame());
  return {
    ready,
    capture: (frame) => sink?.(frame),
    push,
    sent,
  };
}

function saySomething(capture: (frame: WakeFrame) => void): void {
  for (let i = 0; i < 40; i++) capture(loudFrame());
  for (let i = 0; i < 30; i++) capture(quietFrame());
}

const EDGE_ON = {
  edgeStt: {
    requested: true,
    enabled: true,
    providerId: 'local-stt',
    detail: 'on-device: local-stt (caps.local)',
  },
} satisfies Partial<ListenPreflight>;

describe('a node with a local recognizer', () => {
  it('registers edgeStt: true, sends the WORDS, and sends ZERO audio frames', async () => {
    const provider = fakeStt('local-stt', true, 'engineer is anything on fire');
    const { ready, capture, sent } = await runDaemon(EDGE_ON, provider);
    await ready;

    const register = sent.find((f) => f.t === 'register');
    expect(register?.t).toBe('register');
    expect(register?.t === 'register' ? register.capabilities.edgeStt : 'no register').toBe(true);

    saySomething(capture);
    await vi.waitFor(() => expect(sent.some((f) => f.t === 'transcript')).toBe(true));

    const transcript = sent.find((f) => f.t === 'transcript');
    expect(transcript?.t === 'transcript' ? transcript.text : null).toBe(
      'engineer is anything on fire',
    );

    // THE PRIVACY CLAIM, and the only assertion in this file that matters more
    // than the rest: not one sample went upstream. `utterance_end` is absent
    // for the same reason — on an edge node the transcript IS the end, and the
    // two are alternatives on the wire.
    expect(sent.filter((f) => f.t === 'audio')).toHaveLength(0);
    expect(sent.filter((f) => f.t === 'utterance_end')).toHaveLength(0);
    // The utterance was still OPENED upstream, or the server would have nothing
    // to attach the words to.
    expect(sent.filter((f) => f.t === 'utterance_start')).toHaveLength(1);
    expect(logs.join('\n')).toContain('ON THIS MACHINE');
  });

  it('a recognizer that fails closes the utterance instead of falling back to uploading', async () => {
    const provider: SttProvider = {
      name: 'local-stt',
      caps: sttCaps(true),
      transcribeBuffer: async () => {
        throw new Error('whisper model would not load');
      },
    };
    const { ready, capture, sent } = await runDaemon(EDGE_ON, provider);
    await ready;

    saySomething(capture);
    await vi.waitFor(() => expect(sent.some((f) => f.t === 'transcript')).toBe(true));

    // An EMPTY transcript: the server matches it against nobody and sends
    // `turn_end`, so the microphone comes back. The samples are still here and
    // still going nowhere.
    const transcript = sent.find((f) => f.t === 'transcript');
    expect(transcript?.t === 'transcript' ? transcript.text : null).toBe('');
    expect(sent.filter((f) => f.t === 'audio')).toHaveLength(0);
    const out = logs.join('\n');
    expect(out).toContain('whisper model would not load');
    expect(out).toContain('NO audio was sent upstream');
  });

  it('drops a transcript for an utterance that has already been superseded', async () => {
    let release: ((text: string) => void) | null = null;
    // See the note in listen-playback.test.ts: assigned inside a Promise
    // executor, so it is read through a closure rather than at statement level.
    const settle = (text: string): void => release?.(text);
    const provider: SttProvider = {
      name: 'local-stt',
      caps: sttCaps(true),
      transcribeBuffer: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    };
    const { ready, capture, push, sent } = await runDaemon(EDGE_ON, provider);
    await ready;

    saySomething(capture);
    await vi.waitFor(() => expect(sent.filter((f) => f.t === 'utterance_start')).toHaveLength(1));

    // The turn ends without the recognizer ever coming back — the lane gave up,
    // or the playback watchdog re-armed. The words that arrive afterwards
    // belong to a question nobody is still asking.
    const opened = sent.find((f) => f.t === 'utterance_start');
    const utteranceId = opened?.t === 'utterance_start' ? opened.utteranceId : '';
    push({ t: 'turn_end', utteranceId });
    await new Promise((resolve) => setTimeout(resolve, 5));

    settle('too late to matter');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent.filter((f) => f.t === 'transcript')).toHaveLength(0);
  });
});

describe('a node whose recognizer is not local', () => {
  it('registers edgeStt: false, streams the audio, and the reason names the provider', async () => {
    // The preflight refused it — `enabled: false` with the provider named — so
    // the daemon must not be handed one, and must not claim one.
    const { ready, capture, sent } = await runDaemon({
      edgeStt: {
        requested: true,
        enabled: false,
        providerId: 'openai-stt',
        detail:
          'voice.wake.edgeStt is on, but the recognizer it resolved — "openai-stt" — is not local',
      },
    });
    await ready;

    const register = sent.find((f) => f.t === 'register');
    expect(register?.t).toBe('register');
    expect(register?.t === 'register' ? register.capabilities.edgeStt : 'no register').toBe(false);

    saySomething(capture);
    await vi.waitFor(() => expect(sent.some((f) => f.t === 'utterance_end')).toBe(true));

    // The audio path, unchanged — which is the honest degradation, and the one
    // the doctor row already warned about by name.
    expect(sent.filter((f) => f.t === 'audio').length).toBeGreaterThan(0);
    expect(sent.filter((f) => f.t === 'transcript')).toHaveLength(0);
  });

  it('a preflight that enabled edge STT but handed over no provider still declares false', async () => {
    // Belt and braces: the capability is derived from the provider that is
    // actually in hand, so the two can never disagree on the wire.
    const { ready, sent } = await runDaemon(EDGE_ON);
    await ready;
    const register = sent.find((f) => f.t === 'register');
    expect(register?.t === 'register' ? register.capabilities.edgeStt : 'no register').toBe(false);
  });
});
