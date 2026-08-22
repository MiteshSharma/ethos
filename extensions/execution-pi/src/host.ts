import { type ChildProcess, spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { buildKeepAliveArgs, scratchTmpfsFor } from '@ethosagent/execution-docker';
import type { AgentEvent, Logger, MountSpec, SteerSink } from '@ethosagent/types';
import { type PiGatePolicy, parseGateTitle } from './gate';
import { JsonlReader, type PiCommand, type PiEvent } from './protocol';
import { PiEventTranslator } from './translate';

/** Where the host copies Pi's config so Pi has a writable config dir (tmpfs). */
const CONTAINER_PI_CONFIG = '/tmp/pi-config';
/** Grace between SIGTERM and SIGKILL when tearing the host down. */
const KILL_GRACE_MS = 3_000;
/** How often the steer sink is drained and forwarded. */
const STEER_POLL_MS = 500;
/** Bounded tail of the host's stderr, reported when it dies without settling. */
const STDERR_TAIL_CHARS = 2_000;

export interface PiHostSpec {
  /** Doubles as Pi's `--session-id`, so a Resume lands on the same session. */
  jobId: string;
  prompt: string;
  /** Pi's cwd. Must be one of `mounts`, rw. */
  workspace: string;
  /** Pi's own session storage — a sibling of the workspace, also rw-mounted. */
  sessionDir: string;
  /** The container's ENTIRE view of the host filesystem. Derived by the docker backend. */
  mounts: MountSpec[];
  /** Digest-pinned image (`@sha256:`) with `pi` on PATH. */
  image: string;
  memoryMb: number;
  networkMode: 'none' | 'bridge';
  /** Host directory holding `auth.json` etc. Mounted ro; copied to a writable tmpfs. */
  piConfigDir: string;
  /** Host path of the gate extension. Mounted ro and passed to `--extension`. */
  extensionPath: string;
  /** Pi built-ins the run may use, as Pi's `--tools` takes them. */
  tools: string;
  signal: AbortSignal;
  steerSink: SteerSink;
  /**
   * I-LOG1 — out-of-band sink for this host's own subprocess output, so a
   * healthy run's diagnostics are readable via `task_logs`, not just folded
   * into the crash-time error message `stderrTail` already produces below.
   * Only stderr is wired today: stdout bytes outside Pi's own parsed
   * JSON-RPC frames (`onEvent`) aren't captured at all, additive to fix later
   * if that gap matters — not a regression of anything that exists now.
   */
  appendLog: (stream: 'stdout' | 'stderr', line: string) => void;
  gate: PiGatePolicy;
  logger?: Logger;
  /** Called once the host is live, so `describe()` can render real facts. */
  onStarted?: (info: { containerName: string; pid?: number }) => void;
}

/** `docker run -d` a keep-alive container, or throw with the daemon's reason. */
async function startContainer(spec: PiHostSpec, containerName: string): Promise<void> {
  const info = userInfo();
  const args = buildKeepAliveArgs({
    image: spec.image,
    containerName,
    memoryMb: spec.memoryMb,
    networkMode: spec.networkMode,
    uid: info.uid,
    gid: info.gid,
    mounts: spec.mounts,
    tmpfs: scratchTmpfsFor(spec.mounts),
    cwd: spec.workspace,
  });
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve('') : resolve(err || `exit ${code}`)));
  });
  if (stderr) throw new Error(`docker run failed for the Pi host: ${stderr.trim()}`);
}

/**
 * `docker exec` into the live container and run `pi --mode rpc` with the host
 * owning both ends of its stdio.
 *
 * The prelude copies Pi's config into a tmpfs directory because Pi writes to
 * its config dir (trust, settings) and the host mount is read-only — and
 * because the container runs as a uid with no passwd entry, so Pi's own
 * `homedir()` resolves to nothing and it must be told where its config lives.
 * Arguments travel as `$@`, never interpolated into the script string, so no
 * host path can be read as shell syntax.
 */
function startPi(spec: PiHostSpec, containerName: string): ChildProcess {
  const prelude = 'mkdir -p "$1" && cp -a "$2"/. "$1"/ && shift 2 && exec "$@"';
  const args = [
    'exec',
    '-i',
    '-e',
    'HOME=/tmp',
    '-e',
    'PI_OFFLINE=1',
    '-e',
    `PI_CODING_AGENT_DIR=${CONTAINER_PI_CONFIG}`,
    '-w',
    spec.workspace,
    containerName,
    'bash',
    '-c',
    prelude,
    'ethos-pi-host',
    CONTAINER_PI_CONFIG,
    spec.piConfigDir,
    'pi',
    '--mode',
    'rpc',
    '--session-id',
    spec.jobId,
    '--session-dir',
    spec.sessionDir,
    '--tools',
    spec.tools,
    '--extension',
    spec.extensionPath,
  ];
  return spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Run one job on a sandboxed Pi host and yield the child turn's `AgentEvent`s.
 *
 * The shape is a queue-backed async generator rather than an event pipe because
 * the caller (the executor) drives consumption: it decides when to persist, and
 * a slow consumer must not lose events. Nothing here blocks on Pi — a gate
 * round-trip is a promise keyed by `requestId`, answered on a later tick.
 */
export async function* runPiHost(spec: PiHostSpec): AsyncIterable<AgentEvent> {
  const containerName = `ethos-pi-${spec.jobId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  await startContainer(spec, containerName);

  const child = startPi(spec, containerName);
  spec.onStarted?.({ containerName, ...(child.pid !== undefined ? { pid: child.pid } : {}) });

  const translator = new PiEventTranslator();
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  let closed = false;
  let aborted = false;
  let stderrTail = '';
  let started = false;
  // Line-buffer for `appendLog`, independent of `stderrTail` above: that tail
  // is a raw bounded string for the crash-time error message, this is
  // line-split output for the running audit trail (I-LOG1).
  let stderrLineBuffer = '';

  const bump = (): void => {
    wake?.();
    wake = null;
  };
  const send = (cmd: PiCommand): void => {
    if (closed || !child.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    } catch {
      /* host already gone; the close handler ends the stream */
    }
  };

  const onEvent = (evt: PiEvent): void => {
    // The gate's round-trip: answer it and keep going. It is NOT an AgentEvent
    // — no variant carries an elicitation, and Phase 4 routes these to a human
    // through the worker router instead of the policy below.
    if (evt.type === 'extension_ui_request') {
      const req = evt as Extract<PiEvent, { type: 'extension_ui_request' }>;
      const parsed = parseGateTitle(req.title);
      if (!parsed) return; // another extension's dialog — not ours to answer
      void spec
        .gate({
          requestId: req.id,
          jobId: spec.jobId,
          kind: req.method,
          toolName: parsed.toolName,
          digest: parsed.digest,
        })
        .then((answer) =>
          send({
            type: 'extension_ui_response',
            id: req.id,
            value: answer.allow ? 'allow' : 'deny',
          }),
        )
        .catch((err: unknown) => {
          // A policy that throws must not wedge the blocked tool call. Deny is
          // the safe answer: the tool does not run and the model is told why.
          spec.logger?.warn('pi gate policy failed; denying the tool call', { err });
          send({ type: 'extension_ui_response', id: req.id, value: 'deny' });
        });
      return;
    }
    if (evt.type === 'extension_error') {
      spec.logger?.warn('pi extension error', {
        error: (evt as { error?: string }).error,
        jobId: spec.jobId,
      });
      return;
    }
    // The handshake: `get_state` answers only once Pi is up with its extensions
    // loaded, which is what makes the prompt safe to send — a prompt racing
    // extension load could run a tool call before the gate is registered.
    if (evt.type === 'response' && (evt as { command?: string }).command === 'get_state') {
      if (!started) {
        started = true;
        send({ id: `prompt-${spec.jobId}`, type: 'prompt', message: spec.prompt });
      }
      return;
    }
    queue.push(...translator.translate(evt));
    if (evt.type === 'agent_settled') settled = true;
    bump();
  };

  const reader = new JsonlReader();
  const decoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of reader.push(decoder.write(chunk))) {
      let evt: PiEvent;
      try {
        evt = JSON.parse(line) as PiEvent;
      } catch {
        spec.logger?.debug('pi host emitted an unparseable line', { line: line.slice(0, 200) });
        continue;
      }
      onEvent(evt);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
    stderrLineBuffer += text;
    const lines = stderrLineBuffer.split('\n');
    stderrLineBuffer = lines.pop() ?? '';
    for (const line of lines) spec.appendLog('stderr', line);
  });
  child.on('close', () => {
    // Whatever's left without a trailing newline is still a line worth
    // keeping — most processes don't end their last write with one.
    if (stderrLineBuffer) {
      spec.appendLog('stderr', stderrLineBuffer);
      stderrLineBuffer = '';
    }
    closed = true;
    bump();
  });
  child.on('error', (err) => {
    stderrTail = `${stderrTail}\n${err.message}`.slice(-STDERR_TAIL_CHARS);
    closed = true;
    bump();
  });

  // Steering rides the existing sink: drained on a timer and forwarded as Pi's
  // own `steer` command, which queues and lands after the in-flight tool call.
  const steerTimer = setInterval(() => {
    if (spec.steerSink.depth() === 0) return;
    for (const text of spec.steerSink.drain()) send({ type: 'steer', message: text });
  }, STEER_POLL_MS);
  steerTimer.unref?.();

  const onAbort = (): void => {
    aborted = true;
    send({ type: 'abort' });
    bump();
  };
  if (spec.signal.aborted) aborted = true;
  else spec.signal.addEventListener('abort', onAbort, { once: true });

  send({ id: `init-${spec.jobId}`, type: 'get_state' });

  try {
    for (;;) {
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev) yield ev;
      }
      // Cancellation stops the run HERE rather than waiting for Pi's next
      // event: a host that has gone quiet would otherwise keep the executor
      // parked on an aborted job forever.
      if (aborted) return;
      if (settled) {
        for (const ev of translator.finish()) yield ev;
        return;
      }
      if (closed) {
        yield {
          type: 'error',
          error: `pi host exited before the run settled${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`,
          code: 'pi_host_died',
        };
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    clearInterval(steerTimer);
    spec.signal.removeEventListener('abort', onAbort);
    await teardown(child, containerName);
  }
}

/**
 * Stop the host. SIGTERM the exec first so Pi can flush its session file, then
 * SIGKILL, then remove the container — which is what actually guarantees no
 * process survives, since the exec's pid is the docker client, not Pi.
 */
async function teardown(child: ChildProcess, containerName: string): Promise<void> {
  try {
    child.stdin?.end();
  } catch {
    /* already gone */
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, KILL_GRACE_MS);
      timer.unref?.();
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await new Promise<void>((resolve) => {
    const rm = spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    rm.on('close', () => resolve());
    rm.on('error', () => resolve());
  });
}
