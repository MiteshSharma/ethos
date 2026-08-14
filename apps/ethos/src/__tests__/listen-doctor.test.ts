// `ethos listen doctor` — the exit-code matrix, and the false-available case.
//
// The criterion this file exists for (voice V3, eng-review D10): with a
// corrupted or missing model, doctor reports UNAVAILABLE rather than "ok", the
// host degrades, and nothing crashes. Everything below drives the real probe
// runner from `@ethosagent/voice-satellite` with injected factories and an
// `InMemoryStorage`, so the rows are produced the way production produces them.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { WakeEngine, WakeEngineFactory, WakeRoute } from '@ethosagent/voice-satellite';
import { runSatelliteDoctor, transcriptWakeEngineFactory } from '@ethosagent/voice-satellite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseRoute,
  computeListenExit,
  deriveListenFailFlags,
  deriveListenUrls,
  LANE_PROBE_NAME,
  type ListenCommandDeps,
  type ListenPreflight,
  probeHealthz,
  probeSatelliteLane,
  runListenCommand,
  withLaneProbeName,
} from '../commands/listen';

const MODEL_DIR = '/home/pi/.ethos/models/wake';

function unusableEngine(): WakeEngine {
  return {
    name: 'broken',
    async init(): Promise<void> {},
    push: () => null,
    reset(): void {},
    async dispose(): Promise<void> {},
  };
}

/** An engine whose native import blows up — the wrong-arch ONNX binary case. */
const throwingFactory: WakeEngineFactory = {
  name: 'sherpa',
  async probe() {
    throw new Error('dlopen failed: wrong architecture');
  },
  create: unusableEngine,
};

/** An engine whose probe returns not-ok because a model file is absent. */
const missingModelFactory: WakeEngineFactory = {
  name: 'sherpa',
  async probe() {
    return {
      ok: false,
      engine: 'sherpa',
      detail: `wake model file missing — ${MODEL_DIR}/encoder.onnx`,
    };
  },
  create: unusableEngine,
};

function preflightFrom(
  probes: ListenPreflight['probes'],
  overrides: Partial<ListenPreflight> = {},
): ListenPreflight {
  return {
    // Through the same rename production applies: the shared doctor calls the
    // reachability row `gateway`, this host calls it `satellite-lane`.
    probes: withLaneProbeName(probes),
    configuredEngine: 'transcript',
    transcriptEngineOk: probes.some((p) => p.name === 'engine:transcript' && p.ok),
    modelsRequired: false,
    url: 'ws://127.0.0.1:3000/satellite/ws',
    healthUrl: 'http://127.0.0.1:3000/healthz',
    nodeId: 'pi-1',
    routes: [],
    edgeSttRequested: false,
    device: null,
    sampleRate: 16_000,
    errors: [],
    deprecations: [],
    ...overrides,
  };
}

async function storageWithModels(): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(MODEL_DIR);
  await storage.write(`${MODEL_DIR}/encoder.onnx`, 'x');
  await storage.write(`${MODEL_DIR}/tokens.txt`, 'x');
  return storage;
}

describe('exit-code matrix', () => {
  it('all pass → 0', () => {
    expect(
      computeListenExit({
        engineFailed: false,
        modelsMissing: false,
        micUnavailable: false,
        serverUnreachable: false,
        setupError: false,
      }),
    ).toBe(0);
  });

  it('a failed engine import → 1', () => {
    expect(
      computeListenExit({
        engineFailed: true,
        modelsMissing: false,
        micUnavailable: false,
        serverUnreachable: false,
        setupError: false,
      }),
    ).toBe(1);
  });

  it('a missing model → 1', () => {
    expect(
      computeListenExit({
        engineFailed: false,
        modelsMissing: true,
        micUnavailable: false,
        serverUnreachable: false,
        setupError: false,
      }),
    ).toBe(1);
  });

  it('an unenumerable mic → 2', () => {
    expect(
      computeListenExit({
        engineFailed: false,
        modelsMissing: false,
        micUnavailable: true,
        serverUnreachable: false,
        setupError: false,
      }),
    ).toBe(2);
  });

  it('an unreachable server → 2', () => {
    expect(
      computeListenExit({
        engineFailed: false,
        modelsMissing: false,
        micUnavailable: false,
        serverUnreachable: true,
        setupError: false,
      }),
    ).toBe(2);
  });

  it('a hard failure outranks a warn', () => {
    expect(
      computeListenExit({
        engineFailed: true,
        modelsMissing: false,
        micUnavailable: true,
        serverUnreachable: true,
        setupError: false,
      }),
    ).toBe(1);
  });
});

describe('probes → flags', () => {
  it('all probes pass on a healthy transcript-engine host', async () => {
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: async () => ({ ok: true, detail: 'answered 200' }),
    });
    expect(result.ok).toBe(true);
    expect(computeListenExit(deriveListenFailFlags(preflightFrom(result.probes)))).toBe(0);
  });

  it('an engine whose probe THREW is a hard fail, and carries the message', async () => {
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [throwingFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: async () => ({ ok: true }),
    });
    const row = result.probes.find((p) => p.name === 'engine:sherpa');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain('wrong architecture');
    const flags = deriveListenFailFlags(
      preflightFrom(result.probes, { configuredEngine: 'sherpa' }),
    );
    expect(flags.engineFailed).toBe(true);
    expect(computeListenExit(flags)).toBe(1);
  });

  it('a mic that cannot be enumerated right now is a warn, not a hard fail', async () => {
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [] },
      gatewayProbe: async () => ({ ok: true }),
    });
    const flags = deriveListenFailFlags(preflightFrom(result.probes));
    expect(flags.micUnavailable).toBe(true);
    expect(flags.engineFailed).toBe(false);
    expect(computeListenExit(flags)).toBe(2);
  });

  it('an unreachable server is a warn', async () => {
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: async () => ({ ok: false, detail: 'ECONNREFUSED' }),
    });
    expect(computeListenExit(deriveListenFailFlags(preflightFrom(result.probes)))).toBe(2);
  });

  it('a skipped probe never fails a preflight it never performed', async () => {
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
    });
    const flags = deriveListenFailFlags(preflightFrom(result.probes));
    expect(flags.micUnavailable).toBe(false);
    expect(flags.serverUnreachable).toBe(false);
    expect(computeListenExit(flags)).toBe(0);
  });
});

describe('the false-available case (eng-review D10)', () => {
  it('a MISSING model file reports unavailable, not ok', async () => {
    // Nothing was ever written to the model directory.
    const storage = new InMemoryStorage();
    const result = await runSatelliteDoctor({
      engineFactories: [missingModelFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: async () => ({ ok: true }),
    });

    expect(result.ok).toBe(false);
    const engineRow = result.probes.find((p) => p.name === 'engine:sherpa');
    expect(engineRow?.ok).toBe(false);
    expect(engineRow?.detail).toContain('model file missing');
    const modelRow = result.probes.find((p) => p.name === 'models');
    expect(modelRow?.ok).toBe(false);

    const flags = deriveListenFailFlags(
      preflightFrom(result.probes, { configuredEngine: 'sherpa', modelsRequired: true }),
    );
    expect(flags.engineFailed).toBe(true);
    expect(flags.modelsMissing).toBe(true);
    expect(computeListenExit(flags)).toBe(1);
  });

  it('an empty model directory reports unavailable rather than "0 files, fine"', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(MODEL_DIR);
    const result = await runSatelliteDoctor({
      engineFactories: [missingModelFactory],
      storage,
      modelDir: MODEL_DIR,
    });
    expect(result.probes.find((p) => p.name === 'models')?.ok).toBe(false);
  });

  it('a model directory that is missing is NOT fatal for the transcript engine', async () => {
    // The transcript engine opens no model files. The shared doctor probes the
    // directory anyway (most satellite hosts run an acoustic engine); this host
    // knows which engine it will run, so the row is reported and not counted.
    const storage = new InMemoryStorage();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: async () => ({ ok: true }),
    });
    expect(result.probes.find((p) => p.name === 'models')?.ok).toBe(false);
    const flags = deriveListenFailFlags(preflightFrom(result.probes, { modelsRequired: false }));
    expect(flags.modelsMissing).toBe(false);
    expect(computeListenExit(flags)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route resolution — against the table the SERVER pushed, never the local file
// ---------------------------------------------------------------------------

function route(overrides: Partial<WakeRoute> & { id: string }): WakeRoute {
  return {
    phrase: `hey ${overrides.id}`,
    personalityId: overrides.id,
    privileged: false,
    enabled: true,
    ...overrides,
  };
}

describe('chooseRoute against the pushed table', () => {
  it('one pushed route needs no --route', () => {
    const only = route({ id: 'auto:engineer', phrase: 'hey engineer', personalityId: 'engineer' });
    expect(chooseRoute([only], undefined).route).toEqual(only);
  });

  it('several pushed routes refuse to be guessed between, and are listed', () => {
    const chosen = chooseRoute([route({ id: 'auto:engineer' }), route({ id: 'eng' })], undefined);
    expect(chosen.route).toBeNull();
    expect(chosen.problem).toContain('--route');
    expect(chosen.problem).toContain('auto:engineer');
    expect(chosen.problem).toContain('eng');
  });

  it('an EMPTY pushed table is the real dead end, and says why', () => {
    const chosen = chooseRoute([], undefined);
    expect(chosen.route).toBeNull();
    // The honest diagnosis: not "you configured nothing" but "there is nothing
    // reachable", because every unprivileged personality would have been there.
    expect(chosen.problem).toContain('privileged');
    expect(chosen.problem).toContain('by design');
    expect(chosen.problem).not.toContain('the convention is');
  });

  it('accepts a synthesized auto:<personalityId> id — the config charset never applies', () => {
    const auto = route({ id: 'auto:engineer', phrase: 'hey engineer', personalityId: 'engineer' });
    expect(chooseRoute([auto, route({ id: 'auto:writer' })], 'auto:engineer').route).toEqual(auto);
  });

  it('a typo still fails loudly — against the pushed table, not the config file', () => {
    const chosen = chooseRoute([route({ id: 'auto:engineer' })], 'auto:enginer');
    expect(chosen.route).toBeNull();
    expect(chosen.problem).toContain("no enabled route 'auto:enginer'");
    expect(chosen.problem).toContain('auto:engineer');
    expect(chosen.problem).not.toContain('voice.wake.routes');
  });

  it('a disabled route in the pushed table is not selectable', () => {
    const off = route({ id: 'eng', enabled: false });
    expect(chooseRoute([off], undefined).route).toBeNull();
    expect(chooseRoute([off], 'eng').route).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server reachability — the WS lane, not the channel gateway
// ---------------------------------------------------------------------------

/** A one-off server. `onUpgrade` absent means Node closes upgrade sockets. */
async function serverWith(opts: {
  onUpgrade?: (socket: { write(s: string): void; destroy(): void }) => void;
  healthz?: { status: number; body: unknown };
}): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    const health = opts.healthz;
    if (!health) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(health.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health.body));
  });
  if (opts.onUpgrade) {
    const handle = opts.onUpgrade;
    server.on('upgrade', (_req, socket) => handle(socket));
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('probeSatelliteLane', () => {
  it('a 401 to an unauthenticated upgrade IS the healthy answer', async () => {
    const server = await serverWith({
      onUpgrade: (socket) => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      },
    });
    const result = await probeSatelliteLane(
      `ws://127.0.0.1:${server.port}/satellite/ws`,
      `http://127.0.0.1:${server.port}/healthz`,
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('/satellite/ws');
    expect(result.detail).toContain('401');
    await server.close();
  });

  it('a 404 on the lane is a real failure — /healthz could never have said so', async () => {
    const server = await serverWith({
      onUpgrade: (socket) => {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      },
      healthz: { status: 200, body: { status: 'ok' } },
    });
    const result = await probeSatelliteLane(
      `ws://127.0.0.1:${server.port}/satellite/ws`,
      `http://127.0.0.1:${server.port}/healthz`,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no satellite lane');
    await server.close();
  });

  it('an inconclusive upgrade falls back to /healthz, and a down GATEWAY is still OK', async () => {
    // The real-world shape: `ethos serve` is healthy, no Telegram/Slack adapter
    // is running, so /healthz answers 503. A satellite does not use the channel
    // gateway for anything, so this must not scare the operator with a ⚠.
    const server = await serverWith({
      healthz: {
        status: 503,
        body: {
          status: 'degraded',
          uptime: 70133,
          gateway: { status: 'down', adapters: [], lastHeartbeatAgeSec: null },
        },
      },
    });
    const result = await probeSatelliteLane(
      `ws://127.0.0.1:${server.port}/satellite/ws`,
      `http://127.0.0.1:${server.port}/healthz`,
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('channel gateway');
    expect(result.detail).toContain('does not need');
    await server.close();
  });

  it('nothing listening at all is still a failure', async () => {
    // Bind and immediately release, so the port is known-dead rather than guessed.
    const server = await serverWith({});
    const { port } = server;
    await server.close();
    const result = await probeSatelliteLane(
      `ws://127.0.0.1:${port}/satellite/ws`,
      `http://127.0.0.1:${port}/healthz`,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`${port}`);
  });
});

// ---------------------------------------------------------------------------
// The diagnosis itself — the row cost a real user a debugging round because it
// said `…/satellite/ws: ; http://…/healthz: fetch failed`: an empty reason, an
// opaque undici wrapper, and the same cause printed twice.
// ---------------------------------------------------------------------------

/** A port nothing is on: bind, read the number, release. */
async function deadPort(): Promise<number> {
  const server = await serverWith({});
  const { port } = server;
  await server.close();
  return port;
}

describe('a refused connection says WHY, and what to do about it', () => {
  it('names the errno, the cause, and the remedy — and never says `fetch failed`', async () => {
    const port = await deadPort();
    const result = await probeSatelliteLane(
      `ws://127.0.0.1:${port}/satellite/ws`,
      `http://127.0.0.1:${port}/healthz`,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).not.toBe('');
    expect(result.detail).toContain('ECONNREFUSED');
    expect(result.detail).toContain('refused');
    // The remedy, because "the server is not running" is the answer nine times
    // in ten and the operator should not have to go and look it up.
    expect(result.detail).toContain('ethos serve');
    // undici's opaque lid. If this string is back, the unwrap regressed.
    expect(result.detail).not.toContain('fetch failed');
    expect(result.code).toBe('ECONNREFUSED');
  });

  it('reports the cause ONCE — no `a; b` with the same failure on both sides', async () => {
    const port = await deadPort();
    const result = await probeSatelliteLane(
      `ws://127.0.0.1:${port}/satellite/ws`,
      `http://127.0.0.1:${port}/healthz`,
    );
    // /healthz rides the same transport to the same port, so it can only fail
    // the same way. It must not be dialled, let alone concatenated on.
    expect(result.detail).not.toContain('/healthz');
    expect(result.detail.match(/ECONNREFUSED/g)).toHaveLength(1);
  });

  it('a dual-stack `localhost` refusal is not the empty string', async () => {
    // The original defect: `net.connect` to a name that resolves to both ::1
    // and 127.0.0.1 rejects with an AggregateError whose OWN message is '', so
    // the row printed a bare `:` followed by `;`.
    const port = await deadPort();
    const result = await probeSatelliteLane(
      `ws://localhost:${port}/satellite/ws`,
      `http://localhost:${port}/healthz`,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).not.toBe('');
    expect(result.detail).not.toMatch(/:\s*;/);
    expect(result.detail).toContain('ECONNREFUSED');
    expect(result.code).toBe('ECONNREFUSED');
  });

  it('the 404 "no satellite lane" diagnosis survives, code and all', async () => {
    const server = await serverWith({
      onUpgrade: (socket) => {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      },
      healthz: { status: 200, body: { status: 'ok' } },
    });
    const result = await probeSatelliteLane(
      `ws://127.0.0.1:${server.port}/satellite/ws`,
      `http://127.0.0.1:${server.port}/healthz`,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no satellite lane');
    expect(result.detail).not.toContain('ECONNREFUSED');
    expect(result.code).toBe('NO_SATELLITE_LANE');
    await server.close();
  });

  it('no probe row ever carries an empty detail', async () => {
    const port = await deadPort();
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: () =>
        probeSatelliteLane(
          `ws://127.0.0.1:${port}/satellite/ws`,
          `http://127.0.0.1:${port}/healthz`,
        ),
    });
    for (const row of result.probes) {
      expect(row.detail, `probe '${row.name}' reported a failure with no reason`).not.toBe('');
    }
  });
});

describe('the reachability row is not called `gateway`', () => {
  it('the row a satellite host reads is the lane, under the lane’s name', async () => {
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: async () => ({ ok: false, detail: 'down' }),
    });
    const names = withLaneProbeName(result.probes).map((p) => p.name);
    expect(names).toContain(LANE_PROBE_NAME);
    // A row saying `gateway` sends the operator off to look at a Telegram bot.
    expect(names).not.toContain('gateway');
  });

  it('an unreachable lane still drives serverUnreachable under the new name', async () => {
    const storage = await storageWithModels();
    const result = await runSatelliteDoctor({
      engineFactories: [transcriptWakeEngineFactory],
      storage,
      modelDir: MODEL_DIR,
      audioDevice: { list: async () => [{ id: 'stdin', label: 'stdin' }] },
      gatewayProbe: async () => ({ ok: false, detail: 'down' }),
    });
    const flags = deriveListenFailFlags(preflightFrom(result.probes));
    expect(flags.serverUnreachable).toBe(true);
    expect(computeListenExit(flags)).toBe(2);
  });
});

describe('--json carries the machine-readable reason', () => {
  let stdout: string[];

  beforeEach(() => {
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('the refused case carries the errno on the lane probe', async () => {
    const pre = preflightFrom(
      [
        { name: 'engine:transcript', ok: true, detail: 'no native bindings' },
        { name: 'models', ok: true, detail: '2 file(s)' },
        { name: 'microphone', ok: true, detail: '1 input device(s): stdin' },
        {
          name: LANE_PROBE_NAME,
          ok: false,
          detail:
            'ws://127.0.0.1:3000/satellite/ws: connection refused (ECONNREFUSED) — ' +
            'nothing is listening there, so the server is not running. Start it with `ethos serve`.',
        },
      ],
      { laneFailureCode: 'ECONNREFUSED' },
    );
    const deps: ListenCommandDeps = { preflight: async () => pre, start: async () => {} };

    await runListenCommand(['doctor', '--json'], deps);

    const parsed = JSON.parse(stdout[0] ?? '') as {
      exit: number;
      probes: Array<{ name: string; ok: boolean; detail?: string; code?: string }>;
    };
    const lane = parsed.probes.find((p) => p.name === LANE_PROBE_NAME);
    expect(lane?.ok).toBe(false);
    expect(lane?.code).toBe('ECONNREFUSED');
    expect(lane?.detail).toContain('ethos serve');
    expect(parsed.probes.map((p) => p.name)).not.toContain('gateway');
    expect(parsed.exit).toBe(2);
  });

  it('a reachable lane carries no code at all', async () => {
    const pre = preflightFrom([
      { name: 'engine:transcript', ok: true, detail: 'no native bindings' },
      { name: 'models', ok: true, detail: '2 file(s)' },
      { name: 'microphone', ok: true, detail: '1 input device(s): stdin' },
      { name: LANE_PROBE_NAME, ok: true, detail: 'accepted the upgrade' },
    ]);
    const deps: ListenCommandDeps = { preflight: async () => pre, start: async () => {} };

    await runListenCommand(['doctor', '--json'], deps);

    const parsed = JSON.parse(stdout[0] ?? '') as {
      probes: Array<{ name: string; code?: string }>;
    };
    expect(parsed.probes.find((p) => p.name === LANE_PROBE_NAME)?.code).toBeUndefined();
  });
});

describe('probeHealthz reads the body, not just the status code', () => {
  it('503 caused only by the channel gateway is reachable', async () => {
    const server = await serverWith({
      healthz: {
        status: 503,
        body: { status: 'degraded', uptime: 1, gateway: { status: 'down', adapters: [] } },
      },
    });
    const result = await probeHealthz(`http://127.0.0.1:${server.port}/healthz`);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('web-api is up');
    await server.close();
  });

  it('a 5xx that is not that shape stays a failure', async () => {
    const server = await serverWith({ healthz: { status: 500, body: { boom: true } } });
    const result = await probeHealthz(`http://127.0.0.1:${server.port}/healthz`);
    expect(result.ok).toBe(false);
    await server.close();
  });

  it('200 is reachable', async () => {
    const server = await serverWith({ healthz: { status: 200, body: { status: 'ok' } } });
    expect((await probeHealthz(`http://127.0.0.1:${server.port}/healthz`)).ok).toBe(true);
    await server.close();
  });
});

describe('deriveListenUrls', () => {
  it('defaults to the loopback serve port', () => {
    expect(deriveListenUrls(undefined)).toEqual({
      socket: 'ws://127.0.0.1:3000/satellite/ws',
      health: 'http://127.0.0.1:3000/healthz',
    });
  });

  it('upgrades an https base to wss', () => {
    expect(deriveListenUrls('https://ethos.example.com').socket).toBe(
      'wss://ethos.example.com/satellite/ws',
    );
  });

  it('appends the lane path to a bare --url origin', () => {
    expect(deriveListenUrls(undefined, 'ws://pi.local:3000').socket).toBe(
      'ws://pi.local:3000/satellite/ws',
    );
  });

  it('keeps an explicit path on --url', () => {
    expect(deriveListenUrls(undefined, 'ws://pi.local:3000/edge/ws').socket).toBe(
      'ws://pi.local:3000/edge/ws',
    );
  });
});
