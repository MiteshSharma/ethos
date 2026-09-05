import type { Constitution } from './constitution';
import type { PersonalityConfig } from './personality';
import type { SandboxAttestation } from './sandbox';

export type ExecChunk =
  | { stream: 'stdout' | 'stderr'; data: string }
  /**
   * Terminal chunk carrying the command's exit code. Emitted as the LAST chunk
   * of a naturally-completed exec stream (after all stdout/stderr). Backends do
   * NOT emit it when the stream ends via timeout/abort — those throw instead.
   * Consumers that ignore exit codes can skip this variant (`data` is absent).
   */
  | { stream: 'exit'; code: number };

/** A script-initiated tool call crossing the framed-stdio RPC boundary (tools-as-code-api Lane A). */
export interface ExecRpcRequest {
  name: string;
  args: unknown;
}

/** Host answer to a script-initiated call. Errors travel as data (`ok: false`), never as throws. */
export interface ExecRpcResponse {
  ok: boolean;
  value?: string;
  error?: string;
  code?: string;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
  /**
   * Framed-stdio RPC seam (tools-as-code-api Lane A). When present, the docker
   * backend runs the exec in framed mode: `stdin` is delivered to the runtime
   * shim as a `script` frame, the child's stdin stays OPEN for `rpc_response`
   * frames, and each `rpc_request` frame the shim emits is answered via
   * `onRequest` (serialized — one in-flight call at a time). When absent, the
   * write-then-end stdin path is unchanged. One-shot exec only — persistent
   * sessions ignore it.
   */
  rpc?: { onRequest(req: ExecRpcRequest): Promise<ExecRpcResponse> };
  /**
   * Personality whose `fs_reach` derives the container mount set (docker
   * backend). Routed execution tools pass this so the OS-layer mount boundary
   * matches the personality's declared reach. Ignored by `local`/`ssh`.
   */
  personality?: PersonalityConfig;
  /**
   * Session lane key. The lifecycle manager (SessionManager) keys persistent
   * exec sessions by (personality.id, sessionId). When absent, all execs for a
   * personality share a single default lane (sessionId defaults to '').
   */
  sessionId?: string;
  /**
   * Whether the backend may put a QUOTING layer around `cmd` (`sh -c '<cmd>'`).
   * Defaults to true. Callers pass `false` when they have already composed
   * `cmd` as a ready remote command line — every `run_code` runner
   * (`python3 -`, `node --input-type=module`, `bash -s`) is one — so it is
   * interpolated raw and parsed by exactly one shell, the same single parse the
   * unwrapped form gets.
   *
   * It does NOT mean "no remote cwd": a workdir is still applied on this path,
   * as `cd '<dir>' && exec <cmd>`. An `sh -c` wrap does not consume its child's
   * stdin — the runner inherits the descriptor and still reads its program from
   * it — and `exec` makes the runner REPLACE the wrapping shell, so pid, signal
   * disposition and exit status stay the remote command's own. Both are proved
   * against a real shell in
   * `extensions/execution-ssh/src/__tests__/remote-words-stdin.test.ts`; the
   * earlier rationale here (that a second wrap changes what the runner reads)
   * was false, and while it stood `run_code` silently lost its remote cwd.
   *
   * The flag is thin. Only the `ssh` backend reads it (`local`/`docker` ignore
   * it), exactly one call site sets it (`run_code` in `@ethosagent/tools-code`),
   * and what it now buys is `exec` rather than a forked child, plus one fewer
   * process when there is no workdir to apply.
   */
  shell?: boolean;
}

export interface ExecSession {
  readonly personalityId: string;
  exec(cmd: string, opts?: ExecOpts): AsyncIterable<ExecChunk>;
  /**
   * Signal the in-session process(es). For the docker backend this signals the
   * containerized process (the boundary owns the real pid; the host never sees
   * it). Optional: backends without a real in-session pid (local/ssh thin
   * sessions) may omit it, in which case callers fall back to `dispose()`.
   */
  stop?(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  dispose(): Promise<void>;
}

export interface MountSpec {
  hostPath: string;
  containerPath: string;
  mode: 'ro' | 'rw';
}

/**
 * The resolved, legible execution posture of a personality (Phase 2a, lane E1).
 * Computed from the personality toolset + `fs_reach` + `safety.network` + any
 * `execution:` override + containerized detection — not hand-set. Surfaced
 * read-only on the character sheet's `## Execution` section, identically on CLI
 * and the web Personalities tab. Additive contract — not a frozen schema.
 */
export interface ExecutionPosture {
  /**
   * `docker` — exec-bearing toolset runs OS-mount-confined in a container.
   * `local` — runs in the current process (containerized posture, or explicit
   *   un-sandboxed consent); the host/container is the boundary.
   * `ssh` — runs on a remote host; remote-host trust, NOT mount-confinement.
   * `none` — chat-only personality; no execution backend at all.
   */
  backend: 'docker' | 'local' | 'ssh' | 'none';
  /** OS-layer container network gate. `none` = air-gapped; `bridge` = open egress. */
  networkMode: 'none' | 'bridge';
  /** Container memory ceiling in MB (docker). */
  memoryMb: number;
  /**
   * True when `local` was selected because Ethos itself runs inside a container
   * (explicit env/config or auto-detect) — the container is the boundary,
   * `fs_reach`/network enforced app-layer only. Distinct from the forbidden
   * daemon-down fallback.
   */
  containerized: boolean;
  /** Bind mounts derived from `fs_reach` (docker posture). Empty otherwise. */
  mounts: MountSpec[];
  /** Ephemeral tmpfs scratch container paths (docker posture), e.g. `/tmp`. */
  scratchPaths: string[];
  /**
   * A1 docker-absent decision state. Present ONLY when posture is `docker` and
   * the daemon is unavailable. Drives the E2 modal — never a silent fallback.
   */
  dockerAbsent?: DockerAbsentDecision;
  /**
   * Honest host fallback (Phase 2a security fix F1). Present when a personality
   * that would otherwise run in Docker cannot — because Docker is disabled in
   * this process (e.g. desktop in-process backend) or the daemon is unavailable
   * — AND the constitution permits the un-sandboxed `local` posture. In that
   * case `backend` is `local`, `containerized` is false, and execution genuinely
   * runs on the host. The character sheet labels this distinctly so the UI never
   * claims "Sandboxed · Docker" while running host. When the constitution
   * forbids `local`, this field is absent and `backend` stays `docker` with a
   * `dockerAbsent` hard-fail decision (tools become `not_available`).
   *
   * `ssh-unavailable` mirrors this for an `ssh`-posture personality when no ssh
   * execution backend is wired (Phase 2a wires none): rather than silently
   * running on the host while the sheet claims "ssh (remote host)", a permitting
   * constitution resolves to honest `local` (host) with this reason, and a
   * forbidding one keeps `backend: 'ssh'` so exec tools refuse (`not_available`).
   */
  hostFallback?: {
    /** Why the requested sandbox/remote backend could not run. */
    reason: 'docker-disabled' | 'docker-unavailable' | 'ssh-unavailable';
  };
  /**
   * The deployment's remote execution target (`execution.ssh`), rendered as
   * `user@host:port`, when the posture is `ssh`. Display only — the resolver
   * never dials it. Absent when no `execution.ssh.host` is configured, or when
   * the posture is not `ssh`.
   */
  sshTarget?: string;
  /**
   * Why an `ssh` posture will NOT reach its remote target. Present only when
   * `backend` is `ssh` AND execution is refused outright — i.e. the constitution
   * forbids the honest `local` host fallback, so exec tools become
   * `not_available` rather than silently running on this machine. A permitting
   * constitution never lands here: an unconfigured target becomes honest `local`
   * with `hostFallback.reason === 'ssh-unavailable'`, and a configured one keeps
   * `backend: 'ssh'` and actually routes remotely.
   *
   *   - `unconfigured` — no `execution.ssh.host` is set, so there is nothing to
   *     connect to, and the host fallback is forbidden.
   *   - `constitution-requires-sandbox` — a target IS configured, but ssh is
   *     remote-host trust, not mount-confinement, so a constitution setting
   *     `execution.requireSandbox` / `forbidLocal` refuses it.
   */
  sshRefused?: {
    reason: 'unconfigured' | 'constitution-requires-sandbox';
    /** Human-readable refusal, rendered verbatim by the character sheet. */
    message: string;
  };
}

/**
 * A1 (review correction) — the typed choice surfaced when a `docker`-posture
 * personality cannot reach the Docker daemon. NO silent host fallback. Exposed
 * for the E2 UI to render; the resolver never picks for the user.
 */
export interface DockerAbsentDecision {
  /** Always true when this object is present. */
  blocked: true;
  /** Guided-install option is always offered. */
  canInstall: true;
  /**
   * Whether an explicit un-sandboxed `local` consent may be offered. False when
   * the constitution forbids `local` (`requireSandbox` / `forbidLocal`) — then
   * it stays a hard error with no consent escape hatch.
   */
  canConsentLocal: boolean;
  /** Human-readable reason the consent option is withheld, when it is. */
  consentForbiddenReason?: string;
}

export interface ExecutionBackend {
  readonly name: string; // 'local' | 'docker' | 'ssh'
  isAvailable(): Promise<boolean>;
  exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk>;
  spawnSession(personalityId: string): ExecSession;
  mountsFor(p: PersonalityConfig): MountSpec[];
  dispose(): Promise<void>;
  /** Return this backend's sandbox capability attestation.
   *  Optional — backends that don't implement it are treated as "no attestation"
   *  (classifier stays on). The framework keys the classifier-skip on
   *  `isStrictAttestation(attest())`, NEVER the backend name string (S2). */
  attest?(): SandboxAttestation;
}

export interface ExecutionBackendConfig {
  /** Runtime image refs pinned by @sha256: digest (review #2). Keyed by logical runtime name. */
  images?: Record<string, string>;
  /** Default container memory cap in MB (docker). */
  memoryMb?: number;
  /** Container CPU quota, passed as docker `--cpus`. Default 2. */
  cpu?: number;
  /**
   * Best-effort container disk quota in MB, passed as docker
   * `--storage-opt size=<N>m` — the requested bound exactly, never rounded up
   * to whole GB. Docker has no universal disk-quota flag: `btrfs`, `zfs`,
   * `devicemapper` and `windowsfilter` enforce the option natively, and
   * `overlay2` only over xfs mounted with project quotas (`pquota`), which
   * `docker info` does not report — so the backend proves that one case with
   * a throwaway `docker create`/`docker rm` before emitting the flag. On any
   * daemon that cannot enforce it the backend warns once through the injected
   * logger and starts the container without the quota rather than failing the
   * sandbox.
   */
  diskMb?: number;
  /**
   * ssh target — remote-host trust, NOT mount-confinement (review A3). The
   * deployment's single remote execution target; `host` is the switch (no
   * `host`, no remote routing). Mirrors `execution.ssh.*` in
   * `~/.ethos/config.yaml` field for field.
   */
  ssh?: {
    host: string;
    user?: string;
    port?: number;
    /** Private key PATH passed as `ssh -i`. Never key material. */
    identityFile?: string;
    /** Passed as `-o UserKnownHostsFile=`. Absent → ssh's own default. */
    knownHostsFile?: string;
    /**
     * Passed VERBATIM as `-o StrictHostKeyChecking=`. A literal union, not a
     * boolean: `false` would have to mean `no`, which disables host-key
     * verification outright, and a boolean read of `'accept-new'` is truthy and
     * would silently emit the stricter `yes`, breaking every first connection
     * to a new host. Absent → the backend's `accept-new` default (TOFU:
     * unknown hosts learned, CHANGED ones still refused).
     */
    strictHostKeys?: 'accept-new' | 'yes';
    /** Remote cwd for every exec. Absent → the remote login directory (D8). */
    remoteWorkdir?: string;
  };
  /**
   * Substitution roots for resolving `${ETHOS_HOME}` and `${CWD}` in
   * `fs_reach` before deriving mounts. `${self}` resolves to the personality
   * id at `mountsFor` time. When absent, the docker backend falls back to
   * `~/.ethos` and `process.cwd()`.
   */
  substitutionVars?: { ethosHome: string; cwd: string };
  /**
   * Operator constitution. When present, the docker backend enforces
   * `filesystem.allowedMountRoots` / `filesystem.deniedPathPrefixes` against the
   * ACTUAL derived mount set (including the `ownDir`/`skills`/`cwd` defaults a
   * personality with no `fs_reach` gets), not just the declared `fs_reach` at
   * load time. The built-in `FORBIDDEN_MOUNT_ROOTS` denylist still applies
   * unconditionally on top. Substitution roots come from `substitutionVars`.
   */
  constitution?: Constitution;
}

export type ExecutionBackendFactory = (ctx: {
  config: ExecutionBackendConfig;
  secrets: import('./secrets').SecretsResolver;
  logger: import('./logger').Logger;
}) => ExecutionBackend | Promise<ExecutionBackend>;

export interface ExecutionBackendRegistry {
  register(name: string, factory: ExecutionBackendFactory): void;
  unregister(name: string): void;
  /** Resolve (and cache) a registered factory into a concrete backend instance. */
  resolve(
    name: string,
    ctx: {
      config: ExecutionBackendConfig;
      secrets: import('./secrets').SecretsResolver;
      logger: import('./logger').Logger;
    },
  ): Promise<ExecutionBackend>;
  get(name: string): ExecutionBackend | undefined;
  list(): string[];
}
