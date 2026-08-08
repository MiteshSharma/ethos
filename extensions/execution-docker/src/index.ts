// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach substitution
// tokens (`${ETHOS_HOME}` etc.) are literal markers resolved at runtime, not JS
// template strings.
import { type ChildProcess, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
// The fs_reach derivation is SHARED with the app-layer ScopedStorage scope
// (packages/core/src/fs-reach.ts). Two copies would drift into silent data
// loss: a write ScopedStorage permits but no mount backs is written into the
// container's ephemeral layer and discarded by `docker run --rm`.
import { deriveFsReachPaths, type FsReachVars, substitute } from '@ethosagent/core';
import type {
  Constitution,
  ExecChunk,
  ExecOpts,
  ExecRpcResponse,
  ExecSession,
  ExecutionBackend,
  ExecutionBackendConfig,
  Logger,
  MountSpec,
  PersonalityConfig,
  SandboxAttestation,
  SecretsResolver,
} from '@ethosagent/types';
import {
  encodeFrame,
  FrameParser,
  type HostFrame,
  RPC_PROTOCOL_VERSION,
  RpcProtocolError,
  RpcVersionMismatchError,
  type ShimFrame,
} from './frames';

// Re-exported so downstream consumers (and this package's tests) keep importing
// the fs_reach substitution failure from the backend that throws it, even though
// the canonical class now lives in core alongside the shared derivation.
export { EmptySubstitutionError } from '@ethosagent/core';
export * from './frames';

export class ExecAbortedError extends Error {
  readonly code = 'EXEC_ABORTED';
  constructor(message = 'Execution aborted') {
    super(message);
    this.name = 'ExecAbortedError';
  }
}

export class ExecTimeoutError extends Error {
  readonly code = 'EXEC_TIMEOUT';
  constructor(message = 'Execution timed out') {
    super(message);
    this.name = 'ExecTimeoutError';
  }
}

export class InvalidImageRefError extends Error {
  readonly code = 'INVALID_IMAGE_REF';
  constructor(public readonly ref: string) {
    super(`Image ref must be digest-pinned (@sha256:): ${ref}`);
    this.name = 'InvalidImageRefError';
  }
}

export class DockerUnavailableError extends Error {
  readonly code = 'DOCKER_UNAVAILABLE';
  constructor() {
    super('Docker is not available; refusing to fall back to local execution');
    this.name = 'DockerUnavailableError';
  }
}

export class ForbiddenMountError extends Error {
  readonly code = 'FORBIDDEN_MOUNT';
  constructor(public readonly path: string) {
    super(`Refusing to mount a forbidden host path: ${path}`);
    this.name = 'ForbiddenMountError';
  }
}

export class ConstitutionMountError extends Error {
  readonly code = 'CONSTITUTION_MOUNT_DENIED';
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Refusing to mount "${path}": ${reason}`);
    this.name = 'ConstitutionMountError';
  }
}

/**
 * Built-in critical denylist (review A2). These host paths grant container
 * escape (docker socket) or expose the host kernel/devices; `mountsFor`
 * refuses them UNCONDITIONALLY — independent of any constitution. A path is
 * forbidden if its resolved absolute form equals a denied root or is nested
 * under one (e.g. `/proc/self`, `/dev/mem`).
 */
const FORBIDDEN_MOUNT_ROOTS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/proc',
  '/sys',
  '/dev',
] as const;

/** Ephemeral writable scratch (review #5). tmpfs — not a host bind mount. */
const SCRATCH_TMPFS_PATHS = ['/tmp', '/home/sandbox'] as const;

/**
 * Scratch tmpfs entries that don't collide with a derived fs_reach mount.
 * Precedence: an explicit fs_reach bind mount wins over the convenience
 * scratch tmpfs — when both target the same mount point, Docker rejects the
 * container ("Duplicate mount point"), so we drop the scratch entry and let
 * the fs_reach bind provide that path.
 */
export function scratchTmpfsFor(mounts: MountSpec[]): string[] {
  const mounted = new Set(mounts.map((m) => m.containerPath));
  return SCRATCH_TMPFS_PATHS.filter((p) => !mounted.has(p));
}

/**
 * `--workdir` args for a requested `ExecOpts.cwd` — empty when the path is not
 * one the container can actually see.
 *
 * `mountsFor` binds with identity mapping (`hostPath === containerPath`), so a
 * mounted host path exists at the same absolute path inside the container and
 * `-w` lands the shell exactly where the file tools write. A path OUTSIDE the
 * mount set is the dangerous case: Docker does not fail on it, it CREATES the
 * directory in the container's own writable layer, and `docker run --rm`
 * discards whatever is written there — the same silent data loss the fs_reach
 * parity test exists to prevent. So an unmounted cwd is dropped and the image's
 * own WORKDIR stands, which is exactly what every cwd got before this flag
 * existed. A personality that declares `fs_reach.workdir` always lands in the
 * mounted branch: `deriveFsReachPaths` injects a declared workdir into both the
 * read and the write list, so it is always bound.
 */
export function workdirArgsFor(cwd: string | undefined, mounts: MountSpec[]): string[] {
  if (!cwd) return [];
  const containerPath = resolvePath(cwd);
  return mounts.some((m) => m.containerPath === containerPath) ? ['--workdir', containerPath] : [];
}

/**
 * Resolve a personality's `safety.network` policy to the binary container
 * network posture (Phase 2a, review g). The OS-layer gate is binary —
 * `bridge` (open egress) or `none` (air-gapped) — because per-hostname egress
 * filtering is an explicit follow-up (it needs a filtering proxy plus
 * direct-to-IP handling; see plan §(g)).
 *
 * Resolution (SAFE-by-default — only an explicit open-egress opt-in yields
 * `bridge`):
 *
 *   - no `safety.network` block            → deny-all → `none` (unspecified is safe)
 *   - `allow` is an empty array `[]`        → deny-all → `none`
 *       (matches the constitution A5 deny-all signal in
 *        `extensions/constitution`: `isDenyAll = Array.isArray(allow) &&
 *        allow.length === 0`; the OS gate MUST agree so a constitution that
 *        forbids hosts is honored at the container layer, not just at load.)
 *   - `allow` is a non-empty allowlist      → deny-all → `none`
 *       (per-host filtering is deferred; we cannot honor the allowlist at the
 *        OS layer, so we fail safe rather than open the whole bridge.)
 *   - `allow` is absent (network block set) → allow-all → `bridge`
 *       (open public internet — the same "empty/absent allow = open" reading
 *        SafeFetch uses in `packages/safety/network/src/policy.ts`.)
 *
 * The host-side `SafeFetch` allow[]/deny[]/allow_private_urls enforcement is
 * unchanged — this gate is the complementary OS-layer egress control for
 * shell/code, not a replacement.
 */
export function resolveNetworkMode(p?: PersonalityConfig): 'none' | 'bridge' {
  const network = p?.safety?.network;
  if (!network) return 'none';
  // `allow` present (even as `[]`) means the personality constrains egress to
  // specific hosts — which the binary OS gate cannot honor — so we fail safe.
  if (network.allow !== undefined) return 'none';
  return 'bridge';
}

/** Output byte ceiling per exec (review #6). Past this the exec is killed. */
const MAX_EXEC_OUTPUT_BYTES = 1_000_000;

/**
 * True when `p` resolves to or under one of the forbidden mount roots.
 * Exported so the wiring-layer `fs_reach` directory pre-creation reuses THIS
 * denylist rather than growing a second one that could disagree with it.
 */
export function isForbiddenMount(p: string): boolean {
  const abs = resolvePath(p);
  return FORBIDDEN_MOUNT_ROOTS.some((root) => abs === root || abs.startsWith(`${root}/`));
}

/**
 * Resolve a host path's real (symlink-followed) target (F5). `resolvePath` is
 * purely lexical, so a declared mount that is a SYMLINK to `/var/run/docker.sock`
 * (or `/proc`, `/dev`, …) would pass the lexical denylist while Docker follows
 * the link into the forbidden target. Re-checking the realpath closes that
 * bypass. Non-existent paths have no real target — `realpathSync` throws ENOENT;
 * we fall back to the lexical path (the not-yet-created case is still subject to
 * the lexical check, and Docker creates a fresh dir, not a forbidden target).
 */
function realPathOrLexical(hostPath: string): string {
  try {
    return realpathSync(hostPath);
  } catch {
    return hostPath;
  }
}

/** True when `path` equals `prefix` or is nested under it (path-segment safe). */
function isUnderPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/**
 * Enforce the operator constitution's filesystem mount policy against an
 * already-resolved host path (F2). Unlike the load-time `enforceConstitution`
 * check — which only sees a personality's DECLARED `fs_reach` and is skipped
 * entirely when `fs_reach` is empty — this runs against the ACTUAL derived mount
 * set, so the `ownDir`/`skills`/`cwd` defaults a personality with no `fs_reach`
 * gets are covered too. Throws `ConstitutionMountError` on the first violation.
 *
 * - `deniedPathPrefixes`: refuse any mount at or under a denied prefix.
 * - `allowedMountRoots` (when non-empty): every mount must sit under at least
 *   one allowed root; otherwise refuse. An empty/absent list is permissive.
 *
 * The built-in `FORBIDDEN_MOUNT_ROOTS` denylist still applies unconditionally
 * on top (checked separately in `mountsFor`).
 */
function checkConstitutionMount(
  hostPath: string,
  constitution: Constitution | undefined,
  vars: FsReachVars,
): void {
  const fs = constitution?.filesystem;
  if (!fs) return;

  const denied = (fs.deniedPathPrefixes ?? []).map((d) => substitute(d, vars));
  for (const prefix of denied) {
    if (isUnderPath(hostPath, prefix)) {
      throw new ConstitutionMountError(hostPath, `under constitution denied prefix "${prefix}"`);
    }
  }

  const roots = (fs.allowedMountRoots ?? []).map((r) => substitute(r, vars));
  if (roots.length > 0 && !roots.some((root) => isUnderPath(hostPath, root))) {
    throw new ConstitutionMountError(
      hostPath,
      'outside the constitution allowedMountRoots allowlist',
    );
  }
}

/**
 * Queue-backed async generator that streams interleaved stdout/stderr chunks
 * from a spawned child process. Self-contained per backend (duplicated, not
 * shared) so each execution package has zero cross-package coupling.
 *
 * Two modes, gated on `opts.rpc` (tools-as-code-api Lane A):
 *
 * - Absent → today's path, byte-identical: raw stdout/stderr passthrough,
 *   stdin written once then ended.
 * - Present → framed mode: the container's stdout carries shim frames, which
 *   are demultiplexed HERE — before `withByteCeiling` — so the output byte
 *   ceiling counts only `output` frames, never RPC traffic. `opts.stdin` is
 *   delivered as a `script` frame and stdin stays OPEN so `rpc_response`
 *   frames can flow back for the execution's lifetime. `rpc_request` frames
 *   are answered via `opts.rpc.onRequest`, serialized (one in-flight call at
 *   a time), off the chunk-pump path — so a slow (or never-resolving) handler
 *   cannot stall or outlive the exec stream: timeout/abort still kill the
 *   container and terminate the stream, and a response that completes after
 *   teardown is dropped, not written to a dead pipe.
 *
 * Exported for transport unit tests (driven with a scripted fake child — no
 * Docker needed); not part of the backend's public contract.
 */
export async function* streamChild(
  child: ChildProcess,
  opts: ExecOpts,
  killContainer: () => void,
): AsyncIterable<ExecChunk> {
  const chunks: ExecChunk[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;
  let exitCode: number | null = null;

  const rpc = opts.rpc;
  let rpcTeardown: (() => void) | null = null;
  if (rpc) {
    const parser = new FrameParser();
    let sawHello = false;
    let closed = false;
    let rpcChain: Promise<void> = Promise.resolve();
    rpcTeardown = () => {
      closed = true;
      try {
        child.stdin?.end();
      } catch {
        /* container already gone */
      }
    };
    const failProtocol = (err: Error) => {
      error = err;
      child.kill('SIGKILL');
      killContainer();
      done = true;
      resolveNext?.();
    };
    const writeFrame = (frame: HostFrame) => {
      if (closed || !child.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(encodeFrame(frame));
      } catch {
        /* container died mid-write; the stream error surfaces separately */
      }
    };
    const onFrame = (frame: ShimFrame): void => {
      if (!sawHello) {
        if (frame.type !== 'hello') {
          failProtocol(new RpcProtocolError(`first frame must be 'hello', got '${frame.type}'`));
        } else if (frame.version !== RPC_PROTOCOL_VERSION) {
          failProtocol(new RpcVersionMismatchError(RPC_PROTOCOL_VERSION, frame.version));
        } else {
          sawHello = true;
        }
        return;
      }
      if (frame.type === 'output') {
        chunks.push({ stream: frame.stream, data: frame.data });
        return;
      }
      if (frame.type === 'rpc_request') {
        const { id, name, args } = frame;
        // Serialized v1 contract: requests are answered strictly in order.
        rpcChain = rpcChain.then(async () => {
          let res: ExecRpcResponse;
          try {
            res = await rpc.onRequest({ name, args });
          } catch (err) {
            // Errors are data on this boundary; a throwing handler must not
            // wedge the shim's blocked client.
            res = {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              code: 'rpc_handler_error',
            };
          }
          writeFrame({ type: 'rpc_response', id, ...res });
        });
        return;
      }
      failProtocol(new RpcProtocolError(`unexpected frame type '${frame.type}'`));
    };
    child.stdout?.on('data', (c: Buffer) => {
      let frames: ShimFrame[];
      try {
        frames = parser.push(c);
      } catch (err) {
        failProtocol(err instanceof Error ? err : new RpcProtocolError(String(err)));
        return;
      }
      for (const frame of frames) {
        if (done) break;
        onFrame(frame);
      }
      resolveNext?.();
    });
  } else {
    child.stdout?.on('data', (c: Buffer) => {
      chunks.push({ stream: 'stdout', data: c.toString('utf-8') });
      resolveNext?.();
    });
  }
  child.stderr?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stderr', data: c.toString('utf-8') });
    resolveNext?.();
  });
  // `docker run` exits with the in-container command's exit code (bash -lc cmd).
  child.on('close', (code) => {
    exitCode = code ?? null;
    done = true;
    resolveNext?.();
  });
  child.on('error', (err: Error) => {
    error = err;
    done = true;
    resolveNext?.();
  });

  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => {
    error = new ExecTimeoutError();
    child.kill('SIGKILL');
    killContainer();
    done = true;
    resolveNext?.();
  }, timeoutMs);

  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) {
      error = new ExecAbortedError();
      done = true;
    } else {
      signal.addEventListener(
        'abort',
        () => {
          error = new ExecAbortedError();
          child.kill('SIGKILL');
          killContainer();
          done = true;
          resolveNext?.();
        },
        { once: true },
      );
    }
  }

  if (rpc) {
    // Framed mode: deliver the script as frame 0 and keep stdin OPEN — the
    // rpc_response frames flow back on it for the execution's lifetime.
    child.stdin?.write(
      encodeFrame({ type: 'script', version: RPC_PROTOCOL_VERSION, code: opts.stdin ?? '' }),
    );
  } else {
    if (opts.stdin !== undefined) child.stdin?.write(opts.stdin, 'utf-8');
    child.stdin?.end();
  }

  try {
    while (true) {
      while (chunks.length > 0) {
        const c = chunks.shift();
        if (c) yield c;
      }
      if (error) throw error;
      if (done) {
        while (chunks.length > 0) {
          const c = chunks.shift();
          if (c) yield c;
        }
        yield { stream: 'exit', code: exitCode ?? -1 };
        break;
      }
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  } finally {
    clearTimeout(timer);
    rpcTeardown?.();
  }
}

/**
 * Byte-ceiling wrapper (review #6). Counts bytes yielded by `inner`; once the
 * running total exceeds `maxBytes` it kills the child + container, emits a
 * final stderr truncation marker, and stops. The cap is enforced HERE — inside
 * the exec stream — so host memory stays bounded regardless of downstream
 * result trimming.
 */
export async function* withByteCeiling(
  inner: AsyncIterable<ExecChunk>,
  maxBytes: number,
  onCeiling: () => void,
): AsyncIterable<ExecChunk> {
  let total = 0;
  for await (const chunk of inner) {
    // The terminal exit chunk carries no payload — pass it through untouched so
    // the exit code survives truncation, and don't count it toward the ceiling.
    if (chunk.stream === 'exit') {
      yield chunk;
      continue;
    }
    total += Buffer.byteLength(chunk.data, 'utf-8');
    if (total > maxBytes) {
      onCeiling();
      yield { stream: 'stderr', data: `\n[output truncated at ${maxBytes} bytes]\n` };
      return;
    }
    yield chunk;
  }
}

/**
 * Build `docker run` args (after the program name). Pure — no spawning.
 * Throws InvalidImageRefError unless the image is digest-pinned (@sha256:).
 */
export function buildDockerArgs(opts: {
  image: string;
  cmd: string;
  containerName: string;
  memoryMb: number;
  networkMode: 'none' | 'bridge';
  uid: number;
  gid: number;
  stdin: boolean;
  env?: Record<string, string>;
  mounts?: MountSpec[];
  tmpfs?: readonly string[];
  /** `ExecOpts.cwd`. Emitted as `--workdir` only when it is mounted — see
   *  {@link workdirArgsFor}. */
  cwd?: string;
}): string[] {
  if (!opts.image.includes('@sha256:')) {
    throw new InvalidImageRefError(opts.image);
  }
  const args: string[] = ['run', '--rm', '--name', opts.containerName];
  if (opts.stdin) args.push('-i');
  args.push('--network', opts.networkMode);
  args.push(`--memory=${opts.memoryMb}m`, '--memory-swap', `${opts.memoryMb}m`);
  args.push('--cpus', '2', '--pids-limit', '256');
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  // uid/gid are -1 on Windows; CI is macOS/Linux
  if (opts.uid >= 0 && opts.gid >= 0) {
    args.push('--user', `${opts.uid}:${opts.gid}`);
  }
  args.push('--pull=never');
  // Ephemeral writable scratch (review #5) — discarded on container teardown.
  for (const path of opts.tmpfs ?? []) {
    args.push('--tmpfs', path);
  }
  // Host bind mounts derived from fs_reach (review d). The container sees ONLY
  // these host paths; nothing else from the host is reachable.
  for (const m of opts.mounts ?? []) {
    args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
  }
  args.push(...workdirArgsFor(opts.cwd, opts.mounts ?? []));
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }
  args.push('--', opts.image, 'bash', '-lc', opts.cmd);
  return args;
}

/**
 * Build `docker run -d ... sleep infinity` args for a long-lived session
 * container. Distinct from buildDockerArgs (which is `--rm` + `bash -lc cmd`):
 * this keeps the container alive so a persistent `docker exec` shell can run
 * many commands against it. Throws InvalidImageRefError unless digest-pinned.
 */
export function buildKeepAliveArgs(opts: {
  image: string;
  containerName: string;
  memoryMb: number;
  networkMode: 'none' | 'bridge';
  uid: number;
  gid: number;
  mounts?: MountSpec[];
  tmpfs?: readonly string[];
  /** `ExecOpts.cwd` of the exec that started the session. Emitted as
   *  `--workdir` only when it is mounted — see {@link workdirArgsFor}. The
   *  container's workdir is inherited by every later `docker exec` on it. */
  cwd?: string;
}): string[] {
  if (!opts.image.includes('@sha256:')) {
    throw new InvalidImageRefError(opts.image);
  }
  const args: string[] = ['run', '-d', '--name', opts.containerName];
  args.push('--network', opts.networkMode);
  args.push(`--memory=${opts.memoryMb}m`, '--memory-swap', `${opts.memoryMb}m`);
  args.push('--cpus', '2', '--pids-limit', '256');
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  if (opts.uid >= 0 && opts.gid >= 0) {
    args.push('--user', `${opts.uid}:${opts.gid}`);
  }
  args.push('--pull=never');
  for (const path of opts.tmpfs ?? []) {
    args.push('--tmpfs', path);
  }
  for (const m of opts.mounts ?? []) {
    args.push('-v', `${m.hostPath}:${m.containerPath}:${m.mode}`);
  }
  args.push(...workdirArgsFor(opts.cwd, opts.mounts ?? []));
  args.push('--', opts.image, 'sleep', 'infinity');
  return args;
}

function defaultDockerInfoCheck(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn('docker', ['info'], { stdio: 'ignore' });
      child.on('close', (exitCode) => resolve(exitCode === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Persistent docker-exec shell. One serialized command at a time (the queue in
 * `exec`). Each command is bracketed by a per-command sentinel emitted on BOTH
 * stdout and stderr (Lane C2): the stderr sentinel bounds that command's stderr
 * so it never bleeds into the next command's exec, and `runOne` declares the
 * command done only once both sentinels have arrived — making per-command
 * stderr ordering deterministic relative to completion. The stdout sentinel
 * also carries `$?`, which is surfaced as a terminal `{ stream: 'exit', code }`
 * chunk.
 */
class DockerPersistentSession implements ExecSession {
  readonly personalityId: string;
  private readonly backend: DockerExecutionBackend;
  private readonly config: ExecutionBackendConfig;
  private container: string | null = null;
  private shell: ChildProcess | null = null;
  private started = false;
  private disposed = false;
  private starting: Promise<void> | null = null;
  // serialize execs on the single persistent shell — one command at a time
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    backend: DockerExecutionBackend,
    personalityId: string,
    config: ExecutionBackendConfig,
  ) {
    this.backend = backend;
    this.personalityId = personalityId;
    this.config = config;
  }

  private async start(opts: ExecOpts): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!(await this.backend.isAvailable())) throw new DockerUnavailableError();
      const image = this.config.images?.default ?? '';
      if (!image) throw new InvalidImageRefError(image);
      const memoryMb = this.config.memoryMb ?? 256;
      const containerName = `ethos-sandbox-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const info = userInfo();
      const mounts = opts.personality ? this.backend.mountsFor(opts.personality) : [];
      const args = buildKeepAliveArgs({
        image,
        containerName,
        memoryMb,
        networkMode: resolveNetworkMode(opts.personality),
        uid: info.uid,
        gid: info.gid,
        mounts,
        tmpfs: scratchTmpfsFor(mounts),
        cwd: opts.cwd,
      });
      await new Promise<void>((resolve, reject) => {
        const run = spawn('docker', args, { stdio: 'ignore' });
        run.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`docker run failed (${code})`)),
        );
        run.on('error', reject);
      });
      this.container = containerName;
      this.shell = spawn('docker', ['exec', '-i', containerName, 'bash'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.started = true;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  exec(cmd: string, opts: ExecOpts = {}): AsyncIterable<ExecChunk> {
    const self = this;
    async function* gen(): AsyncIterable<ExecChunk> {
      await self.start(opts);
      const shell = self.shell;
      if (!shell?.stdin || !shell.stdout) throw new DockerUnavailableError();
      // serialize: chain onto the queue so only one command runs at a time
      let release: () => void = () => {};
      const prev = self.queue;
      self.queue = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      try {
        // F4 — kill the in-container process when the byte ceiling trips, so a
        // runaway command in a persistent session is actually stopped, not just
        // truncated on the host side (the previous no-op callback left the
        // flooding command running in the container). `stop('SIGKILL')`
        // broadcasts to the session container's user processes; the session is
        // dedicated to one logical workload, so a broadcast is the correct
        // "stop this" semantics (mirroring the one-shot path's killContainer).
        yield* withByteCeiling(self.runOne(shell, cmd, opts), MAX_EXEC_OUTPUT_BYTES, () => {
          void self.stop('SIGKILL');
        });
      } finally {
        release();
      }
    }
    return gen();
  }

  private async *runOne(
    shell: ChildProcess,
    cmd: string,
    opts: ExecOpts,
  ): AsyncIterable<ExecChunk> {
    const sentinel = `__ETHOS_EOT_${Math.random().toString(36).slice(2)}__`;
    const chunks: ExecChunk[] = [];
    // Each stream's sentinel marks its end-of-command boundary. The command is
    // `done` only once BOTH have arrived, so a command's stderr is fully drained
    // (and bounded to this command) before the exec completes.
    let stdoutSeen = false;
    let stderrSeen = false;
    let error: Error | null = null;
    let resolveNext: (() => void) | null = null;
    let stdoutBuf = '';
    let stderrBuf = '';
    // Exit code parsed from the digits following the stdout sentinel.
    let exitCode: number | null = null;

    const settled = () => stdoutSeen && stderrSeen;

    const onStdout = (b: Buffer) => {
      stdoutBuf += b.toString('utf-8');
      const idx = stdoutBuf.indexOf(sentinel);
      if (idx >= 0) {
        let pre = stdoutBuf.slice(0, idx);
        if (pre.endsWith('\n')) pre = pre.slice(0, -1);
        if (pre.length > 0) chunks.push({ stream: 'stdout', data: pre });
        // After the sentinel: `<code>\n`. Wait for the trailing newline so the
        // digits are complete even when split across socket reads.
        const after = stdoutBuf.slice(idx + sentinel.length);
        const nl = after.indexOf('\n');
        if (nl >= 0) {
          const parsed = Number.parseInt(after.slice(0, nl), 10);
          exitCode = Number.isNaN(parsed) ? -1 : parsed;
          stdoutSeen = true;
          stdoutBuf = '';
        }
        // else: sentinel arrived but code digits not yet; keep buffering.
      } else {
        const safe = stdoutBuf.length - sentinel.length;
        if (safe > 0) {
          chunks.push({ stream: 'stdout', data: stdoutBuf.slice(0, safe) });
          stdoutBuf = stdoutBuf.slice(safe);
        }
      }
      resolveNext?.();
    };
    const onStderr = (b: Buffer) => {
      stderrBuf += b.toString('utf-8');
      const idx = stderrBuf.indexOf(sentinel);
      if (idx >= 0) {
        let pre = stderrBuf.slice(0, idx);
        if (pre.endsWith('\n')) pre = pre.slice(0, -1);
        if (pre.length > 0) chunks.push({ stream: 'stderr', data: pre });
        stderrSeen = true;
        stderrBuf = '';
      } else {
        const safe = stderrBuf.length - sentinel.length;
        if (safe > 0) {
          chunks.push({ stream: 'stderr', data: stderrBuf.slice(0, safe) });
          stderrBuf = stderrBuf.slice(safe);
        }
      }
      resolveNext?.();
    };
    shell.stdout?.on('data', onStdout);
    shell.stderr?.on('data', onStderr);

    const timeoutMs = opts.timeoutMs ?? 30000;
    const timer = setTimeout(() => {
      error = new ExecTimeoutError();
      stdoutSeen = true;
      stderrSeen = true;
      resolveNext?.();
    }, timeoutMs);
    const signal = opts.signal;
    const onAbort = () => {
      error = new ExecAbortedError();
      stdoutSeen = true;
      stderrSeen = true;
      resolveNext?.();
    };
    if (signal) {
      if (signal.aborted) {
        error = new ExecAbortedError();
        stdoutSeen = true;
        stderrSeen = true;
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Run the command, capture `$?`, then emit the stderr sentinel BEFORE the
    // stdout sentinel (same shell, sequential writes) so this command's stderr
    // boundary is flushed ahead of the stdout completion marker. The stdout
    // sentinel carries the exit code.
    shell.stdin?.write(
      `${cmd}\n__ethos_rc=$?\nprintf '\\n%s\\n' "${sentinel}" 1>&2\nprintf '\\n%s%d\\n' "${sentinel}" "$__ethos_rc"\n`,
      'utf-8',
    );

    try {
      while (true) {
        while (chunks.length > 0) {
          const c = chunks.shift();
          if (c) yield c;
        }
        if (error) throw error;
        if (settled()) {
          while (chunks.length > 0) {
            const c = chunks.shift();
            if (c) yield c;
          }
          yield { stream: 'exit', code: exitCode ?? -1 };
          break;
        }
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
    } finally {
      clearTimeout(timer);
      shell.stdout?.off('data', onStdout);
      shell.stderr?.off('data', onStderr);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Signal the in-container process(es) (Lane C2). The container runs as a
   * non-root user in its own PID namespace; `kill -<sig> -1` broadcasts to every
   * process the user owns (the exec'd command and its children) without touching
   * the host. The session container is dedicated to one logical workload, so a
   * broadcast is the correct "stop this process" semantics. Best-effort: a
   * not-yet-started or already-gone container is a no-op, not an error.
   */
  async stop(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const name = this.container;
    if (!name) return;
    const sig = signal === 'SIGKILL' ? 'KILL' : 'TERM';
    await new Promise<void>((resolve) => {
      const p = spawn('docker', ['exec', name, 'sh', '-c', `kill -${sig} -1 2>/dev/null || true`], {
        stdio: 'ignore',
      });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.shell?.stdin?.end();
    } catch {
      /* shell may already be closed */
    }
    this.shell?.kill('SIGKILL');
    const name = this.container;
    if (name) {
      spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
  }
}

export class DockerExecutionBackend implements ExecutionBackend {
  readonly name = 'docker';
  private readonly config: ExecutionBackendConfig;
  private readonly checkAvailable: () => Promise<boolean>;

  constructor(
    ctx: { config: ExecutionBackendConfig; secrets: SecretsResolver; logger: Logger },
    checkAvailable?: () => Promise<boolean>,
  ) {
    this.config = ctx.config;
    this.checkAvailable = checkAvailable ?? defaultDockerInfoCheck;
  }

  isAvailable(): Promise<boolean> {
    return this.checkAvailable();
  }

  // Image convention: resolve from config.images[runtime]; runtime defaults to 'default'.
  async *exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    if (!(await this.checkAvailable())) throw new DockerUnavailableError();
    const image = this.config.images?.default ?? '';
    if (!image) throw new InvalidImageRefError(image);

    const memoryMb = this.config.memoryMb ?? 256;
    const containerName = `ethos-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const info = userInfo();
    const mounts = opts.personality ? this.mountsFor(opts.personality) : [];
    const args = buildDockerArgs({
      image,
      cmd,
      containerName,
      memoryMb,
      networkMode: resolveNetworkMode(opts.personality),
      uid: info.uid,
      gid: info.gid,
      stdin: opts.stdin !== undefined || opts.rpc !== undefined,
      env: opts.env,
      mounts,
      tmpfs: scratchTmpfsFor(mounts),
      cwd: opts.cwd,
    });
    const killContainer = () => {
      spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('close', () => {
        spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      });
    };
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    yield* withByteCeiling(
      streamChild(child, opts, killContainer),
      MAX_EXEC_OUTPUT_BYTES,
      killContainer,
    );
  }

  spawnSession(personalityId: string): ExecSession {
    return new DockerPersistentSession(this, personalityId, this.config);
  }

  /**
   * Derive the container's host-mount set mechanically from `fs_reach`
   * (review d). `read[]` → ro, `write[]` → rw, with `hostPath === containerPath`
   * (the resolved host path is bound at the same path inside the container).
   * Substitutions are resolved first. When `fs_reach` is unset the SAME defaults
   * as ScopedStorage apply: read=[ownDir, ${ethosHome}/skills/, cwd],
   * write=[ownDir, cwd] where ownDir=${ethosHome}/personalities/<id>/.
   *
   * Refuses the built-in critical denylist unconditionally (review A2). Nested
   * ro-parent / rw-child mounts are BOTH kept — the child shadows the parent in
   * its subtree (review A7). When the SAME exact path appears as both ro and
   * rw, rw wins: write access subsumes read, so the path is mounted rw. (This
   * is also why the default scope — which lists ownDir/cwd in both read and
   * write — resolves cleanly to rw for those roots.)
   */
  mountsFor(p: PersonalityConfig): MountSpec[] {
    const ethosHome = this.config.substitutionVars?.ethosHome ?? join(homedir(), '.ethos');
    const cwd = this.config.substitutionVars?.cwd ?? process.cwd();
    const vars: FsReachVars = { ethosHome, self: p.id, cwd };
    // ONE derivation, shared with ScopedStorage — see the import note above.
    const { read: readPaths, write: writePaths } = deriveFsReachPaths(p, vars);

    const byPath = new Map<string, MountSpec>();
    const add = (rawPath: string, mode: 'ro' | 'rw'): void => {
      const hostPath = resolvePath(rawPath);
      // F5 — follow symlinks before the denylist so a path that links into a
      // forbidden target (docker.sock, /proc, …) is caught, not just literal
      // forbidden paths. Both the lexical path and its real target are checked.
      const realPath = realPathOrLexical(hostPath);
      if (isForbiddenMount(hostPath) || isForbiddenMount(realPath)) {
        throw new ForbiddenMountError(hostPath);
      }
      // F2 — enforce the constitution's allow-roots / denied-prefixes against the
      // ACTUAL derived host path (and its symlink target), including the defaults
      // a no-fs_reach personality gets. The built-in denylist above still applies
      // unconditionally on top.
      checkConstitutionMount(hostPath, this.config.constitution, vars);
      if (realPath !== hostPath) checkConstitutionMount(realPath, this.config.constitution, vars);
      const existing = byPath.get(hostPath);
      // rw wins: write access subsumes read. Dedups identical (path, mode) too.
      if (existing && (existing.mode === 'rw' || mode === 'ro')) return;
      byPath.set(hostPath, { hostPath, containerPath: hostPath, mode });
    };

    // Add writes first so the rw mode is established before any ro of the same
    // path is seen; the rw-wins guard above then keeps rw regardless of order.
    for (const path of writePaths) add(path, 'rw');
    for (const path of readPaths) add(path, 'ro');
    return [...byPath.values()];
  }

  attest(): SandboxAttestation {
    // Derive attestation from the backend's actual Docker configuration.
    // buildDockerArgs always applies: --cap-drop ALL, --security-opt no-new-privileges,
    // non-root user (when uid/gid >= 0). Whether that earns a strict attestation
    // depends on what's in config — if images are pinned, no host docker socket, etc.
    return {
      readonlyRootFs: false, // Docker run does NOT set --read-only by default
      noHostMounts: false, // mountsFor derives host bind mounts from fs_reach
      egressControlled: false, // network mode may be 'bridge' (open) depending on personality
      noDockerSocket: true, // FORBIDDEN_MOUNT_ROOTS blocks /var/run/docker.sock
      nonRoot: true, // buildDockerArgs sets --user uid:gid when >= 0
      noPrivileged: true, // buildDockerArgs never adds --privileged
      noCapAdd: true, // buildDockerArgs never adds --cap-add
      capDropAll: true, // buildDockerArgs always sets --cap-drop ALL
      noNewPrivs: true, // buildDockerArgs always sets --security-opt no-new-privileges
    };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
