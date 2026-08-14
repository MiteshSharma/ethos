// The desktop wake-satellite host: `@ethosagent/voice-satellite` wired into the
// Electron main process, talking to this app's own in-process backend over
// `ws://127.0.0.1:<backendPort>/satellite/ws`.
//
// ── WHAT THIS HOST CAN AND CANNOT DO TODAY ───────────────────────────────────
// It CANNOT listen. The Electron main process ships no microphone binding, and
// adding a per-architecture native audio module is a separate piece of work.
// So the device arrives through the package's `CaptureDevice` seam and there is
// no default implementation: with nothing injected, the preflight fails on a
// `capture-device` probe that says so in words, the host reports `degraded`,
// and NOTHING starts.
//
// That refusal is the feature. The alternative — connecting the lane, showing a
// green dot, and never producing a frame — is the mic-indicator lie this whole
// lane exists to prevent. A room-scale listener that misreports whether it is
// listening is a privacy defect, not a cosmetic one.
//
// Everything downstream of the device IS wired and exercised by tests through
// an injected device and socket: doctor-gated start, the capture machine, the
// node-protocol client, wake → utterance uplink, re-arm on `turn_end`, and the
// persisted wake-enabled state. When a native capture module lands it is one
// argument to `startSatellite`, not a rewrite.
//
// It also cannot PLAY: there is no output device here either, so the node
// registers `playback: false`. The server reads that capability and skips
// synthesis for this node — the turn still runs and the transcript still
// arrives, but no `speak_start`/`audio`/`segment_end` sequence does, so
// `turn_end` is still the last frame of the utterance. That is what makes it a
// sound re-arm cue in `onSpeak` below.
//
// The lane's `reply_text` frame is deliberately NOT consumed here. It exists
// for a node whose only window on the turn is the socket — `ethos listen` on a
// headless Pi prints it, because nothing else would ever show the answer. This
// host is not that: the turn runs on this app's OWN in-process backend, so the
// reply is already in the session the SPA is rendering. Surfacing it a second
// time would mean widening `SatelliteStatus` — a HOST-STATE contract the tray
// reads to pick an icon — into a carrier of conversation content, for a UI that
// already has it.
//
// ── NOTHING HERE MAY CRASH THE APP ───────────────────────────────────────────
// Same posture as `backend.ts`: every entry point catches, logs to
// `<dataDir>/ethos.log`, and degrades. A failing wake stack takes the wake
// feature down and nothing else.

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import {
  type CaptureDevice,
  CaptureMachine,
  type CaptureState,
  createEnergyFrameVad,
  createSatelliteClient,
  createSherpaWakeEngineFactory,
  type DoctorProbeRow,
  runSatelliteDoctor,
  type SatelliteClient,
  type SatelliteSocketFactory,
  type WakeEngine,
  type WakeEngineFactory,
  type WakeMatch,
  type WakeRoute,
} from '@ethosagent/voice-satellite';
import { WebTokenRepository } from '@ethosagent/web-api';
import { SATELLITE_SOCKET_PATH } from '@ethosagent/web-contracts';
import type { SatelliteStatus } from '../shared/ipc-contract';
import { getPort } from './serve';
import { store } from './store';

/** What the mic would capture at. Reported to the server as-is, never guessed up. */
const CAPTURE_SAMPLE_RATE = 16_000;

/** Transducer keyword-spotter model files, relative to `<dataDir>/models/wake`. */
const WAKE_MODEL_FILES = {
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
};

/**
 * Seams. Every one of them has a real production default except `device`,
 * which has none on purpose — see the header.
 */
export interface SatelliteHostDeps {
  device?: CaptureDevice;
  storage?: Storage;
  engineFactories?: readonly WakeEngineFactory[];
  createSocket?: SatelliteSocketFactory;
  gatewayProbe?: () => Promise<{ ok: boolean; detail?: string }>;
}

let status: SatelliteStatus = {
  state: 'stopped',
  wakeEnabled: true,
  nodeId: '',
  capture: null,
  probes: [],
  phrases: [],
};

let client: SatelliteClient | null = null;
let machine: CaptureMachine | null = null;
let engine: WakeEngine | null = null;
let device: CaptureDevice | null = null;
let routes: readonly WakeRoute[] = [];
let engineFactory: WakeEngineFactory | null = null;
let currentUtteranceId: string | null = null;
let audioSeq = 0;
/** Serializes `armCapture` so two routes pushes cannot open two microphones. */
let armChain: Promise<void> = Promise.resolve();

const listeners = new Set<(next: SatelliteStatus) => void>();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getDataDir(): string {
  try {
    return store.get('dataDir') ?? join(homedir(), '.ethos');
  } catch {
    return join(homedir(), '.ethos');
  }
}

/** Mirrors `backend.ts`'s logger: stderr plus the log the error window points at. */
function logSatelliteError(message: string): void {
  process.stderr.write(message);
  try {
    appendFileSync(join(getDataDir(), 'ethos.log'), `${new Date().toISOString()} ${message}`);
  } catch {
    // logging must never throw
  }
}

/**
 * Subscribe to status changes. The tray and the `satellite:stateChanged` push
 * event are both consumers; returns an unsubscribe.
 */
export function onSatelliteStatus(listener: (next: SatelliteStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(patch: Partial<SatelliteStatus>): SatelliteStatus {
  status = { ...status, ...patch };
  for (const listener of listeners) {
    try {
      listener(status);
    } catch (err) {
      // A listener that throws is the tray or the renderer bridge failing. It
      // must not unwind into the capture loop that called us.
      logSatelliteError(`[ethos-satellite] status listener threw: ${errorMessage(err)}\n`);
    }
  }
  return status;
}

/**
 * The node id is PERSISTED, not minted per boot. The gateway's lane key derives
 * from it (`voice:<node>:<personality>`), and a lane key is only useful if it is
 * the same key tomorrow — a fresh id on every restart would fork the
 * conversation and strand yesterday's history under an id nothing asks for
 * again. Generated once, on first run, and then never again.
 */
export function getSatelliteNodeId(): string {
  const saved = store.get('satelliteNodeId');
  if (saved) return saved;
  const generated = randomUUID();
  store.set('satelliteNodeId', generated);
  return generated;
}

function isWakeEnabled(): boolean {
  return store.get('wakeEnabled', true);
}

function resolveEngineFactories(deps: SatelliteHostDeps, storage: Storage): WakeEngineFactory[] {
  if (deps.engineFactories) return [...deps.engineFactories];
  return [
    createSherpaWakeEngineFactory({
      storage,
      modelDir: join(getDataDir(), 'models', 'wake'),
      files: WAKE_MODEL_FILES,
    }),
  ];
}

/**
 * The row doctor cannot produce for us. Its own `microphone` probe SKIPS when no
 * enumerator is wired, and a skipped probe counts as a pass — correct for a host
 * that simply does not own the mic, wrong for this one, which is supposed to.
 */
function missingCaptureDeviceProbe(): DoctorProbeRow {
  return {
    name: 'capture-device',
    ok: false,
    detail:
      'no capture device configured — the Electron main process ships no microphone binding, ' +
      'so this host cannot listen. Run `ethos listen` on a machine with one, or inject a ' +
      'CaptureDevice into startSatellite().',
  };
}

/** Reachability of this app's own in-process backend. */
function defaultGatewayProbe(): Promise<{ ok: boolean; detail?: string }> {
  const port = getPort() ?? store.get('backendPort', 3001);
  return fetch(`http://127.0.0.1:${port}/healthz`)
    .then(() => ({ ok: true, detail: `backend answered on 127.0.0.1:${port}` }))
    .catch((err: unknown) => ({
      ok: false,
      detail: `backend unreachable on 127.0.0.1:${port}: ${errorMessage(err)}`,
    }));
}

/**
 * Run the preflight without starting anything. Backs `satellite:doctor` and the
 * gate inside `startSatellite` — one probe path, so the Settings row and the
 * start decision can never disagree.
 */
export async function probeSatellite(
  deps: SatelliteHostDeps = {},
): Promise<{ ok: boolean; probes: DoctorProbeRow[] }> {
  try {
    const storage = deps.storage ?? new FsStorage();
    const result = await runSatelliteDoctor({
      engineFactories: resolveEngineFactories(deps, storage),
      storage,
      modelDir: join(getDataDir(), 'models', 'wake'),
      gatewayProbe: deps.gatewayProbe ?? defaultGatewayProbe,
      ...(deps.device ? { audioDevice: deps.device } : {}),
    });
    const probes = deps.device ? result.probes : [...result.probes, missingCaptureDeviceProbe()];
    return { ok: probes.every((p) => p.ok), probes };
  } catch (err) {
    // runSatelliteDoctor is documented never to throw; if that ever stops being
    // true the preflight still has to come back as a row rather than a crash.
    return {
      ok: false,
      probes: [{ name: 'doctor', ok: false, detail: `preflight threw: ${errorMessage(err)}` }],
    };
  }
}

/** Map the capture machine's state onto the five states the wire protocol has. */
function wireState(state: CaptureState): 'listening' | 'muted' | 'speaking' | 'degraded' {
  switch (state) {
    case 'muted':
      return 'muted';
    case 'speaking':
      return 'speaking';
    case 'degraded':
      return 'degraded';
    default:
      // idle / listening / capturing / thinking all mean the same thing to a
      // person in the room: the microphone is open.
      return 'listening';
  }
}

async function readAuthCookie(): Promise<string> {
  const tokens = new WebTokenRepository({ dataDir: getDataDir(), storage: new FsStorage() });
  return `ethos_auth=${await tokens.getOrCreate()}`;
}

function onWake(match: WakeMatch): void {
  const routeId = match.routeId;
  const route = routeId === undefined ? undefined : routes.find((r) => r.id === routeId);
  if (route === undefined) {
    // The engine matched a phrase the pushed table no longer has — or, on an
    // engine that names no route at all, nothing this host can attribute. This
    // host declares `phraseMatch: true`, so the server trusts what it sends and
    // does no matching of its own; inventing a personality here would be
    // guessing at which agent the room just addressed.
    logSatelliteError(
      `[ethos-satellite] wake matched ${routeId ?? 'no route'}, which is not in the pushed table\n`,
    );
    return;
  }
  const wakeId = randomUUID();
  currentUtteranceId = randomUUID();
  audioSeq = 0;
  client?.sendWake({
    wakeId,
    phrase: match.phrase,
    routeId: route.id,
    personalityId: route.personalityId,
    confidence: match.confidence,
  });
  client?.sendUtteranceStart({
    wakeId,
    utteranceId: currentUtteranceId,
    sampleRate: CAPTURE_SAMPLE_RATE,
  });
}

/**
 * Build the engine and the capture machine, then open the microphone.
 *
 * Called from `onRoutes` rather than from `start`, because the routing table is
 * gateway-owned and arrives on the socket: the engine cannot be initialized
 * with the phrases it must listen for until the server has said what they are.
 * Re-running it on a later push is how a Settings save reaches a live node.
 */
async function armCapture(settings: {
  sensitivity: number;
  confirmationFrames: number;
  idleTimeoutMs: number;
  wakeEnabled: boolean;
}): Promise<void> {
  const factory = engineFactory;
  const captureDevice = device;
  if (factory === null || captureDevice === null) return;

  // Tear the previous arming down FIRST — a second routes push (a Settings
  // save lands while the node is connected) must replace the engine, not open
  // a second one alongside it holding the same microphone.
  if (machine !== null) {
    machine.stop();
    machine = null;
    await captureDevice.stop();
  }
  if (engine !== null) {
    await engine.dispose();
    engine = null;
  }

  if (!settings.wakeEnabled) {
    // The gateway says the operator switched wake off. The device is not opened
    // at all — muting a live microphone would still have opened it, and "off"
    // has to mean the mic is shut, not that the frames are discarded politely.
    publish({
      state: 'wake_off',
      capture: null,
      reason: 'the gateway reports wake is switched off',
    });
    return;
  }

  const next = factory.create();
  await next.init(routes, {
    sensitivity: settings.sensitivity,
    confirmationFrames: settings.confirmationFrames,
  });
  engine = next;

  const captureMachine = new CaptureMachine(
    {
      engine: next,
      vad: createEnergyFrameVad(),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onWake,
      onAudio: (frame) => {
        if (currentUtteranceId === null) return;
        client?.sendAudio(currentUtteranceId, audioSeq++, frame.samples);
      },
      onUtteranceEnd: () => {
        if (currentUtteranceId === null) return;
        client?.sendUtteranceEnd(currentUtteranceId);
      },
      onStateChange: (state, detail) => {
        // `reason` is set from `detail` unconditionally, including to undefined:
        // the machine's current state is the current truth, and a stale reason
        // left over from a recovered `degraded` transition would keep a row
        // explaining a failure that is no longer happening.
        publish({ capture: state, reason: detail });
        client?.sendState(wireState(state), detail);
      },
    },
    { idleTimeoutMs: settings.idleTimeoutMs },
  );
  machine = captureMachine;

  await captureDevice.start((frame) => captureMachine.pushFrame(frame));
  captureMachine.start();
  publish({ state: 'running', reason: undefined });
}

function degrade(reason: string): void {
  logSatelliteError(`[ethos-satellite] ${reason}\n`);
  publish({ state: 'degraded', reason, capture: null });
}

async function start(deps: SatelliteHostDeps): Promise<SatelliteStatus> {
  if (client !== null) return status;

  const nodeId = getSatelliteNodeId();
  const wakeEnabled = isWakeEnabled();
  publish({ nodeId, wakeEnabled });

  if (!wakeEnabled) {
    // Nothing is probed and nothing is opened. The persisted "off" is the whole
    // answer, and the row says so rather than showing a preflight the user did
    // not ask to run.
    return publish({
      state: 'wake_off',
      capture: null,
      probes: [],
      phrases: [],
      reason: 'wake word is switched off — this setting persists across restarts',
    });
  }

  // Built once and shared with the preflight, so the factory the doctor probed
  // is the same object the engine is created from.
  const storage = deps.storage ?? new FsStorage();
  const factories = resolveEngineFactories(deps, storage);
  const preflight = await probeSatellite({ ...deps, storage, engineFactories: factories });
  publish({ probes: preflight.probes });
  if (!preflight.ok) {
    const failed = preflight.probes.find((p) => !p.ok);
    degrade(failed?.detail ?? `${failed?.name ?? 'preflight'} probe failed`);
    return status;
  }

  const captureDevice = deps.device;
  if (captureDevice === undefined) {
    // Unreachable: a missing device already failed the preflight above. Kept as
    // a narrowing guard rather than a non-null assertion (Biome forbids those).
    degrade(missingCaptureDeviceProbe().detail ?? 'no capture device configured');
    return status;
  }
  device = captureDevice;
  engineFactory = factories[0] ?? null;

  const port = getPort() ?? store.get('backendPort', 3001);
  const authCookie = await readAuthCookie();

  client = createSatelliteClient({
    url: `ws://127.0.0.1:${port}${SATELLITE_SOCKET_PATH}`,
    nodeId,
    displayName: 'Ethos Desktop',
    capabilities: {
      // No on-device STT and no output device in the main process. Both are
      // probed facts, not operator intent: `playback: false` is what stops the
      // server synthesizing audio nothing here could play.
      edgeStt: false,
      playback: false,
      captureSampleRate: CAPTURE_SAMPLE_RATE,
      // This host runs an ACOUSTIC spotter against the pushed table (see
      // `onWake`), so the phrase is matched here and the server re-resolves the
      // route rather than matching the transcript a second time.
      phraseMatch: true,
    },
    wakeEnabled,
    authCookie,
    ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
    // Sent on `ready`, not straight after `connect()`: the socket is not open
    // yet at that point, so the frame would be dropped and the Settings row
    // would show a preflight that never crossed the wire. Re-sent on every
    // reconnect, which is what a row on a restarted gateway needs.
    onReady: () => {
      client?.sendDoctor(preflight.probes.map(({ name, ok, detail }) => ({ name, ok, detail })));
    },
    onRoutes: (frame) => {
      routes = frame.routes;
      publish({ phrases: frame.routes.filter((r) => r.enabled).map((r) => r.phrase) });
      // SERIALIZED. Two pushes in flight (reconnect racing a Settings save)
      // would otherwise interleave two teardown/open sequences over one
      // microphone, and the loser leaves a device open that nothing owns.
      armChain = armChain
        .then(() => armCapture(frame.settings))
        .catch((err: unknown) => {
          degrade(`wake engine failed to arm: ${errorMessage(err)}`);
        });
    },
    onSpeak: (event) => {
      if (event.type === 'turn_end') {
        // This node declared `playback: false`, so `turn_end` is the last thing
        // that will happen for the utterance. Re-arm on it — the machine is in
        // `thinking` and would otherwise drop frames forever.
        machine?.endPlayback();
        currentUtteranceId = null;
        return;
      }
      logSatelliteError(
        `[ethos-satellite] received playout frame '${event.type}' on a node that declared ` +
          'playback: false — dropping it\n',
      );
    },
    onSetWakeEnabled: (enabled) => {
      setWakeEnabled(enabled).catch((err: unknown) => {
        logSatelliteError(`[ethos-satellite] server wake toggle failed: ${errorMessage(err)}\n`);
      });
    },
    onError: (message) => {
      logSatelliteError(`[ethos-satellite] ${message}\n`);
    },
  });
  client.connect();
  return publish({ state: 'running', capture: null, reason: undefined });
}

/**
 * Start the host in whatever state the store persisted. Never throws and never
 * rejects: a satellite failure must not take the app with it.
 */
export async function startSatellite(deps: SatelliteHostDeps = {}): Promise<SatelliteStatus> {
  try {
    return await start(deps);
  } catch (err) {
    degrade(`start failed: ${errorMessage(err)}`);
    return status;
  }
}

/**
 * Run one teardown step, swallowing its failure. Each step is independent
 * because they are NOT a sequence that can be abandoned: a device whose `stop()`
 * throws must not leave the WebSocket open, which is exactly what one shared
 * try/catch around all four would do.
 */
async function tryStep(what: string, step: () => void | Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    logSatelliteError(`[ethos-satellite] ${what} failed during stop: ${errorMessage(err)}\n`);
  }
}

/** Tear the host down. Never throws; leaves the host in `stopped`. */
export async function stopSatellite(): Promise<SatelliteStatus> {
  const [currentMachine, currentDevice, currentEngine, currentClient] = [
    machine,
    device,
    engine,
    client,
  ];
  machine = null;
  engine = null;
  engineFactory = null;
  device = null;
  client = null;
  routes = [];
  currentUtteranceId = null;
  audioSeq = 0;

  await tryStep('capture machine', () => currentMachine?.stop());
  await tryStep('capture device', () => currentDevice?.stop());
  await tryStep('wake engine', () => currentEngine?.dispose());
  await tryStep('socket', () => currentClient?.close());

  return publish({ state: 'stopped', capture: null, phrases: [], reason: undefined });
}

/**
 * Toggle wake. The store write happens FIRST and unconditionally: the honesty
 * criterion is that the persisted state and the indicator agree, and a toggle
 * that only persists once the restart succeeded would leave a mic indicator
 * claiming to listen on the next launch after a failed start.
 */
export async function setWakeEnabled(
  enabled: boolean,
  deps: SatelliteHostDeps = {},
): Promise<SatelliteStatus> {
  store.set('wakeEnabled', enabled);
  publish({ wakeEnabled: enabled });
  await stopSatellite();
  if (!enabled) {
    return publish({
      state: 'wake_off',
      capture: null,
      probes: [],
      reason: 'wake word is switched off — this setting persists across restarts',
    });
  }
  return startSatellite(deps);
}

export function getSatelliteStatus(): SatelliteStatus {
  return status;
}

/** Test seam: drop every module-level handle so cases cannot bleed into each other. */
export function __resetSatelliteForTests(): void {
  machine = null;
  engine = null;
  engineFactory = null;
  device = null;
  client = null;
  routes = [];
  currentUtteranceId = null;
  audioSeq = 0;
  armChain = Promise.resolve();
  listeners.clear();
  status = {
    state: 'stopped',
    wakeEnabled: true,
    nodeId: '',
    capture: null,
    probes: [],
    phrases: [],
  };
}
