import { type ChildProcess, spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { buildKeepAliveArgs, scratchTmpfsFor } from '@ethosagent/execution-docker';
import type { AgentEvent, Logger, MountSpec, SteerSink } from '@ethosagent/types';
import { AcpConnection } from './acp-connection';
import type { AcpGatePolicy, AcpGateRequest } from './acp-gate';
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotificationParams,
} from './acp-protocol';
import { AcpEventTranslator } from './translate';

/** Grace between SIGTERM and SIGKILL when tearing the host down. */
const KILL_GRACE_MS = 3_000;
/** Bounded tail of the agent process's stderr, reported when it dies without settling. */
const STDERR_TAIL_CHARS = 2_000;
/** Cap on the digest a gate prompt/log line carries — legible, never a full payload dump. */
const DIGEST_MAX_CHARS = 300;

/**
 * Narrow shape of `child_process.spawn` this module actually calls with —
 * injectable so tests can substitute a fake `docker` process (framing and
 * correlation are then fully unit-testable, no Docker daemon or real agent
 * needed), the same DI shape `worktree.ts`'s `CommandRunner` already uses for
 * `git`.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: Array<'ignore' | 'pipe'> | 'ignore' },
) => ChildProcess;

export interface AcpHostSpec {
  jobId: string;
  prompt: string;
  /** The agent's cwd. Must be one of `mounts`, rw. */
  workspace: string;
  /** The container's ENTIRE view of the host filesystem. Derived by the docker backend. */
  mounts: MountSpec[];
  /** Digest-pinned image (`@sha256:`) with the agent binary reachable inside it. */
  image: string;
  memoryMb: number;
  networkMode: 'none' | 'bridge';
  /**
   * The ACP agent binary to exec inside the container (e.g. `claude-agent-acp`,
   * or `npx` with `args: ['-y', '@agentclientprotocol/claude-agent-acp']`).
   * Config-driven per registered agent id is T4/I3 — this spec just takes
   * whatever it's given.
   */
  command: string;
  args: string[];
  signal: AbortSignal;
  steerSink: SteerSink;
  /**
   * I-LOG1 — out-of-band sink for the agent process's own stderr, so a
   * healthy run's diagnostics are readable via `task_logs`. Only stderr is
   * wired: stdout carries the JSON-RPC protocol frames themselves, not free
   * text, so there is no analogous "stdout bytes outside the parsed frames"
   * gap the way Pi's host has one — a non-JSON stdout line is logged via the
   * connection's own debug channel instead (protocol noise, not a run log).
   */
  appendLog: (stream: 'stdout' | 'stderr', line: string) => void;
  gate: AcpGatePolicy;
  logger?: Logger;
  /** Called once the host is live, so `describe()` can render real facts. */
  onStarted?: (info: { containerName: string; pid?: number }) => void;
}

/** `docker run -d` a keep-alive container, or throw with the daemon's reason. */
async function startContainer(
  spec: AcpHostSpec,
  containerName: string,
  spawnFn: SpawnFn,
): Promise<void> {
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
    const child = spawnFn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve('') : resolve(err || `exit ${code}`)));
  });
  if (stderr) throw new Error(`docker run failed for the ACP agent host: ${stderr.trim()}`);
}

/**
 * `docker exec` into the live container and run the agent binary with the
 * host owning both ends of its stdio.
 *
 * No credential-copy prelude the way Pi's host has (auth.json -> tmpfs):
 * container credential mounting for a real ACP agent is the plan's Open
 * Question 2, unresolved — deferred to I3/T4, not invented here.
 */
function startAgent(spec: AcpHostSpec, containerName: string, spawnFn: SpawnFn): ChildProcess {
  const args = ['exec', '-i', '-w', spec.workspace, containerName, spec.command, ...spec.args];
  return spawnFn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Compact, legible, truncated digest of a tool call's raw input. Never authoritative. */
function digestOf(rawInput: unknown): string {
  if (rawInput === undefined) return '';
  try {
    const text = JSON.stringify(rawInput);
    return text.length > DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS)}…` : text;
  } catch {
    return String(rawInput);
  }
}

/**
 * Run one job on a sandboxed ACP agent host and yield the turn's
 * `AgentEvent`s. Same queue-backed async-generator shape as
 * `execution-pi/src/host.ts`'s `runPiHost` — the caller (the executor) drives
 * consumption, and a gate round-trip is a promise answered on a later tick,
 * never a blocking wait inside this loop.
 */
export async function* runAcpHost(
  spec: AcpHostSpec,
  deps: { spawn?: SpawnFn } = {},
): AsyncIterable<AgentEvent> {
  const spawnFn = deps.spawn ?? spawn;
  const containerName = `ethos-acp-${spec.jobId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  await startContainer(spec, containerName, spawnFn);

  const child = startAgent(spec, containerName, spawnFn);
  spec.onStarted?.({ containerName, ...(child.pid !== undefined ? { pid: child.pid } : {}) });

  const translator = new AcpEventTranslator();
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let aborted = false;
  let finished = false;
  // Boxed rather than a bare `let`: TypeScript's control-flow narrowing does
  // not account for a reassignment happening inside a closure (the handshake
  // IIFE below) when the enclosing generator body never assigns it directly —
  // a bare `let failure: Error | null` narrows to `never` at the `if
  // (failure)` check below, past the closure boundary, and `.message` fails
  // to typecheck. A one-field object sidesteps the analysis entirely.
  const failureBox: { current: Error | null } = { current: null };
  let stderrTail = '';
  let stderrLineBuffer = '';
  let sessionId: string | undefined;

  const bump = (): void => {
    wake?.();
    wake = null;
  };

  const conn = new AcpConnection(
    (line) => {
      if (closed || !child.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(line);
      } catch {
        /* host already gone; the close handler ends the stream */
      }
    },
    async (method, params) => {
      if (method !== ACP_METHODS.requestPermission) {
        // Any other inbound request (fs/*, terminal/*, …) — this host does
        // not implement them (`clientCapabilities` says so at `initialize`
        // time), so a well-behaved agent should not send them. If one does
        // anyway, a JSON-RPC "method not found" error is the honest answer —
        // never a silent hang.
        throw new Error(`unsupported client method: ${method}`);
      }
      const p = params as AcpRequestPermissionParams;
      const label = p.toolCall.name ?? p.toolCall.title ?? undefined;
      const gateReq: AcpGateRequest = {
        requestId: p.toolCall.toolCallId,
        jobId: spec.jobId,
        sessionId: p.sessionId,
        toolCallId: p.toolCall.toolCallId,
        ...(label ? { toolName: label } : {}),
        ...(p.toolCall.kind ? { kind: p.toolCall.kind } : {}),
        digest: digestOf(p.toolCall.rawInput),
        options: p.options,
      };
      try {
        const outcome = await spec.gate(gateReq);
        return { outcome } satisfies AcpRequestPermissionResult;
      } catch (err) {
        // A policy that throws must not wedge the blocked tool call, and must
        // never be read as an allow. Cancel is the safe answer.
        spec.logger?.warn('acp host: gate policy failed; cancelling the permission request', {
          jobId: spec.jobId,
          toolCallId: p.toolCall.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { outcome: { outcome: 'cancelled' } } satisfies AcpRequestPermissionResult;
      }
    },
    (method, params) => {
      if (method !== ACP_METHODS.sessionUpdate) return; // forward-compatible no-op
      const n = params as AcpSessionNotificationParams;
      queue.push(...translator.translate(n.update));
      bump();
    },
    spec.logger,
  );

  const decoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer) => {
    conn.push(decoder.write(chunk));
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
    if (stderrLineBuffer) {
      spec.appendLog('stderr', stderrLineBuffer);
      stderrLineBuffer = '';
    }
    closed = true;
    conn.rejectAllPending(new Error('acp agent process exited'));
    bump();
  });
  child.on('error', (err) => {
    stderrTail = `${stderrTail}\n${err.message}`.slice(-STDERR_TAIL_CHARS);
    closed = true;
    conn.rejectAllPending(err);
    bump();
  });

  const onAbort = (): void => {
    aborted = true;
    if (sessionId) conn.notify(ACP_METHODS.sessionCancel, { sessionId });
    bump();
  };
  if (spec.signal.aborted) aborted = true;
  else spec.signal.addEventListener('abort', onAbort, { once: true });

  // The handshake: initialize -> session/new -> session/prompt. Deliberately
  // sequential (not raced against the read loop above) — a prompt racing
  // ahead of `initialize`'s handshake would be a protocol violation the same
  // way a Pi prompt racing extension load would be.
  void (async () => {
    try {
      await conn.request<AcpInitializeResult>(ACP_METHODS.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'ethos' },
      });
      const session = await conn.request<AcpNewSessionResult>(ACP_METHODS.sessionNew, {
        cwd: spec.workspace,
        mcpServers: [],
      });
      sessionId = session.sessionId;
      if (aborted) return; // cancelled before the turn ever started
      const result = await conn.request<AcpPromptResult>(ACP_METHODS.sessionPrompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: spec.prompt }],
      });
      queue.push(...translator.finish(result));
      finished = true;
    } catch (err) {
      failureBox.current = err instanceof Error ? err : new Error(String(err));
    } finally {
      bump();
    }
  })();

  try {
    for (;;) {
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev) yield ev;
      }
      // Cancellation stops the run HERE rather than waiting for the agent's
      // next event: a host gone quiet post-cancel would otherwise keep the
      // executor parked on an aborted job forever.
      if (aborted) return;
      if (finished) return;
      if (failureBox.current) {
        yield {
          type: 'error',
          error: `acp agent handshake failed: ${failureBox.current.message}${stderrTail.trim() ? ` (${stderrTail.trim()})` : ''}`,
          code: 'acp_handshake_failed',
        };
        return;
      }
      if (closed) {
        yield {
          type: 'error',
          error: `acp agent process exited before the run settled${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`,
          code: 'acp_host_died',
        };
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    spec.signal.removeEventListener('abort', onAbort);
    await teardown(child, containerName, spawnFn);
  }
}

/**
 * Stop the host. SIGTERM the exec first, then SIGKILL, then remove the
 * container — which is what actually guarantees no process survives, since
 * the exec's pid is the docker client, not the agent.
 */
async function teardown(
  child: ChildProcess,
  containerName: string,
  spawnFn: SpawnFn,
): Promise<void> {
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
    const rm = spawnFn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    rm.on('close', () => resolve());
    rm.on('error', () => resolve());
  });
}
