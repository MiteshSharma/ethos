// `ethos listen` — the headless wake satellite, and `ethos listen doctor`, its
// preflight (voice V3, lane S5).
//
// ── THE TWO RULES THIS FILE EXISTS TO HOLD ───────────────────────────────────
//
// 1. NEVER PRETEND TO LISTEN. Every failure that would leave this daemon deaf —
//    a wake engine that will not load, a model file that never finished
//    downloading, a stdin with nothing piped into it — is reported before the
//    process settles into its keep-alive, and either degrades the host into a
//    state it announces out loud or refuses to start at all. A satellite that
//    prints "listening" and hears nothing is worse than one that exits: nobody
//    walks over to a machine that looks fine.
//
// 2. AVAILABILITY ONLY AFTER A REAL PROBE. The rows come from
//    `runSatelliteDoctor`, which asks the engine factory to load what it would
//    load and the device to enumerate what it would open. Nothing here reads a
//    config flag and calls it capability.
//
// ── WHAT THIS HOST CAN AND CANNOT DO ─────────────────────────────────────────
//
// CAPTURE IS A PIPE. `apps/ethos` has no audio binding and this lane does not
// add one: a native microphone module is a per-architecture binary, and this is
// the daemon that has to run on the Pi where such a binary is broken. So the
// operator supplies samples on stdin and the pipe is the device —
// `ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen`
// works today with nothing installed that is not installed already. See
// `../lib/stdin-pcm-device`.
//
// THE MIC IS OPEN, AND THE SERVER DECIDES WHO WAS ADDRESSED. This host matches
// no phrase against sound: an acoustic keyword spotter is a per-architecture
// native binary, and this is the daemon that has to run on the Pi where such a
// binary is broken. The always-available `transcript` engine matches RECOGNIZED
// TEXT, and this host ships no on-device recognizer — the SERVER transcribes,
// which is far too late to be a client-side wake decision.
//
// So the daemon registers `phraseMatch: false` and the gate moves to where the
// transcript already is. Speech detected on the pipe opens an utterance; every
// utterance is transcribed; and the server runs a turn only when the words open
// with a wake phrase from the effective route table, or when they follow one
// inside the addressing window. Everything else is heard, written down, and
// discarded without reaching a model.
//
// That is worth being blunt about, because it is a privacy fact: THE ROOM IS
// TRANSCRIBED. Not every utterance reaches an agent, but every utterance
// reaches speech recognition. A host that implied otherwise would be claiming
// an acoustic gate it does not have.
//
// Acoustic wake (sherpa keyword spotting) belongs to the desktop host, which
// has the prebuilt binaries and a real microphone, and which therefore
// registers `phraseMatch: true` and is not gated server-side. `listen doctor`
// still probes sherpa honestly when it is configured — those rows feed the
// Settings → Voice row for every host, not just this one.
//
// THE ROUTE TABLE BELONGS TO THE SERVER. `voice.wake.routes` in this machine's
// config is a HINT, not the answer: the web-api synthesizes a "hey <name>"
// route (`auto:<personalityId>`) for every UNPRIVILEGED personality and pushes
// the merged table down the lane immediately after `register`. This daemon
// never picks a personality — the phrase does — so `--route` is optional and
// means something narrower than it used to: a PIN, restricting which single
// route this microphone may be addressed by. `listen doctor`, which never
// connects, reports the local table as a hint and says out loud that the
// effective one is only knowable once connected.

import { randomBytes, randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { ethosDir, loadConfigStrict, type WakeRouteConfig } from '@ethosagent/config';
import { EthosError, type Storage } from '@ethosagent/types';
import {
  type AudioDeviceInfo,
  type CaptureDevice,
  CaptureMachine,
  type CaptureState,
  createEnergyFrameVad,
  createSatelliteClient,
  createSherpaWakeEngineFactory,
  type DoctorProbeRow,
  runSatelliteDoctor,
  type SatelliteSocketFactory,
  transcriptWakeEngineFactory,
  type WakeEngine,
  type WakeEngineFactory,
  type WakeRoute,
} from '@ethosagent/voice-satellite';
import { SATELLITE_SOCKET_PATH } from '@ethosagent/web-contracts';
import { createStdinPcmDevice, STDIN_DEVICE_ID } from '../lib/stdin-pcm-device';
import { emitReady } from '../logger';
import { notifyReady, startWatchdog } from '../sd-notify';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

export const USAGE = `Usage: ethos listen [doctor] [options]

  (no subcommand)   run the wake satellite in the foreground
  doctor            preflight: engine, model files, capture device, satellite lane

Options:
  --url <ws url>    satellite lane URL (default: derived from webBaseUrl)
  --route <id>      PIN this microphone to one route: only that phrase may
                    address it. Checked against the table the server pushes on
                    connect — a voice.wake.routes id or a synthesized
                    'auto:<personalityId>' one. Optional; without it every
                    phrase in the table can address this host
  --device <id>     capture device (this build ships '${STDIN_DEVICE_ID}' only)
  --json            doctor only — one JSON object with a probes array and exit

Capture is a pipe. This daemon reads raw signed-16-bit little-endian MONO PCM
from stdin, so a microphone is whatever can write that:

  ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar 16000 -ac 1 -f s16le - | ethos listen
  arecord -q -f S16_LE -r 16000 -c 1 -t raw                                        | ethos listen

Keep the quiet flags. The capture process and this daemon share one terminal,
and ffmpeg's progress meter is a carriage-returned line that overwrites this
daemon's output mid-word. A real failure still prints.

Open mic, server-side addressing. Nothing is acoustically wake-matched here:
EVERY utterance on the pipe is transcribed by the server. It runs a turn only
when the words open with a wake phrase — that phrase picks the personality —
or when they follow one within voice.wake.idleTimeout. Anything else is heard
and discarded. Stop the pipe to stop talking.`;

/**
 * Rate the wake engines, the VAD, and the server-side recognizers all assume.
 * Fixed rather than configurable: raw PCM carries no header, so a mismatch
 * between what the operator piped and what we declare is undetectable, and the
 * only defence is one number printed in the help text next to the ffmpeg flags.
 */
const CAPTURE_SAMPLE_RATE = 16_000;

/** Frame length. 20ms is `EnergyVad`'s unit and the wake seam's. */
const CAPTURE_FRAME_MS = 20;

/** Same cadence as the gateway heartbeat — the readers are the same readers. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Fallback for the addressing window in the banner, matching the server's own
 * `WAKE_SETTINGS_DEFAULTS.idleTimeoutMs`. Only ever printed before the first
 * `routes` frame lands — after that the SERVER's number is used, because the
 * server is the one enforcing it.
 */
const DEFAULT_IDLE_WINDOW_MS = 30_000;

/** `ethos serve --web-port` default. Mirrors WEB_PORT_DEFAULT in serve.ts. */
const DEFAULT_WEB_PORT = 3000;

/**
 * What this host calls the reachability row — in the printed row, the `--json`
 * probe name, and the prose.
 *
 * NOT `gateway`, which is what the shared satellite doctor still names it. That
 * name was true when the row probed `/healthz`; it stopped being true when the
 * probe was repointed at `/satellite/ws` (see `probeSatelliteLane`), and a row
 * labelled `gateway` sends an operator whose satellite cannot connect off to
 * look at their Telegram bot. The rename happens once, in `realPreflight`, so
 * everything downstream — the row, the flags, the JSON — agrees.
 */
export const LANE_PROBE_NAME = 'satellite-lane';

/** The shared doctor's name for the row `LANE_PROBE_NAME` replaces. */
const SHARED_DOCTOR_LANE_PROBE_NAME = 'gateway';

/** The shared doctor's rows, under the names this host prints and reports. */
export function withLaneProbeName(probes: readonly DoctorProbeRow[]): DoctorProbeRow[] {
  return probes.map((p) =>
    p.name === SHARED_DOCTOR_LANE_PROBE_NAME ? { ...p, name: LANE_PROBE_NAME } : p,
  );
}

/** How a local server is started. Named wherever a probe says one is missing. */
const START_THE_SERVER = 'Start it with `ethos serve`.';

/**
 * The one sentence every surface that talks about routes without a connection
 * has to say. Written once so the doctor row, the `--json` object, and the
 * daemon's banner cannot drift into three different claims.
 */
const ROUTES_ARE_THE_SERVERS =
  'The effective table is the server\'s: it adds a "hey <name>" route ' +
  '(auto:<personalityId>) for every unprivileged personality, pushes the merged ' +
  'table on connect, and MATCHES transcripts against it — so what this host can ' +
  'be addressed by is only knowable once it has connected.';

/** Where wake / edge-STT models are expected, per the satellite doctor's own tests. */
function wakeModelDir(): string {
  return join(ethosDir(), 'models', 'wake');
}

/** Composed once, then persisted verbatim. See `resolveListenNodeId`. */
function listenNodeIdPath(): string {
  return join(ethosDir(), 'listen-node-id');
}

/** Same contract and cadence as `gateway-health.json`; see `buildListenHeartbeat`. */
function listenHealthPath(): string {
  return join(ethosDir(), 'listen-health.json');
}

/**
 * Conventional sherpa transducer file names inside `wakeModelDir()`.
 *
 * Not configurable, deliberately: a per-file path knob is four more ways for a
 * model download to be half-configured, and the failure it would enable —
 * "three of the four files resolved" — is exactly the class this preflight is
 * here to catch. Rename the files or symlink them.
 */
const SHERPA_MODEL_FILES = {
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
};

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface ListenFlags {
  json: boolean;
  url?: string;
  route?: string;
  device?: string;
  positional: string[];
}

export function parseListenFlags(args: string[]): ListenFlags {
  const flags: ListenFlags = { json: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--url') flags.url = args[++i];
    else if (a === '--route') flags.route = args[++i];
    else if (a === '--device') flags.device = args[++i];
    else if (a !== undefined) flags.positional.push(a);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Preflight result — everything both the doctor and the banner render
// ---------------------------------------------------------------------------

export interface ListenPreflight {
  /** One row per probe, straight from `runSatelliteDoctor`. */
  probes: DoctorProbeRow[];
  /** `voice.wake.engine`, normalized to the engine's own name. */
  configuredEngine: string;
  /**
   * True when `transcriptWakeEngineFactory` probed OK — the dependency-free
   * engine every build is supposed to have.
   *
   * The daemon does not run it (it runs the open-mic engine and the SERVER
   * matches phrases), but its probe is the floor: it loads no binding and no
   * model, so a failure there means the satellite package itself is broken on
   * this host and nothing about the wake stack can be believed. That is the
   * one failure this command refuses to start through.
   */
  transcriptEngineOk: boolean;
  /**
   * True when the configured engine reads model files. The shared doctor probes
   * the model directory unconditionally because most satellite hosts run an
   * acoustic engine; this host knows which engine it will run, so it — not the
   * shared probe — decides whether an empty model directory is fatal.
   */
  modelsRequired: boolean;
  /** Satellite lane URL the daemon would connect to. */
  url: string;
  /** HTTP health URL the lane probe falls back to. */
  healthUrl: string;
  /**
   * Why the `satellite-lane` row failed, in a form a script can branch on: the
   * errno where the failure had one (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`),
   * or a probe token where it did not (`NO_SATELLITE_LANE`, `HTTP_500`).
   *
   * Carried beside the probes rather than on them because `DoctorProbeRow` is
   * the satellite wire shape — `{name, ok, detail}` and nothing else — and the
   * shared doctor drops any field it does not know. Absent when the lane is
   * reachable, or when no probe ran.
   */
  laneFailureCode?: string;
  /** Stable across restarts. See `resolveListenNodeId`. */
  nodeId: string;
  /**
   * Enabled `voice.wake.routes` entries from the LOCAL config, id-ordered.
   *
   * A HINT, NOT THE TABLE. The effective table is the server's — it merges
   * these with a synthesized `auto:<personalityId>` route per unprivileged
   * personality and pushes the result on connect — so an empty list here says
   * nothing about what this deployment answers to. The daemon resolves its
   * route against the pushed table; this field only tells the operator what
   * their own file contributes.
   */
  routes: WakeRoute[];
  /** `--route`, unresolved: only the pushed table can validate the pin. */
  requestedRoute?: string;
  /** `voice.wake.edgeStt` is on but this host ships no on-device recognizer. */
  edgeSttRequested: boolean;
  /** The capture device that would be opened, or null when there is none. */
  device: AudioDeviceInfo | null;
  sampleRate: number;
  /**
   * `voice.wake.idleTimeout`, in ms. Ends LISTENING only, never the session.
   * Absent when the operator set none — `CaptureMachine` owns that default.
   */
  idleTimeoutMs?: number;
  /** Setup failures that are not probes: no config, bad `--url`, unknown `--device`. */
  errors: string[];
  /** Config deprecations, surfaced before anything else runs. */
  deprecations: string[];
}

export interface ListenStartOptions {
  /** Fired once the daemon is fully up, before the keep-alive. Test seam. */
  onReady?: () => void;
  /**
   * Transport for the satellite client. Test seam — production leaves it unset
   * and gets the `ws` socket. Supplying it also skips the auth-cookie lookup:
   * an injected transport is not talking to a real `/satellite/ws`, and the
   * lookup lazily pulls in the whole web-api module graph.
   */
  createSocket?: SatelliteSocketFactory;
}

/** The seam that makes the sub-router drivable without booting anything. */
export interface ListenCommandDeps {
  /** Runs every probe and resolves the context they describe. Never throws. */
  preflight(flags: ListenFlags): Promise<ListenPreflight>;
  /** Boots the daemon. Returns only on shutdown. */
  start(preflight: ListenPreflight, flags: ListenFlags): Promise<void>;
}

// ---------------------------------------------------------------------------
// Exit codes — a sibling of `computeDoctorExit`, not a reshaping of it
// ---------------------------------------------------------------------------

/**
 * `ethos doctor`'s flag shape is about SDKs, secrets, and channel tokens; none
 * of its seven fields name a thing this preflight probes, and widening it so a
 * missing wake model could be squeezed into `configuredMissing` would make both
 * commands harder to read. So the 0/1/2 CONTRACT is reused verbatim and the
 * flags are local.
 */
export interface ListenFailFlags {
  /** A configured engine's probe failed, or its import threw. */
  engineFailed: boolean;
  /** The configured engine needs model files and they are missing or unreadable. */
  modelsMissing: boolean;
  /** Nothing to capture from right now. Recoverable: plug a pipe in. */
  micUnavailable: boolean;
  /** The server is not up. Recoverable: it reconnects with backoff. */
  serverUnreachable: boolean;
  /** No config, bad `--url`, unknown `--device`. */
  setupError: boolean;
}

const WARN_EXIT = 2;

/**
 * Hard failures (1) are the ones a human must fix on this machine before the
 * satellite can ever work: a wake stack that will not load, a model that is not
 * there, a command line that does not resolve. The warn code (2) is for the two
 * conditions that are TRUE RIGHT NOW and may not be in a minute — no pipe
 * attached yet, server not started yet — because a CI check must tell "this
 * host will never hear you" from "nothing is talking to it at the moment".
 */
export function computeListenExit(f: ListenFailFlags): number {
  if (f.setupError || f.engineFailed || f.modelsMissing) return 1;
  if (f.micUnavailable || f.serverUnreachable) return WARN_EXIT;
  return 0;
}

export function deriveListenFailFlags(pre: ListenPreflight): ListenFailFlags {
  const failed = (name: string): boolean =>
    pre.probes.some((p) => p.name === name && !p.ok && p.skipped !== true);
  return {
    engineFailed: pre.probes.some(
      (p) => p.name.startsWith('engine:') && !p.ok && p.skipped !== true,
    ),
    modelsMissing: pre.modelsRequired && failed('models'),
    micUnavailable: failed('microphone'),
    serverUnreachable: failed(LANE_PROBE_NAME),
    setupError: pre.errors.length > 0,
  };
}

/** Is this probe row a hard failure, given what the host will actually run? */
function isFatalRow(row: DoctorProbeRow, pre: ListenPreflight): boolean {
  if (row.ok || row.skipped === true) return false;
  if (row.name === 'models') return pre.modelsRequired;
  return row.name.startsWith('engine:');
}

// ---------------------------------------------------------------------------
// URL derivation
// ---------------------------------------------------------------------------

export interface ListenUrls {
  socket: string;
  health: string;
}

/**
 * Where the satellite lane lives, from the operator's own base URL.
 *
 * An `--url` override is taken as given except for a bare origin, which gets
 * the lane path appended: pasting `ws://pi.local:3000` and getting a silent
 * connection failure at `/` teaches nothing.
 */
export function deriveListenUrls(webBaseUrl: string | undefined, override?: string): ListenUrls {
  const base = override ?? webBaseUrl ?? `http://127.0.0.1:${DEFAULT_WEB_PORT}`;
  const parsed = new URL(base);
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const path =
    parsed.pathname === '' || parsed.pathname === '/' ? SATELLITE_SOCKET_PATH : parsed.pathname;
  const socket = `${secure ? 'wss:' : 'ws:'}//${parsed.host}${path}`;
  const health = `${secure ? 'https:' : 'http:'}//${parsed.host}/healthz`;
  return { socket, health };
}

// ---------------------------------------------------------------------------
// Node id
// ---------------------------------------------------------------------------

/**
 * The satellite's stable identity, generated once and then read forever.
 *
 * A PER-BOOT RANDOM ID WOULD FORK THE CONVERSATION EVERY RESTART. The server's
 * lane key is `voice:<node>:<personality>`, so a new id on every start means a
 * new lane: the kitchen Pi comes back from a power cut as a different node,
 * and the conversation it was having is orphaned in the store under a key
 * nothing will ever ask for again.
 *
 * The COMPOSED id is what is persisted, not the uuid alone. The hostname is in
 * there so the Settings → Voice row is legible ("pi-kitchen-1a2b3c4d" rather
 * than a bare uuid), but reading the hostname again on every boot would hand
 * the same fork back the moment somebody renames the machine.
 */
export async function resolveListenNodeId(
  storage: Storage,
  path: string,
  generate: () => string = defaultNodeId,
): Promise<string> {
  const existing = (await storage.read(path))?.trim();
  if (existing) return existing;
  const id = generate();
  // The file's OWN parent, not `ethosDir()`: the path is a parameter so tests
  // (and a relocated data dir) write where they were told to.
  await storage.mkdir(dirname(path));
  await storage.writeAtomic(path, `${id}\n`);
  return id;
}

function defaultNodeId(): string {
  const host = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = randomUUID().slice(0, 8);
  return host.length > 0 ? `${host}-${suffix}` : `satellite-${suffix}`;
}

// ---------------------------------------------------------------------------
// Entry point — builds real deps, then delegates to the testable core
// ---------------------------------------------------------------------------

export async function runListen(args: string[], opts: ListenStartOptions = {}): Promise<void> {
  await runListenCommand(args, buildRealDeps(opts));
}

function buildRealDeps(opts: ListenStartOptions): ListenCommandDeps {
  const storage = getStorage();
  const device = createStdinPcmDevice({
    stdin: process.stdin,
    sampleRate: CAPTURE_SAMPLE_RATE,
    frameMs: CAPTURE_FRAME_MS,
  });
  return {
    preflight: (flags) => realPreflight(flags, storage, device),
    start: (pre, flags) => startListenDaemon(pre, flags, { storage, device, ...opts }),
  };
}

// ---------------------------------------------------------------------------
// Sub-router
// ---------------------------------------------------------------------------

export async function runListenCommand(args: string[], deps: ListenCommandDeps): Promise<void> {
  const flags = parseListenFlags(args);
  switch (flags.positional[0] ?? '') {
    case '':
      return listenDaemonCommand(flags, deps);
    case 'doctor':
      return listenDoctorCommand(flags, deps);
    default:
      console.log(USAGE);
      process.exitCode = 1;
      return;
  }
}

// ---------------------------------------------------------------------------
// `ethos listen doctor`
// ---------------------------------------------------------------------------

async function listenDoctorCommand(flags: ListenFlags, deps: ListenCommandDeps): Promise<void> {
  const pre = await deps.preflight(flags);
  const exit = computeListenExit(deriveListenFailFlags(pre));

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({
        nodeId: pre.nodeId,
        url: pre.url,
        healthUrl: pre.healthUrl,
        engine: {
          configured: pre.configuredEngine,
          modelsRequired: pre.modelsRequired,
          // The daemon does not acoustically match; a consumer reading this
          // must not infer wake capability from the engine name alone. The
          // room IS transcribed — the phrase gate runs on the server.
          daemonMode: 'open-mic',
          phraseMatch: false,
        },
        captureDevice: pre.device,
        sampleRate: pre.sampleRate,
        // Deliberately NOT a resolved `route`: this command never connects, and
        // the effective table is the server's. A consumer that needs to know
        // what the house answers to must ask the server, not this object.
        configuredRoutes: pre.routes,
        /** The `--route` PIN, unvalidated. Null means every phrase may address. */
        requestedRoute: pre.requestedRoute ?? null,
        routesNote: ROUTES_ARE_THE_SERVERS,
        edgeSttRequested: pre.edgeSttRequested,
        probes: pre.probes.map((p) => ({
          name: p.name,
          ok: p.ok,
          ...(p.detail === undefined ? {} : { detail: p.detail }),
          // The prose says why in English; `code` says the same thing in a form
          // a CI check can branch on without matching on a sentence.
          ...(p.name === LANE_PROBE_NAME && pre.laneFailureCode !== undefined
            ? { code: pre.laneFailureCode }
            : {}),
        })),
        errors: pre.errors,
        exit,
      })}\n`,
    );
    if (exit > 0) process.exitCode = exit;
    return;
  }

  console.log('');
  console.log(`${c.bold}ethos listen doctor${c.reset}  ${c.dim}wake satellite preflight${c.reset}`);
  console.log('');
  printPreflightRows(pre);
  console.log('');
  if (exit === 0) {
    console.log(
      `${c.green}✓ Preflight clean.${c.reset} Start with ${c.bold}ethos listen${c.reset}.`,
    );
  } else if (exit === WARN_EXIT) {
    console.log(
      `${c.yellow}⚠ Nothing is broken on this host, but it cannot listen right now.${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}✗ This host cannot run a wake satellite until the ✗ rows above are fixed.${c.reset}`,
    );
  }
  if (exit > 0) process.exitCode = exit;
}

/**
 * Where a line goes. Under `--json` stdout belongs to the doctor's one object
 * and nothing else, so every human-readable line moves to stderr.
 */
function writerFor(flags: ListenFlags): (line: string) => void {
  return flags.json ? (line: string) => console.error(line) : (line: string) => console.log(line);
}

function printPreflightRows(pre: ListenPreflight, say: (line: string) => void = console.log): void {
  const printRow = (label: string, glyph: string, detail?: string): void => {
    say(`  ${glyph}  ${label.padEnd(22)} ${detail ? `${c.dim}${detail}${c.reset}` : ''}`.trimEnd());
  };
  for (const note of pre.deprecations) {
    printRow('deprecation', `${c.yellow}⚠${c.reset}`, note);
  }
  for (const err of pre.errors) {
    printRow('setup', `${c.red}✗${c.reset}`, err);
  }
  for (const row of pre.probes) {
    const glyph =
      row.skipped === true
        ? `${c.dim}–${c.reset}`
        : row.ok
          ? `${c.green}✓${c.reset}`
          : isFatalRow(row, pre)
            ? `${c.red}✗${c.reset}`
            : `${c.yellow}⚠${c.reset}`;
    // A models row on a host that runs no acoustic engine is information, not a
    // fault: say which engine made it irrelevant rather than printing a red ✗
    // about files nothing on this machine will open.
    const detail =
      row.name === 'models' && !row.ok && !pre.modelsRequired
        ? `not required by the '${pre.configuredEngine}' engine — ${row.detail ?? ''}`
        : row.detail;
    printRow(row.name, glyph, detail);
  }
  printRow('node id', `${c.green}✓${c.reset}`, `${pre.nodeId} (${listenNodeIdPath()})`);
  // Labelled `satellite url`, not `server`: reachability is the `satellite-lane`
  // row above, and a ✓ next to "server" would read as "it answered" when all
  // this row means is "this is the address it would dial".
  printRow('satellite url', `${c.green}✓${c.reset}`, pre.url);
  // NOT a ✓ or a ⚠ — a dash. This command never connects, so it has no verdict
  // to give about routing: it reports what THIS file contributes and names the
  // authority for the rest.
  printRow(
    'route',
    `${c.dim}–${c.reset}`,
    (pre.routes.length > 0
      ? `configured here: ${pre.routes.map((r) => `${r.id} ("${r.phrase}" → ${r.personalityId})`).join(', ')}. `
      : 'none configured here, which is normal. ') +
      ROUTES_ARE_THE_SERVERS +
      (pre.requestedRoute === undefined
        ? ' Without --route, every phrase in that table can address this host.'
        : ` --route ${pre.requestedRoute} pins this host to that one route; it is checked against the pushed table when \`ethos listen\` connects, not here.`),
  );
  if (pre.edgeSttRequested) {
    printRow(
      'edge stt',
      `${c.yellow}⚠${c.reset}`,
      'voice.wake.edgeStt is on, but this host ships no on-device recognizer — ' +
        'audio WILL be streamed to the server. The "no audio leaves the machine" ' +
        'guarantee does not hold here.',
    );
  }
}

// ---------------------------------------------------------------------------
// `ethos listen`
// ---------------------------------------------------------------------------

async function listenDaemonCommand(flags: ListenFlags, deps: ListenCommandDeps): Promise<void> {
  const say = writerFor(flags);
  say(`${c.bold}ethos listen${c.reset}  ${c.dim}starting...${c.reset}`);
  say(
    `${c.dim}Runs in the foreground. Capture is a pipe: ${c.reset}` +
      `${c.bold}ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar ${CAPTURE_SAMPLE_RATE} -ac 1 -f s16le - | ethos listen${c.reset}`,
  );

  // Preflight FIRST, always. Refusing to start deaf is only possible if we
  // looked before we started.
  const pre = await deps.preflight(flags);
  const fail = deriveListenFailFlags(pre);
  printPreflightRows(pre, say);

  if (fail.setupError) {
    console.error(`${c.red}✗ Cannot start — fix the setup rows above.${c.reset}`);
    process.exitCode = 1;
    return;
  }
  if (!pre.transcriptEngineOk) {
    // (b) No usable engine remains. There is nothing to degrade to.
    console.error(
      `${c.red}✗ No usable wake engine on this host — not starting.${c.reset} ` +
        'Every engine probe failed; see the rows above.',
    );
    process.exitCode = 1;
    return;
  }
  if (fail.engineFailed || fail.modelsMissing) {
    // (a) A usable engine remains — continue, loudly. The configured acoustic
    // engine is a desktop-host concern anyway; say which one failed and why so
    // the operator is not left inferring it from silence.
    for (const row of pre.probes) {
      if (row.ok || row.skipped === true) continue;
      if (!row.name.startsWith('engine:') && row.name !== 'models') continue;
      say(`${c.yellow}⚠ degraded${c.reset} ${c.dim}${row.name}: ${row.detail}${c.reset}`);
    }
  }
  if (pre.device === null) {
    console.error(
      `${c.red}✗ Nothing is piped to stdin — not starting.${c.reset}\n` +
        `  This daemon captures raw s16le mono PCM at ${CAPTURE_SAMPLE_RATE} Hz from a pipe:\n` +
        `    ${c.bold}ffmpeg -nostats -loglevel error -f avfoundation -i :0 -ar ${CAPTURE_SAMPLE_RATE} -ac 1 -f s16le - | ethos listen${c.reset}\n` +
        `    ${c.bold}arecord -q -f S16_LE -r ${CAPTURE_SAMPLE_RATE} -c 1 -t raw | ethos listen${c.reset}`,
    );
    process.exitCode = 1;
    return;
  }
  // No route gate here. The table this daemon routes against is the server's,
  // and it arrives on the socket — see `startListenDaemon`, which refuses AFTER
  // the push rather than guessing from the local file before it.
  if (fail.serverUnreachable) {
    say(
      `${c.yellow}⚠ ${LANE_PROBE_NAME}${c.reset} ${c.dim}${pre.url} is not answering yet — ` +
        `the satellite will keep retrying with backoff, and will wait for its route ` +
        `table before it captures anything.${c.reset}`,
    );
  }

  await deps.start(pre, flags);
}

// ---------------------------------------------------------------------------
// Preflight — the real one
// ---------------------------------------------------------------------------

/**
 * An engine the config names and this build does not implement.
 *
 * Falling through to the transcript engine silently would be the false-available
 * failure with the sign flipped: the operator asked for openWakeWord and got
 * something else without being told.
 */
function unimplementedEngineFactory(name: string): WakeEngineFactory {
  return {
    name,
    async probe() {
      return {
        ok: false,
        engine: name,
        detail:
          `voice.wake.engine is '${name}', and no '${name}' engine ships in this build. ` +
          `Use 'sherpa' (optional native peer) or 'fallback' (the transcript engine).`,
      };
    },
    create() {
      // Unreachable today — the doctor only probes, and the daemon runs the
      // open-mic engine — but it refuses rather than quietly handing back some
      // other engine, which is the same false-available failure wearing the
      // opposite sign.
      return {
        name,
        async init(): Promise<void> {
          throw new EthosError({
            code: 'CONFIG_INVALID',
            cause: `No '${name}' wake engine ships in this build.`,
            action: `Set voice.wake.engine to 'sherpa' or 'fallback' in ~/.ethos/config.yaml.`,
          });
        },
        push: () => null,
        reset(): void {},
        async dispose(): Promise<void> {},
      };
    },
  };
}

async function realPreflight(
  flags: ListenFlags,
  storage: Storage,
  device: CaptureDevice,
): Promise<ListenPreflight> {
  const errors: string[] = [];

  let config: Awaited<ReturnType<typeof loadConfigStrict>> = null;
  try {
    config = await loadConfigStrict(storage, await getSecretsResolver());
  } catch (err) {
    errors.push(`config could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (config === null && errors.length === 0) {
    errors.push('no ~/.ethos/config.yaml — run `ethos setup` first');
  }
  for (const parseError of config?.parseErrors ?? []) errors.push(`config: ${parseError}`);

  const wake = config?.config.voice?.wake;
  // `fallback` is the config's name for the engine that calls itself
  // `transcript`; the probe rows are keyed on the engine's own name, so the
  // translation happens once, here.
  const configuredEngine =
    wake?.engine === undefined || wake.engine === 'fallback' ? 'transcript' : wake.engine;

  let urls: ListenUrls = { socket: '', health: '' };
  try {
    urls = deriveListenUrls(config?.config.webBaseUrl, flags.url);
  } catch {
    errors.push(`could not parse the server URL: ${flags.url ?? config?.config.webBaseUrl}`);
  }

  const modelDir = wakeModelDir();
  const engineFactories: WakeEngineFactory[] = [transcriptWakeEngineFactory];
  if (configuredEngine === 'sherpa') {
    engineFactories.push(
      createSherpaWakeEngineFactory({ storage, modelDir, files: SHERPA_MODEL_FILES }),
    );
  } else if (configuredEngine !== 'transcript') {
    engineFactories.push(unimplementedEngineFactory(configuredEngine));
  }

  // The shared doctor's `gatewayProbe` seam hands back `{ok, detail}` and
  // nothing else, so the errno is caught here on the way past rather than
  // squeezed into the prose and re-parsed out of it downstream.
  let laneFailureCode: string | undefined;
  const doctor = await runSatelliteDoctor({
    engineFactories,
    storage,
    modelDir,
    audioDevice: device,
    ...(urls.health
      ? {
          gatewayProbe: async () => {
            const lane = await probeSatelliteLane(urls.socket, urls.health);
            laneFailureCode = lane.code;
            return lane;
          },
        }
      : {}),
  });

  const devices = await device.list().catch((): AudioDeviceInfo[] => []);
  let selected: AudioDeviceInfo | null = devices.find((d) => d.isDefault) ?? devices[0] ?? null;
  if (flags.device !== undefined) {
    const named = devices.find((d) => d.id === flags.device) ?? null;
    if (named === null) {
      errors.push(
        `unknown --device ${flags.device}; this build enumerates: ` +
          (devices.length > 0 ? devices.map((d) => d.id).join(', ') : '(none)'),
      );
    }
    selected = named;
  }

  const routes = readWakeRoutes(wake?.routes);

  return {
    // Renamed exactly here, once, so the row, the fail flags and the JSON
    // cannot disagree about what the reachability probe is called.
    probes: withLaneProbeName(doctor.probes),
    configuredEngine,
    transcriptEngineOk: doctor.probes.some((p) => p.name === 'engine:transcript' && p.ok),
    modelsRequired: configuredEngine === 'sherpa',
    url: urls.socket,
    healthUrl: urls.health,
    ...(laneFailureCode === undefined ? {} : { laneFailureCode }),
    nodeId: await resolveListenNodeId(storage, listenNodeIdPath()),
    routes,
    ...(flags.route === undefined ? {} : { requestedRoute: flags.route }),
    edgeSttRequested: wake?.edgeStt === true,
    device: selected,
    sampleRate: CAPTURE_SAMPLE_RATE,
    ...(wake?.idleTimeout === undefined ? {} : { idleTimeoutMs: wake.idleTimeout * 1000 }),
    errors,
    deprecations: config?.deprecations ?? [],
  };
}

/** `voice.wake.routes` as the wake seam wants them: disabled entries dropped. */
function readWakeRoutes(raw: Record<string, WakeRouteConfig> | undefined): WakeRoute[] {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([, r]) => r.enabled !== false)
    .map(([id, r]) => ({
      id,
      phrase: r.phrase,
      personalityId: r.personality,
      privileged: r.privileged === true,
      enabled: true,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Why the personality the operator was looking for is not in the pushed table.
 *
 * Said the SAME WAY wherever a route cannot be resolved, because the two
 * refusals — a `--route` that matched nothing, and a table with nothing in it —
 * have the same cause and drifting into two phrasings of it is how one of them
 * ends up stale.
 *
 * It states the RULE, never which personalities were withheld: the client is
 * not told, the wake surface deliberately does not enumerate privileged
 * personalities, and a message that guessed would be accusing a table it cannot
 * see. Do not make the server send the excluded list to improve this string.
 */
const WHY_A_PERSONALITY_IS_ABSENT =
  'A personality is absent from this table when it is privileged — its toolset can reach a ' +
  'tool the approval layer would stop and ask about, and the default wake surface excludes ' +
  'those by design (no toolset.yaml means every tool, so that counts). Opt one in with an ' +
  'explicit route in ~/.ethos/config.yaml: voice.wake.routes.<id>.phrase / .personality / ' +
  '.privileged: true.';

/**
 * Resolve `--route` — the PIN — against the table the SERVER pushed, never
 * against the local config, which is one contributor to that table and not the
 * table itself.
 *
 * WHAT `--route` MEANS NOW. It used to be compulsory and it used to mean "send
 * every utterance as this personality", because the daemon had no way to tell
 * one addressee from another. The server matches phrases now, so the phrase
 * picks the personality and the flag is optional. What is left for it is the
 * one thing a phrase cannot say: WHICH PHRASES THIS MICROPHONE ANSWERS TO. A
 * pinned host is dedicated to one route — say the pinned phrase and it answers,
 * say another agent's and it does not.
 *
 * It is NOT a way to skip the gate. Pinning that also meant "and no phrase
 * needed" would make one flag quietly re-open the hole the gate closed, on the
 * host most likely to be left running in a room unattended.
 *
 * No pin resolves to `{ route: null }` with no problem: that is the ordinary
 * case, and it means every enabled route may address this host.
 */
export function resolveRoutePin(
  pushed: readonly WakeRoute[],
  requested: string | undefined,
): { route: WakeRoute | null; problem?: string } {
  if (requested === undefined) return { route: null };
  const routes = pushed.filter((r) => r.enabled);
  // Matched by whole id and nothing else: a synthesized id is
  // `auto:<personalityId>`, and `:` is outside the charset a config id may
  // use, so there is never an ambiguity between the two kinds.
  const found = routes.find((r) => r.id === requested);
  if (found) return { route: found };
  return {
    route: null,
    problem:
      `the server's wake route table has no enabled route '${requested}' — ` +
      (routes.length > 0
        ? `it pushed: ${routes.map((r) => `${r.id} ("${r.phrase}" → ${r.personalityId})`).join(', ')}. ` +
          'A synthesized route is named auto:<personalityId>. '
        : 'it pushed an empty table. ') +
      WHY_A_PERSONALITY_IS_ABSENT,
  };
}

/**
 * Why an empty pushed table is a warning and no longer a refusal.
 *
 * It used to stop the boot: the daemon had to pick one route up front, and
 * there was none to pick. Now the daemon picks nothing — the server matches
 * each transcript against whatever table it holds at that moment — and a
 * Settings save pushes a new one down the open socket. Refusing to start would
 * mean an operator who fixes their config still has to walk to the Pi.
 */
export const EMPTY_TABLE_WARNING =
  'the server pushed an EMPTY wake route table — no phrase can address this deployment ' +
  'yet, so every utterance will be transcribed and discarded. Every unprivileged ' +
  'personality gets a synthesized "hey <name>" route automatically, so an empty table ' +
  `means there are none. ${WHY_A_PERSONALITY_IS_ABSENT} ` +
  'A Settings save reaches this daemon without a restart.';

export interface SatelliteLaneProbe {
  ok: boolean;
  /**
   * Why, in one line. NEVER EMPTY — an empty detail is the defect this contract
   * exists to forbid: the row printed `…/satellite/ws: ;` and taught the
   * operator nothing at all.
   */
  detail: string;
  /** See `ListenPreflight.laneFailureCode`. Absent when the lane is reachable. */
  code?: string;
}

/**
 * Is the thing this satellite actually needs reachable?
 *
 * IT IS THE WEBSOCKET LANE, NOT `/healthz`. `/healthz` folds the CHANNEL
 * gateway's status into its own — a healthy `ethos serve` with no Telegram or
 * Slack adapter running answers 503 — and a satellite does not use the channel
 * gateway for anything. Probing it made this row lie on every deployment that
 * simply had no chat bots attached.
 *
 * So the first probe is an upgrade request against `/satellite/ws` itself, WITH
 * NO AUTH COOKIE, which is the cheapest thing that tests the real dependency:
 *   • 401/403 — the lane is mounted and refused an unauthenticated probe. That
 *     is the expected answer, and it never creates a lane or a registry row.
 *   • 101 — accepted (a deployment with auth off); torn down immediately.
 *   • 404 — this server has no satellite lane at all, which `/healthz` could
 *     never have told us.
 * An unexpected status, or an upgrade a proxy mangled, is INCONCLUSIVE rather
 * than wrong: the host answered something, so `/healthz` is asked as well.
 *
 * ONE CAUSE, SAID ONCE. But when the connection itself never came up, there is
 * nothing for `/healthz` to add — it dials the same host and port over the same
 * transport, so it can only fail the same way — and asking it anyway is what
 * produced the unreadable `a; b` line this exists to kill. So a connect-level
 * errno short-circuits, and even on the fallback path a health failure matching
 * the upgrade's own code is reported once rather than twice.
 */
export async function probeSatelliteLane(
  socketUrl: string,
  healthUrl: string,
): Promise<SatelliteLaneProbe> {
  const upgrade = await probeUpgrade(socketUrl);
  if (upgrade.status === 101) {
    return { ok: true, detail: `${socketUrl} accepted the upgrade` };
  }
  if (upgrade.status === 401 || upgrade.status === 403) {
    return {
      ok: true,
      detail: `${socketUrl} is mounted — answered ${upgrade.status} to a probe sent with no auth cookie, which is the expected refusal`,
    };
  }
  if (upgrade.status === 404) {
    return {
      ok: false,
      code: 'NO_SATELLITE_LANE',
      detail: `${socketUrl} answered 404 — this server has no satellite lane. Is it an older \`ethos serve\`?`,
    };
  }
  if (upgrade.code !== undefined && CONNECT_NEVER_ESTABLISHED.has(upgrade.code)) {
    return { ok: false, code: upgrade.code, detail: `${socketUrl}: ${upgrade.error}` };
  }

  const why = upgrade.status === undefined ? upgrade.error : `answered ${upgrade.status}`;
  const health = await probeHealthz(healthUrl);
  if (health.ok) {
    return { ok: true, detail: `${socketUrl}: ${why}; ${health.detail}` };
  }
  if (health.code !== undefined && health.code === upgrade.code) {
    // Both ends died of the same thing. The reader needs the diagnosis, not it
    // twice.
    return { ok: false, code: health.code, detail: `${socketUrl}: ${why}` };
  }
  return {
    ok: false,
    ...(health.code === undefined ? {} : { code: health.code }),
    detail: `${socketUrl}: ${why}; ${health.detail}`,
  };
}

/**
 * Errnos that mean the connection was never established, so a second probe over
 * the same transport is guaranteed to say the same thing.
 */
const CONNECT_NEVER_ESTABLISHED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EACCES',
]);

/**
 * The error Node is actually reporting, dug out from under whatever wrapped it.
 *
 * Two wrappers hide it here and both are the everyday case:
 *   • `fetch` rejects with a bare `TypeError: fetch failed` — undici's opaque
 *     lid — and puts the real socket error on `.cause`.
 *   • `net.connect` to a dual-stack name such as `localhost` rejects with an
 *     `AggregateError` whose OWN `message` is the EMPTY STRING and whose
 *     `.errors` holds one refusal per address family. That empty string is
 *     precisely what printed `ws://localhost:3000/satellite/ws: ;`.
 *
 * So the walk takes the DEEPEST non-empty message and the deepest errno, and
 * falls back to the code (and then to a fixed phrase) rather than ever handing
 * back nothing.
 */
function rootCauseOf(err: unknown): { code?: string; message: string } {
  let code: string | undefined;
  let message = '';
  let current: unknown = err;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
    const node = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof node.code === 'string' && node.code !== '') code = node.code;
    if (typeof node.message === 'string' && node.message !== '') message = node.message;
    const nested = Array.isArray(node.errors) ? node.errors[0] : node.cause;
    if (nested === undefined || nested === null) break;
    current = nested;
  }
  if (message === '') {
    const raw = typeof err === 'string' ? err : String(err);
    message = raw.trim() === '' ? (code ?? 'no reason reported') : raw;
  }
  return code === undefined ? { message } : { code, message };
}

/**
 * An errno turned into a sentence an operator can act on.
 *
 * The overwhelmingly common one is `ECONNREFUSED`, and for it the message names
 * the remedy: a satellite that cannot reach the lane is, nine times in ten,
 * a satellite started before its server.
 */
function explainFailure(err: unknown): { code?: string; message: string } {
  const { code, message } = rootCauseOf(err);
  const clause = ((): string => {
    switch (code) {
      case 'ECONNREFUSED':
        return `connection refused (ECONNREFUSED) — nothing is listening there, so the server is not running. ${START_THE_SERVER}`;
      case 'ENOTFOUND':
        return 'the hostname does not resolve (ENOTFOUND) — check webBaseUrl in ~/.ethos/config.yaml, or --url.';
      case 'EAI_AGAIN':
        return 'DNS lookup failed (EAI_AGAIN) — this machine could not resolve the hostname.';
      case 'ETIMEDOUT':
      case 'UND_ERR_CONNECT_TIMEOUT':
        return `timed out (${code}) — the address is routable but nothing answered. Check a firewall, or whether the server is bound to that interface.`;
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
        return `no route to that host (${code}) — check this machine's network.`;
      case 'ECONNRESET':
        return 'the connection was reset (ECONNRESET) — something answered and hung up. A proxy in front of the lane?';
      case 'EACCES':
        return 'refused locally (EACCES) — a sandbox or firewall on this machine blocked the connection.';
      default:
        return code === undefined ? message : `${message} (${code})`;
    }
  })();
  return code === undefined ? { message: clause } : { code, message: clause };
}

/**
 * `/healthz`, read for what it says rather than for its status code.
 *
 * A 503 whose body is `{status: 'degraded', gateway: {...}}` means the CHANNEL
 * gateway is down or stale — nothing a satellite depends on. The web-api
 * answered, which is the fact this probe is after, so that shape is reported as
 * reachable and says which subsystem was the one that was down.
 */
export async function probeHealthz(
  url: string,
): Promise<{ ok: boolean; detail: string; code?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return { ok: true, detail: `${url} answered ${res.status}` };
    const body: unknown = await res.json().catch(() => null);
    if (isGatewayDegraded(body)) {
      return {
        ok: true,
        detail: `${url} answered ${res.status} — the web-api is up and only the channel gateway is down, which a satellite does not need`,
      };
    }
    return { ok: false, code: `HTTP_${res.status}`, detail: `${url} answered ${res.status}` };
  } catch (err) {
    // `err.message` here is `fetch failed` — undici's lid over the real socket
    // error, which is on `.cause`. Reporting the lid is reporting nothing.
    const failure = explainFailure(err);
    return {
      ok: false,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      detail: `${url}: ${failure.message}`,
    };
  }
}

/** The exact `/healthz` shape that means "only the channel gateway is down". */
function isGatewayDegraded(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as { status?: unknown; gateway?: unknown };
  if (record.status !== 'degraded') return false;
  const gateway = record.gateway;
  if (typeof gateway !== 'object' || gateway === null) return false;
  const status = (gateway as { status?: unknown }).status;
  return status === 'down' || status === 'stale';
}

/** How long an upgrade probe waits for a status line before giving up. */
const UPGRADE_PROBE_TIMEOUT_MS = 3000;

/**
 * Either a status line came back, or a reason did. `error` is REQUIRED on the
 * failure arm so no branch can resolve a failure and say nothing about it —
 * that is how an ECONNREFUSED reached the row as the empty string.
 */
type UpgradeProbe =
  | { status: number; error?: undefined; code?: undefined }
  | { status?: undefined; error: string; code?: string };

/**
 * Send one WebSocket upgrade request and read the status line back.
 *
 * The handshake is deliberately NOT completed: no cookie is sent, so the server
 * refuses with 401 and no lane, no registry row, and no phantom satellite is
 * created by the act of checking.
 */
function probeUpgrade(socketUrl: string): Promise<UpgradeProbe> {
  let parsed: URL;
  try {
    parsed = new URL(socketUrl);
  } catch {
    return Promise.resolve({ error: `not a URL: ${socketUrl}` });
  }
  const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
  const port = Number(parsed.port) || (secure ? 443 : 80);
  const path = `${parsed.pathname}${parsed.search}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: UpgradeProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ error: `no response within ${UPGRADE_PROBE_TIMEOUT_MS}ms` }),
      UPGRADE_PROBE_TIMEOUT_MS,
    );
    const socket: Socket = secure
      ? tlsConnect({ host: parsed.hostname, port, servername: parsed.hostname })
      : netConnect({ host: parsed.hostname, port });

    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.once('data', (chunk: Buffer) => {
      const match = /^HTTP\/1\.\d (\d{3})/.exec(chunk.toString('latin1'));
      finish(match?.[1] ? { status: Number(match[1]) } : { error: 'no HTTP status line' });
    });
    // NOT `err.message`: a dual-stack `localhost` refusal arrives as an
    // `AggregateError` whose own message is the empty string. See `rootCauseOf`.
    socket.once('error', (err: Error) => {
      const failure = explainFailure(err);
      finish({
        error: failure.message,
        ...(failure.code === undefined ? {} : { code: failure.code }),
      });
    });
    socket.once('close', () => finish({ error: 'closed with no response' }));
  });
}

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

/**
 * Same shape as `GatewayHeartbeat`, on purpose.
 *
 * The desktop lane derives satellite status from this file, and it already
 * reads `gateway-health.json`; one reader shape for both is the difference
 * between a status panel and two status panels. `captureState` is the one
 * addition, and it is additive — a reader that only knows the gateway fields
 * still works.
 */
export interface ListenHeartbeat {
  pid: number;
  startedAt: string;
  updatedAt: string;
  adapters: Array<{ name: string; ok: boolean }>;
  captureState: CaptureState;
}

interface ListenDaemonContext extends ListenStartOptions {
  storage: Storage;
  device: CaptureDevice;
}

/**
 * The OPEN-MIC engine: it opens an utterance on speech, and matches nothing.
 *
 * NOT "push-to-talk", which is what this was called and was never true — there
 * is no button, and there never was. The pipe carries whatever the room says;
 * a VAD decides where one utterance stops and the next begins; and who was
 * addressed is settled downstream, by the server, from the transcript. Calling
 * it push-to-talk implied a human hand in the loop that does not exist, on the
 * exact host most likely to be left running unattended in a room.
 *
 * It sits behind the same `WakeEngine` seam an acoustic spotter would, so the
 * whole of `CaptureMachine` — the watchdog, the verified re-arm, the self-wake
 * suppression — applies unchanged. It reports no route and no phrase, because
 * it matched neither: this host registers `phraseMatch: false` and the wire
 * contract makes both fields optional for exactly that reason.
 */
function createOpenMicEngine(): WakeEngine {
  let vad = createEnergyFrameVad();
  return {
    name: 'open-mic',
    async init(): Promise<void> {},
    push(frame) {
      if (!vad.push(frame)) return null;
      // No score to report: a VAD found energy, not a phrase. `confidence` is
      // documented as the engine's own scale, so certainty that SPEECH started
      // is the true value rather than a number invented to look like a
      // phrase-match probability.
      return { confidence: 1 };
    },
    reset(): void {
      // A fresh detector rather than a flag: `EnergyVad` carries hangover
      // frames, and a re-arm that inherited them would fire on the tail of the
      // utterance that just ended.
      vad = createEnergyFrameVad();
    },
    async dispose(): Promise<void> {},
  };
}

export async function startListenDaemon(
  pre: ListenPreflight,
  flags: ListenFlags,
  ctx: ListenDaemonContext,
): Promise<void> {
  const deviceInfo = pre.device;
  if (deviceInfo === null) return;

  const { storage, device } = ctx;
  // Every line this daemon narrates goes through here — see `writerFor`.
  const say = writerFor(flags);

  // The `--route` PIN, resolved against the table the server pushes rather than
  // the local config — which is why it is a `let` assigned after connect. Null
  // is the ordinary case: unpinned, every phrase in the table may address this
  // microphone.
  let route: WakeRoute | null = null;
  let machine: CaptureMachine | null = null;
  let captureState: CaptureState = 'idle';
  let wakeSeq = 0;
  let utteranceSeq = 0;
  let currentUtteranceId: string | null = null;
  let audioSeq = 0;
  let playoutWarned = false;
  /** What was last REGISTERED with the server; see `onSetWakeEnabled`. */
  let wakeEnabled = true;
  /** Whether the pinned route's absence has already been said; see `onRoutes`. */
  let routeMissingWarned = false;
  /**
   * The utterance the server reported no speech in.
   *
   * Kept so the `turn_end` behind it is narrated as a plain re-arm rather than
   * as "not addressed to anyone" — both arrive with no personality, and only
   * this remembers which of the two happened.
   */
  let unspokenUtteranceId: string | null = null;
  /**
   * The addressing window the SERVER is enforcing, from the pushed settings.
   *
   * Read off the wire rather than off this machine's `config.yaml`: the gate
   * runs on the server, so the server's number is the one a banner may quote.
   * The local value is only a placeholder until the first push lands.
   */
  let idleWindowMs = pre.idleTimeoutMs ?? DEFAULT_IDLE_WINDOW_MS;

  let deliverTable: ((routes: WakeRoute[]) => void) | null = null;
  const firstTable = new Promise<WakeRoute[]>((resolve) => {
    deliverTable = resolve;
  });

  // The client's callbacks reach `machine`, which is constructed after the
  // route table lands. They are null-guarded rather than ordered: the socket
  // genuinely is open before the machine exists, and the two are mutually
  // referential by nature — the machine drives the wire and the wire re-arms
  // the machine.
  const transport = ctx.createSocket;
  const auth = transport === undefined ? await authCookie(storage) : {};
  const client = createSatelliteClient({
    url: pre.url,
    nodeId: pre.nodeId,
    displayName: pre.nodeId,
    capabilities: {
      // All three probed, not declared: no on-device recognizer ships here,
      // there is no output device behind a pipe, and nothing on this host
      // compares sound to a phrase — so the SERVER gates, from the transcript.
      edgeStt: false,
      playback: false,
      captureSampleRate: pre.sampleRate,
      phraseMatch: false,
    },
    wakeEnabled: true,
    ...auth,
    ...(transport === undefined ? {} : { createSocket: transport }),
    onRoutes: (frame) => {
      const table: WakeRoute[] = frame.routes.map((r) => ({ ...r }));
      idleWindowMs = frame.settings.idleTimeoutMs;
      const deliver = deliverTable;
      if (deliver !== null) {
        // The FIRST table is the one the route is chosen from — it is the only
        // authority on what this deployment answers to.
        deliverTable = null;
        deliver(table);
        return;
      }
      // A later push is a Settings save or a reconnect. Unpinned, there is
      // nothing to check: the server matches every transcript against whatever
      // table it holds, and this host does not have an opinion to go stale.
      const active = route;
      if (active === null) return;
      const present = table.some((r) => r.id === active.id && r.enabled);
      // NARRATED ON THE EDGE, BOTH WAYS. Every reconnect and every Settings
      // save re-pushes the table, so warning on each push repeated one line per
      // push for a condition that had not changed — and saying nothing when the
      // route came back left "utterances will be refused until it comes back"
      // standing as the operator's last word on a satellite that was working
      // again.
      if (!present && !routeMissingWarned) {
        routeMissingWarned = true;
        say(
          `${c.yellow}⚠ route${c.reset} ${c.dim}the server no longer has an enabled route ` +
            `'${active.id}' — this host is pinned to it, so nothing said here can reach ` +
            `an agent until it comes back.${c.reset}`,
        );
        return;
      }
      if (present && routeMissingWarned) {
        routeMissingWarned = false;
        say(
          `${c.dim}  ↩ route '${active.id}' is back in the server's table — ` +
            `"${active.phrase}" reaches ${active.personalityId} again.${c.reset}`,
        );
      }
    },
    onTranscript: (frame) => {
      // What the server HEARD, echoed back — printed as the operator's own
      // words, with `onReplyText` below printing the answer to them.
      if (!frame.final) return;
      if (frame.text.trim() === '') {
        unspokenUtteranceId = frame.utteranceId;
        // A FINAL TRANSCRIPT WITH NO TEXT IS THE SERVER SAYING IT HEARD NO
        // SPEECH — the recognizer's own "nothing was said", which on an open
        // pipe in a room is ordinary traffic and not a fault. It arrives with a
        // `turn_end` behind it, so the re-arm is already narrated below and
        // this line only has to say what was heard. Rendering it through the
        // normal branch printed a bare `› you:` with nothing after it, which
        // reads as a bug; any word stronger than these blames the operator for
        // a door closing.
        say(
          `${c.dim}  › no speech in that audio — the server heard nothing to transcribe.${c.reset}`,
        );
        return;
      }
      say(`${c.dim}  › you:${c.reset} ${frame.text}`);
    },
    onReplyText: (frame) => {
      // The other half of the exchange. This host has no loudspeaker, so this
      // frame is the ONLY way the answer reaches the operator — the reply audio
      // is never even synthesized for a node that declared playback: false.
      say(
        `${c.dim}  ‹ ${c.reset}${c.cyan}${frame.personalityId}${c.reset}${c.dim}:${c.reset} ${frame.text}`,
      );
    },
    onSpeak: (event) => {
      if (event.type === 'speak_start') {
        if (!playoutWarned) {
          playoutWarned = true;
          say(
            `${c.yellow}⚠ playout${c.reset} ${c.dim}the server is sending synthesized audio, ` +
              `and this host has no output device (capabilities.playback: false). ` +
              `The audio is being discarded — the reply text still prints below.${c.reset}`,
          );
        }
      }
      if (event.type === 'turn_end') {
        // No segment count: this host declares playback: false, so the server
        // synthesizes nothing for it and the count was always zero. The answer
        // itself was printed by `onReplyText`; this line only closes the cycle.
        //
        // THREE WAYS A TURN ENDS, and the operator is owed the difference. A
        // `personalityId` means somebody answered. Its absence after an empty
        // transcript means there was no speech in the audio — already said
        // above, so this only re-arms. Its absence otherwise means the words
        // were heard and addressed to nobody, which is the COMMON case in a
        // room and gets one quiet line, not a warning.
        if (event.personalityId !== undefined) {
          say(`${c.dim}  ↩ turn complete. Listening again.${c.reset}`);
        } else if (unspokenUtteranceId === event.utteranceId) {
          say(`${c.dim}  ↩ listening again.${c.reset}`);
        } else {
          say(
            `${c.dim}  ↩ not addressed to anyone — no agent was called. ` +
              `Open with a wake phrase to reach one. Listening again.${c.reset}`,
          );
        }
        unspokenUtteranceId = null;
        // Re-arm. `playback_done` is the honest frame even with nothing played:
        // it means "the speaker has gone quiet and I am listening again", and
        // a host with no speaker satisfies the first half trivially.
        client.sendPlaybackDone(event.utteranceId);
        currentUtteranceId = null;
        machine?.endPlayback();
      }
    },
    onSetWakeEnabled: (enabled) => {
      machine?.setMuted(!enabled);
      // A MUTED SATELLITE IS A DEAF ONE, and rule 1 of this file says it may
      // never look otherwise. The mute arrives from the Settings UI on another
      // machine, and `onStateChange` deliberately narrates nothing for `muted`
      // (it is a legitimate state, not a fault) — so without this line the pipe
      // keeps flowing, `●` never appears again, and the terminal that said
      // "Listening on ..." is the last thing the operator was told.
      if (enabled === wakeEnabled) return;
      wakeEnabled = enabled;
      say(
        enabled
          ? `${c.dim}  ↩ wake re-enabled from the server. Listening again.${c.reset}`
          : `${c.yellow}⚠ wake${c.reset} ${c.dim}disabled from the server — this node is muted, ` +
              `and speech on the pipe is ignored until it is re-enabled.${c.reset}`,
      );
    },
    onError: (message) => say(`${c.yellow}⚠ satellite${c.reset} ${c.dim}${message}${c.reset}`),
  });

  // Both are assigned further down, but the signal handlers below are installed
  // FIRST: Ctrl+C during the wait for the server's route table must still stop
  // the process rather than being ignored until capture starts.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopWatchdog: (() => void) | null = null;
  const shutdown = async (): Promise<void> => {
    say(`\n${c.dim}Shutting down...${c.reset}`);
    if (stopWatchdog) stopWatchdog();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await storage.remove(listenHealthPath()).catch(() => {});
    client.close();
    machine?.stop();
    await device.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  client.connect();
  say(
    `${c.dim}Connecting to ${pre.url} for the wake route table` +
      `${pre.requestedRoute === undefined ? '' : ` (pinning to route ${pre.requestedRoute})`}...${c.reset}`,
  );

  // READY MEANS "UP AND CONNECTING", not "capturing". A satellite booted before
  // `ethos serve` waits here for as long as the server takes, and a supervisor
  // that never got a readiness notification would kill it on its start timeout.
  emitReady('listen');
  notifyReady();
  stopWatchdog = startWatchdog();

  const pushed = await firstTable;
  const pin = resolveRoutePin(pushed, flags.route);
  // Only a pin that names nothing is fatal — the operator asked for a specific
  // route and did not get it, and starting anyway would leave the microphone
  // answering to phrases they meant to exclude.
  if (pin.problem !== undefined) {
    console.error(`${c.red}✗ ${pin.problem}${c.reset}`);
    if (stopWatchdog) stopWatchdog();
    client.close();
    process.exitCode = 1;
    return;
  }
  const pinnedRoute = pin.route;
  route = pinnedRoute;
  if (pushed.filter((r) => r.enabled).length === 0) {
    say(`${c.yellow}⚠ routes${c.reset} ${c.dim}${EMPTY_TABLE_WARNING}${c.reset}`);
  }

  const engine = createOpenMicEngine();
  // The engine matches nothing, so the routes and the sensitivity it is handed
  // decide nothing either — they are the seam's shape, not this host's policy.
  // The table that matters is the server's, applied to the transcript.
  await engine.init([], { sensitivity: 0.5, confirmationFrames: 1 });

  const capture = new CaptureMachine(
    {
      engine,
      vad: createEnergyFrameVad(),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onWake: (match) => {
        const stamp = Date.now().toString(36);
        const wakeId = `w${++wakeSeq}-${stamp}`;
        const utteranceId = `u${++utteranceSeq}-${stamp}`;
        currentUtteranceId = utteranceId;
        audioSeq = 0;
        // No personality on this line, because none has been chosen: the words
        // decide, and nobody has heard them yet. Claiming one here is what the
        // old push-to-talk banner did, and it was wrong the moment two
        // personalities shared a microphone.
        say(
          `${c.dim}● speech — utterance ${utteranceId} open${c.reset}` +
            `${pinnedRoute === null ? '' : `${c.dim} (pinned to route ${pinnedRoute.id}).${c.reset}`}`,
        );
        client.sendWake({
          wakeId,
          // No phrase and no personality: this engine matched SOUND. `routeId`
          // from a `phraseMatch: false` node is the PIN — "only this route may
          // address me" — not a claim that it matched.
          ...(pinnedRoute === null ? {} : { routeId: pinnedRoute.id }),
          confidence: match.confidence,
        });
        client.sendUtteranceStart({ wakeId, utteranceId, sampleRate: pre.sampleRate });
      },
      onAudio: (frame) => {
        if (currentUtteranceId === null) return;
        client.sendAudio(currentUtteranceId, audioSeq++, frame.samples);
      },
      onUtteranceEnd: () => {
        if (currentUtteranceId === null) return;
        client.sendUtteranceEnd(currentUtteranceId);
        // The machine has no "waiting for the server" state, and `thinking` has
        // no watchdog — so the window between utterance_end and turn_end is
        // modelled as playback. It is the interval in which the reply is being
        // produced, the microphone must stay suppressed through it, and the
        // playback watchdog is the ONLY supervision that guarantees a re-arm if
        // `turn_end` never arrives. Without this the daemon is the classic
        // "capture loop survives exactly one turn".
        capture.beginPlayback();
      },
      onStateChange: (state, detail) => {
        captureState = state;
        client.sendState(protocolState(state), detail);
        if (state === 'degraded' && detail) {
          say(`${c.yellow}⚠ capture${c.reset} ${c.dim}${detail}${c.reset}`);
          return;
        }
        // A `listening` transition CARRYING A DETAIL is `CaptureMachine`
        // discarding an utterance under its minimum-speech floor — the only
        // detailed re-arm it has (the watchdog's re-arm reports itself as
        // `degraded` first, and passes none).
        //
        // THE REPETITION RULE IS PAIRING: narrate it only while an utterance
        // this daemon already printed a `● speech` line for is unresolved, and
        // resolve it here. That gives exactly one discard line per `●`, never
        // one without a `●`, so the dangling open marker this fixes cannot come
        // back — and in a room full of chair scrapes it adds no NEW class of
        // noise, because every discard had already cost a `●` line and this one
        // closes it rather than adding an unrelated one. Suppressing
        // consecutive duplicates instead would leave that dangling `●` standing
        // in exactly the noisy case it was meant to help: the details differ by
        // their millisecond count, so consecutive discards are rarely identical.
        if (state === 'listening' && detail !== undefined && currentUtteranceId !== null) {
          say(`${c.dim}  ↩ ${detail}${c.reset}`);
          // Nothing about this utterance went upstream — no audio was sent, no
          // `utterance_end` follows, and there is no turn to close. Clearing it
          // is what makes the next `●` the only open one.
          currentUtteranceId = null;
        }
      },
    },
    pre.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: pre.idleTimeoutMs },
  );
  machine = capture;

  await device.start((frame) => capture.pushFrame(frame));
  capture.start();

  // THE ONE SENTENCE A PERSON NEEDS, and the one this host could not give
  // before: what happens to everything it hears, and what makes an agent
  // answer. Both halves are load-bearing — the first is a privacy fact, the
  // second is the whole interaction model.
  say(
    `${c.dim}Open mic: EVERYTHING heard here is transcribed by the server. An utterance ` +
      `reaches an agent only when it OPENS with a wake phrase — that phrase picks the ` +
      `personality — and follow-ups within ${Math.round(idleWindowMs / 1000)}s ` +
      `continue with the same one. Anything else is heard and discarded.${c.reset}`,
  );
  if (pinnedRoute === null) {
    const addressable = pushed.filter((r) => r.enabled);
    say(
      `${c.dim}Addressable here:${c.reset} ` +
        (addressable.length === 0
          ? `${c.dim}nothing yet — the server pushed an empty table.${c.reset}`
          : addressable
              .map(
                (r) =>
                  `${c.bold}"${r.phrase}"${c.reset}${c.dim} →${c.reset} ${c.cyan}${r.personalityId}${c.reset}`,
              )
              .join(`${c.dim},${c.reset} `)),
    );
  } else {
    say(
      `${c.dim}Pinned by --route: only${c.reset} ${c.bold}"${pinnedRoute.phrase}"${c.reset} ` +
        `${c.dim}→${c.reset} ${c.cyan}${pinnedRoute.personalityId}${c.reset}${c.dim} ` +
        `(route ${pinnedRoute.id}, ` +
        `${pinnedRoute.id.startsWith('auto:') ? 'synthesized by the server for this personality' : 'from voice.wake.routes'}` +
        `) can address this microphone. Other phrases are heard and discarded.${c.reset}`,
    );
  }
  say(
    `${c.dim}Listening on ${deviceInfo.label}. Press Ctrl+C to stop; close the pipe to stop talking.${c.reset}\n`,
  );

  const startedAt = new Date().toISOString();
  const writeHeartbeat = async (): Promise<void> => {
    const beat: ListenHeartbeat = {
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      adapters: [
        { name: 'satellite', ok: client.isOpen() },
        { name: 'capture', ok: captureState !== 'degraded' && captureState !== 'muted' },
      ],
      captureState,
    };
    await storage.writeAtomic(listenHealthPath(), JSON.stringify(beat)).catch(() => {
      // Best-effort — a missed tick is harmless; the reader treats stale data
      // as degraded, exactly as it does for the gateway.
    });
  };
  void writeHeartbeat();
  heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  ctx.onReady?.();
  await new Promise(() => {});
}

/** `CaptureState` has more states than the wire does; collapse honestly. */
function protocolState(state: CaptureState): 'listening' | 'muted' | 'speaking' | 'degraded' {
  switch (state) {
    case 'muted':
      return 'muted';
    case 'speaking':
      return 'speaking';
    case 'degraded':
      return 'degraded';
    default:
      // idle / listening / capturing / thinking are all "the microphone is
      // armed and this node is in a turn" as far as the indicator is concerned.
      return 'listening';
  }
}

/**
 * The `ethos_auth` cookie the web-api gates `/satellite/ws` behind.
 *
 * Read through `WebTokenRepository` — the same abstraction `ethos serve` and
 * the desktop main process use — so there is exactly one place that knows how
 * the token is minted, stored, and chmod'd. Imported lazily so `listen doctor`
 * does not pay for the web-api module graph.
 */
async function authCookie(storage: Storage): Promise<{ authCookie?: string }> {
  try {
    const { WebTokenRepository } = await import('@ethosagent/web-api');
    const token = await new WebTokenRepository({ dataDir: ethosDir(), storage }).getOrCreate();
    return { authCookie: `ethos_auth=${token}` };
  } catch {
    // No token yet (the web-api has never run here). The upgrade will be
    // refused and the client will retry — which is the right outcome, and a
    // clearer one than a satellite that never says why it cannot connect.
    return {};
  }
}
