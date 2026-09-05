import { existsSync, readFileSync } from 'node:fs';
import {
  DockerExecutionBackend,
  resolveNetworkMode,
  scratchTmpfsFor,
} from '@ethosagent/execution-docker';
import { noopLogger } from '@ethosagent/logger';
import type {
  Constitution,
  DockerAbsentDecision,
  ExecutionPosture,
  Logger,
  MountSpec,
  PersonalityConfig,
} from '@ethosagent/types';

// Phase 2a, lane E1 — the FULL execution-posture resolver. Computes the
// legible `{ backend, networkMode, memoryMb, ... }` posture from the
// personality toolset + `fs_reach` + `safety.network` + the `execution:`
// requirement + containerized detection. Supersedes the minimal
// `resolve-execution-backend.ts` selector (which now delegates here so routed
// tools keep working).
//
// `node:fs` is used here ONLY to probe SYSTEM paths (`/.dockerenv`,
// `/proc/1/cgroup`) for in-container detection — NOT `~/.ethos`. The Storage
// abstraction governs `~/.ethos` access; these are kernel/runtime signals
// outside that boundary, so raw `node:fs` is the correct (and only) tool.

/** Default container memory ceiling (MB) — mirrors the docker backend default. */
const DEFAULT_MEMORY_MB = 256;

/**
 * Render `execution.ssh` as the `user@host:port` string the character sheet
 * shows. Only what is actually CONFIGURED appears: an absent `user` or `port`
 * means ssh resolves it itself (`~/.ssh/config`, the local username, port 22),
 * and printing a guess would put a value on the sheet the operator never set.
 *
 * One formatter, shared by every surface that displays the target, so the CLI
 * sheet, the web sheet and the compose path cannot disagree about what the
 * deployment points at.
 */
export function formatSshTarget(ssh: { host: string; user?: string; port?: number }): string {
  const user = ssh.user ? `${ssh.user}@` : '';
  const port = ssh.port !== undefined ? `:${ssh.port}` : '';
  return `${user}${ssh.host}${port}`;
}

/**
 * Tool names that carry shell / code execution and therefore want a sandbox.
 * The personality `toolset` is a flat list of tool NAMES, not toolset groups.
 * The exec-bearing tools today: `terminal`, the `process_*` family, `run_code`,
 * and the `@ethosagent/tools-code` command runners `run_tests` / `lint` (both
 * run arbitrary `command` bash via `makeCommandTool`). Omitting `run_tests` /
 * `lint` would resolve a personality whose toolset lists ONLY those to `none`
 * posture — no docker backend, host bash silently runs while the sheet says
 * "none". They must count as exec tools so the posture is `docker` (sandboxed)
 * or an honest refusal, never silent host.
 */
export function isExecTool(name: string): boolean {
  return (
    name === 'terminal' ||
    name === 'run_code' ||
    name === 'run_tests' ||
    name === 'lint' ||
    name.startsWith('process_')
  );
}

/** True when the personality has at least one execution-bearing tool. */
export function hasExecTool(personality: PersonalityConfig): boolean {
  return (personality.toolset ?? []).some(isExecTool);
}

/**
 * Read the `execution:` REQUIREMENT off the personality config. A requirement is
 * not a transport — the personality says its work belongs on another machine
 * (`remote`) or that it does not execute at all (`none`), and this resolver maps
 * that onto a backend using what the OPERATOR configured. The field is typed on
 * PersonalityConfig as exactly these two literals, so no cast is needed; the
 * runtime check stays because a YAML-loaded config carries anything.
 */
function readExecutionRequirement(personality: PersonalityConfig): 'remote' | 'none' | undefined {
  const raw = personality.execution;
  if (raw === 'remote' || raw === 'none') return raw;
  return undefined;
}

/** Why the containerized posture was selected — for logging/character-sheet. */
export type ContainerizedSignal =
  | 'env:ETHOS_EXECUTION_BACKEND=local'
  | 'config:execution.containerized'
  | 'detect:/.dockerenv'
  | 'detect:/proc/1/cgroup'
  | 'detect:KUBERNETES_SERVICE_HOST';

export interface ContainerizedDetection {
  containerized: boolean;
  /** The signal that decided it (only set when `containerized` is true). */
  signal?: ContainerizedSignal;
  /** True when chosen explicitly (env/config) vs. auto-detected. */
  explicit: boolean;
}

export interface ContainerizedDetectionInput {
  /** `execution.containerized: true` from `~/.ethos/config.yaml`, if read by the caller. */
  containerizedConfig?: boolean;
  /** Injectable env (defaults to `process.env`) — keeps the probe testable. */
  env?: NodeJS.ProcessEnv;
  /** Injectable filesystem probes — keeps the probe testable without a container. */
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detect whether Ethos itself runs inside a container, in which case the
 * surrounding container is ALREADY the isolation boundary and exec personalities
 * use the `local` backend (the container is the boundary). Precedence:
 *
 *   1. Explicit (highest): `ETHOS_EXECUTION_BACKEND=local` env or
 *      `execution.containerized: true` config — forces `local`.
 *   2. Auto-detect (overridable): `/.dockerenv`, a `docker`/`containerd` match
 *      in `/proc/1/cgroup`, or `KUBERNETES_SERVICE_HOST`.
 *
 * Never silent — the result is logged + shown on the character sheet by callers.
 */
export function detectContainerized(
  input: ContainerizedDetectionInput = {},
): ContainerizedDetection {
  const env = input.env ?? process.env;
  const fileExists = input.fileExists ?? existsSync;
  const readFile = input.readFile ?? defaultReadFile;

  // 1. Explicit env / config.
  if (env.ETHOS_EXECUTION_BACKEND === 'local') {
    return { containerized: true, signal: 'env:ETHOS_EXECUTION_BACKEND=local', explicit: true };
  }
  if (input.containerizedConfig === true) {
    return { containerized: true, signal: 'config:execution.containerized', explicit: true };
  }

  // 2. Auto-detect.
  if (fileExists('/.dockerenv')) {
    return { containerized: true, signal: 'detect:/.dockerenv', explicit: false };
  }
  const cgroup = readFile('/proc/1/cgroup');
  if (cgroup && /\b(docker|containerd)\b/.test(cgroup)) {
    return { containerized: true, signal: 'detect:/proc/1/cgroup', explicit: false };
  }
  if (env.KUBERNETES_SERVICE_HOST) {
    return { containerized: true, signal: 'detect:KUBERNETES_SERVICE_HOST', explicit: false };
  }

  return { containerized: false, explicit: false };
}

/** True when the constitution forbids the un-sandboxed `local` posture. */
export function constitutionForbidsLocal(constitution?: Constitution): boolean {
  const exec = constitution?.execution;
  return exec?.requireSandbox === true || exec?.forbidLocal === true;
}

export interface ResolveExecutionPostureInput {
  personality: PersonalityConfig;
  /** Operator constitution — gates the A1 `local` consent option (A4). */
  constitution?: Constitution;
  /** Containerized detection signals (env/config/filesystem probes). */
  containerized?: ContainerizedDetectionInput;
  /** Whether the Docker daemon is reachable — drives the A1 decision state. */
  dockerAvailable?: boolean;
  /**
   * Whether a Docker backend can be BUILT in this process at all (F1). False
   * when Docker execution is disabled in-process (e.g. the desktop in-process
   * backend sets `disableDocker: true`) — distinct from the daemon being down.
   * When false and the computed posture is `docker`, the resolver falls back to
   * an HONEST `local` posture (un-sandboxed, runs on host) if the constitution
   * permits, or stays a `docker` hard-fail when it forbids `local`. Defaults to
   * `true` (read surfaces that don't gate execution leave it unset).
   */
  dockerBuildable?: boolean;
  /**
   * Whether this deployment has a remote execution target — i.e. whether
   * `execution.ssh.host` is set in `~/.ethos/config.yaml`. `host`'s presence IS
   * the switch (same shape as `background.pi.image`).
   *
   * REQUIRED, deliberately. An `ssh`-posture personality routes remotely only
   * when this is true; when it is false the resolver falls back to an honest
   * `local` posture (or refuses, per the constitution). An OPTIONAL field would
   * let a call site forget it and silently get `false` — the compose path would
   * then run `terminal` / `run_code` / `run_tests` / `lint` on THIS machine
   * while the character sheet renders `ssh target: user@build-01:22`. Nothing
   * would fail: no test, no typecheck, no boot error. Required means `tsc`
   * names every call site instead. Do not make it optional.
   */
  sshConfigured: boolean;
  /**
   * Display form of the configured target (`user@host:port`), surfaced on the
   * posture for the character sheet. Never dialled here. Optional: surfaces
   * that only decide what executes may omit it.
   */
  sshTarget?: string;
  /**
   * Mount set for the docker posture, derived by the caller from the docker
   * backend's `mountsFor(personality)`. The resolver stays free of a docker
   * instance so it remains pure/testable. When absent, `mounts` is `[]`.
   */
  mounts?: MountSpec[];
  /** Container memory ceiling (MB). Defaults to 256. */
  memoryMb?: number;
  /** Optional log sink — containerized detection + A1 state are never silent. */
  log?: Logger;
}

/**
 * The full posture resolution rule — (requirement × operator config ×
 * constitution) → backend:
 *
 *   - requirement `none` → `none`. The personality says it does not execute.
 *   - requirement `remote` → `ssh`, the one remote transport this deployment
 *     knows how to speak. WHICH machine is `execution.ssh.*` in
 *     `~/.ethos/config.yaml`; the personality never names it. With no target
 *     configured the posture stays `ssh` and carries `sshRefused` — see below.
 *   - no requirement, chat-only (no exec tool) → `none` (`local` is NEVER
 *     silently assigned to a personality that never execs);
 *   - no requirement, exec-bearing → `docker` BY DEFAULT, UNLESS Ethos is
 *     containerized, in which case → `local` (the container is the boundary).
 *
 * A requirement the deployment cannot satisfy is REFUSED, never downgraded. An
 * `execution: remote` personality on a host with no `execution.ssh.host` keeps
 * `backend: 'ssh'` with `sshRefused.reason === 'unconfigured'`, and the compose
 * path builds no backend, so its exec tools answer `not_available`. That
 * refusal does NOT consult the constitution: this key previously fell back to an
 * "honest local" posture whenever the constitution permitted it, which ran the
 * work on precisely the machine the personality said it did not belong on. A
 * label on the character sheet is not consent from the author.
 *
 * When the resolved posture is `local` AND the constitution forbids it, the
 * caller (constitution layer / wiring) hard-fails the load — the resolver just
 * surfaces the posture and the A1 decision state; it never picks for the user
 * and never silently falls back.
 */
export function resolveExecutionPosture(input: ResolveExecutionPostureInput): ExecutionPosture {
  const {
    personality,
    constitution,
    dockerAvailable,
    dockerBuildable,
    mounts,
    memoryMb = DEFAULT_MEMORY_MB,
    log,
  } = input;

  const detection = detectContainerized(input.containerized);
  const requirement = readExecutionRequirement(personality);
  const networkMode = resolveNetworkMode(personality);

  // Posture selection — requirement first, then what this machine offers.
  let backend: ExecutionPosture['backend'];
  if (requirement === 'none') {
    backend = 'none';
  } else if (requirement === 'remote') {
    backend = 'ssh';
  } else if (!hasExecTool(personality)) {
    backend = 'none';
  } else if (detection.containerized) {
    backend = 'local';
  } else {
    backend = 'docker';
  }

  if (detection.containerized && log) {
    log.info('execution posture: containerized → local backend', {
      personalityId: personality.id,
      signal: detection.signal,
      explicit: detection.explicit,
      backend,
    });
  }

  // F1 — when the computed posture is `docker` but NO Docker backend can be
  // BUILT in this process (`dockerBuildable === false`, e.g. the desktop
  // in-process backend sets `disableDocker: true`), execution cannot be
  // sandboxed AT ALL. Previously this silently fell through to the host
  // ScopedProcess while the sheet still claimed Docker. The posture must say
  // what actually executes:
  //   - constitution permits `local` → resolve to an HONEST `local` posture
  //     (un-sandboxed, runs on host) and record `hostFallback`.
  //   - constitution forbids `local` → stay `docker`, attach a hard-fail
  //     `dockerAbsent` decision (canConsentLocal:false); the compose path then
  //     makes exec tools `not_available` rather than silently running on host.
  //
  // NOTE: the DAEMON-DOWN case (`dockerAvailable === false`) is deliberately NOT
  // folded in here. That path keeps the `docker` posture + an A1 consent
  // decision (handled below): the wiring path fails loud rather than silently
  // running host, and the user must explicitly consent to local. Auto-fallback
  // is reserved for the build-impossible case where there is no daemon question
  // to ask.
  const forbidsLocal = constitutionForbidsLocal(constitution);
  const dockerUnbuildable = backend === 'docker' && dockerBuildable === false;
  if (dockerUnbuildable && !forbidsLocal) {
    backend = 'local';
  }

  // An `ssh` posture with NO target configured has nothing to connect to. It is
  // refused — UNCONDITIONALLY, without asking the constitution. The previous
  // rule resolved it to an "honest local" posture whenever the constitution
  // permitted un-sandboxed host execution, which satisfied the letter of
  // honesty (the sheet said so) while doing the one thing the personality's
  // author ruled out: running the work on this machine. `execution: remote` is
  // a requirement, not a preference, and a requirement this deployment cannot
  // meet leaves the posture `ssh` with no backend, so the compose path makes
  // exec tools `not_available`. When a target IS configured this does not fire.
  const sshUnconfigured = backend === 'ssh' && !input.sshConfigured;

  const derivedMounts = backend === 'docker' ? (mounts ?? []) : [];
  const scratchPaths = backend === 'docker' ? scratchTmpfsFor(derivedMounts) : [];

  const posture: ExecutionPosture = {
    backend,
    ...(requirement !== undefined ? { requirement } : {}),
    networkMode,
    memoryMb,
    containerized: backend === 'local' && detection.containerized,
    mounts: derivedMounts,
    scratchPaths,
    // Display only, and only where it is true: a posture that resolved away
    // from `ssh` must not still advertise a remote target, and neither must one
    // that was refused BECAUSE nothing is configured — "no host is configured"
    // and "here is the host" cannot both be printed on the same sheet.
    ...(backend === 'ssh' && !sshUnconfigured && input.sshTarget
      ? { sshTarget: input.sshTarget }
      : {}),
  };

  if (dockerUnbuildable && !forbidsLocal) {
    // Honest local fallback — un-sandboxed, runs on host. Surfaced on the
    // character sheet so the UI never claims "Sandboxed · Docker".
    posture.hostFallback = { reason: 'docker-disabled' };
    if (log) {
      log.warn('execution posture: docker disabled in-process → honest local (un-sandboxed)', {
        personalityId: personality.id,
      });
    }
  } else if (dockerUnbuildable && forbidsLocal) {
    // Constitution forbids host fallback — stay a docker hard-fail. The compose
    // path reads `dockerAbsent.canConsentLocal === false` and the absent backend
    // to make exec tools `not_available`, never host.
    posture.dockerAbsent = {
      blocked: true,
      canInstall: true,
      canConsentLocal: false,
      consentForbiddenReason:
        'the constitution forbids the local posture (execution.requireSandbox / forbidLocal)',
    };
    if (log) {
      log.warn('execution posture: docker disabled in-process but local forbidden (F1)', {
        personalityId: personality.id,
      });
    }
  }

  // Two ways an `execution: remote` requirement goes unmet, and they are NOT
  // the same thing — the sheet and the compose path's refusal text must be able
  // to tell them apart, so the reason is carried on the posture rather than left
  // implicit in a log line:
  //
  //   - `unconfigured` — this deployment has no `execution.ssh.host`, so there
  //     is nowhere to send the work. Checked FIRST and without consulting the
  //     constitution: a permitting constitution is permission to run on this
  //     host, which is exactly what the personality ruled out.
  //   - `constitution-requires-sandbox` (D7) — a target IS configured and
  //     reachable in principle, but `execution.requireSandbox` / `forbidLocal`
  //     refuses it: ssh is remote-host TRUST, not mount-confinement, so it does
  //     not satisfy a constitution that demands a sandbox.
  //
  // Enforcement itself lives in the compose path, which builds no ssh backend
  // in either case and therefore falls through to `hostExecForbidden` (already
  // covering `backend === 'ssh'`) — exec tools become `not_available`, never
  // silently host. This block is the honest EXPLANATION of that refusal, not a
  // second gate.
  if (sshUnconfigured) {
    posture.sshRefused = {
      reason: 'unconfigured',
      message:
        'execution refused: this personality requires remote execution (execution: remote) and no execution.ssh.host is configured on this deployment. Execution tools are unavailable — the requirement is not met by running the work on this machine.',
    };
  } else if (backend === 'ssh' && forbidsLocal) {
    posture.sshRefused = {
      reason: 'constitution-requires-sandbox',
      message:
        'ssh refused: the constitution requires a sandbox (execution.requireSandbox / forbidLocal). ssh is remote-host trust, not mount-confinement, so it does not satisfy that requirement.',
    };
  }
  if (posture.sshRefused && log) {
    log.warn('execution posture: remote requirement unmet, exec tools unavailable', {
      personalityId: personality.id,
      reason: posture.sshRefused.reason,
    });
  }

  // A1 — docker posture + daemon unavailable. Produce the typed decision state;
  // never a silent local fallback. The consent option is withheld when the
  // constitution forbids `local` (A4) — then it stays a hard error.
  if (backend === 'docker' && dockerAvailable === false && !posture.dockerAbsent) {
    const decision: DockerAbsentDecision = {
      blocked: true,
      canInstall: true,
      canConsentLocal: !forbidsLocal,
    };
    if (forbidsLocal) {
      decision.consentForbiddenReason =
        'the constitution forbids the local posture (execution.requireSandbox / forbidLocal)';
    }
    posture.dockerAbsent = decision;
    if (log) {
      log.warn('execution posture: docker required but daemon unavailable (A1)', {
        personalityId: personality.id,
        canConsentLocal: decision.canConsentLocal,
      });
    }
  }

  return posture;
}

export interface BuildExecutionPostureInput {
  personality: PersonalityConfig;
  /** Operator constitution (gates the A1 consent option). */
  constitution?: Constitution;
  /** Containerized detection signals; defaults to probing `process.env` + fs. */
  containerized?: ContainerizedDetectionInput;
  /** Substitution roots for `fs_reach` mount derivation (`${ETHOS_HOME}`, `${CWD}`). */
  substitutionVars?: { ethosHome: string; cwd: string };
  /** Container memory ceiling (MB). Defaults to 256. */
  memoryMb?: number;
  /**
   * Probe for Docker daemon availability. When omitted, availability is NOT
   * checked (no A1 state) — surfaces that only render the static posture (CLI
   * `personality show`) pass nothing; surfaces that gate exec pass a real probe.
   */
  checkDockerAvailable?: () => Promise<boolean>;
  /**
   * Whether a Docker backend can be built in this process at all (F1). Pass
   * `false` from surfaces that disable Docker (e.g. the desktop in-process
   * backend) so the resolved posture honestly falls back to `local` instead of
   * claiming Docker. Defaults to `true`.
   */
  dockerBuildable?: boolean;
  /**
   * Whether `execution.ssh.host` is set in `~/.ethos/config.yaml`. REQUIRED for
   * the same reason it is required on `ResolveExecutionPostureInput`: a read
   * surface that forgets it renders "runs on the host" for a personality the
   * compose path routes to a remote machine (or the reverse). See that field's
   * note.
   */
  sshConfigured: boolean;
  /** Display form of the target (`user@host:port`) for the character sheet. */
  sshTarget?: string;
  log?: Logger;
}

/**
 * High-level posture builder for read surfaces (CLI `personality show`, web
 * Personalities tab). Derives the `fs_reach` mount set through the docker
 * backend's `mountsFor` (the single source of truth for mount derivation),
 * then runs the posture resolver. `mountsFor` is pure — no daemon needed — so
 * this is safe to call even when Docker is absent.
 */
export async function buildExecutionPosture(
  input: BuildExecutionPostureInput,
): Promise<ExecutionPosture> {
  const detection = detectContainerized(input.containerized);
  const requirement = readExecutionRequirement(input.personality);
  // Mounts are a docker concern only. A personality that stated a requirement
  // stated one this resolver never answers with docker (`remote` → ssh, `none`
  // → no backend), so only the unstated case can land there.
  const wouldBeDocker =
    requirement === undefined && !detection.containerized && hasExecTool(input.personality);

  let mounts: MountSpec[] = [];
  if (wouldBeDocker) {
    const backend = new DockerExecutionBackend({
      config: { substitutionVars: input.substitutionVars },
      secrets: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      logger: input.log ?? noopLogger,
    });
    mounts = backend.mountsFor(input.personality);
  }

  let dockerAvailable: boolean | undefined;
  if (wouldBeDocker && input.checkDockerAvailable) {
    dockerAvailable = await input.checkDockerAvailable();
  }

  return resolveExecutionPosture({
    personality: input.personality,
    constitution: input.constitution,
    containerized: input.containerized,
    mounts,
    memoryMb: input.memoryMb,
    dockerAvailable,
    dockerBuildable: input.dockerBuildable,
    sshConfigured: input.sshConfigured,
    ...(input.sshTarget !== undefined ? { sshTarget: input.sshTarget } : {}),
    log: input.log,
  });
}
