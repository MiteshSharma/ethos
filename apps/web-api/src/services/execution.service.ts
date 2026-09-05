import type { ExecutionBackend, ExecutionBackendRegistry } from '@ethosagent/types';
import type { ExecutionProbeResult, ExecutionProbeState } from '@ethosagent/web-contracts';
import type { ConfigRepository } from '../repositories/config.repository';

// Settings › Execution (plan/phases/remote-execution-routing.md §6, T7).
//
// THE INSTANCE QUESTION. The execution-backend registry is built per loop, in
// `buildInfrastructure` — one `DefaultExecutionBackendRegistry` per
// `createAgentLoop` — and it MEMOISES: `resolve(name, …)` hands back the
// instance it already built, ignoring the ctx of every later call. So when the
// composition root passes that registry in, `get('ssh')` is literally the
// object `compose-tools` resolved for the tools that run remotely, and the
// probe tests the thing that executes.
//
// Which is the whole value of the probe, and therefore its whole discipline:
// this layer READS the registry and never writes to it. `get('ssh')` only —
// never `resolve('ssh', …)`.
//
//   * `resolve()` CONSTRUCTS. Composition deliberately declines to build an ssh
//     backend under a constitution that sets `execution.requireSandbox` /
//     `forbidLocal` (`resolveSshExecutionBackend` returns undefined, exec tools
//     become `not_available`). A probe that resolved its own would build the
//     object the constitution refused and could then report it `reachable` —
//     flatly contradicting the posture the tools are actually running under.
//   * `resolve()` also MEMOISES for everybody else: the first caller's ctx is
//     the one every later caller inherits, so a probe resolving on a cold
//     registry would decide what the TOOLS execute on.
//
// So an absent backend is reported, never manufactured — see
// {@link ExecutionService.sshBackend}.
//
// THE STALENESS QUESTION, the same problem from the other side. Memoisation
// means the instance outlives an edit to `execution.ssh.*`: config.yaml says
// one host, the backend still dials the one it was built with, and every
// `execution: ssh` personality's tools go to the old machine until the process
// restarts. Pairing freshly-read config with an opaque memoised backend would
// name the new host while contacting the old one. Instead the backend's own
// frozen `configuredTarget` is compared against current config, and a
// difference is `stale_config` — contacting NEITHER host, because an answer
// about either one is a false answer to the question that was asked.
//
// With no registry wired into this process the answer is `backend_unresolved`
// carrying the reason — never a fabricated `unreachable`, which would blame the
// network for a deployment fault.

/**
 * The uncached reachability check on `SshExecutionBackend`. Structural rather
 * than an import of the concrete class: `ExecutionBackendRegistry.resolve` is
 * typed to return `ExecutionBackend`, and `probe()` is the ssh backend's own
 * addition — not part of the frozen interface, and not a reason for web-api to
 * widen it.
 */
interface ProbeableBackend {
  probe(): Promise<{ ok: boolean; error?: string }>;
}

function isProbeable(backend: ExecutionBackend): backend is ExecutionBackend & ProbeableBackend {
  return 'probe' in backend && typeof backend.probe === 'function';
}

/**
 * The frozen target `SshExecutionBackend` captured at construction. Structural
 * for the same reason {@link ProbeableBackend} is — it is the ssh backend's own
 * addition, not part of the frozen `ExecutionBackend` interface.
 *
 * A backend that does not expose one cannot be checked for staleness, and this
 * service does not guess: it says so rather than probing an instance whose
 * target it cannot establish.
 */
interface TargetedBackend {
  readonly configuredTarget: SshTargetConfig | undefined;
}

function hasTargetIdentity(
  backend: ExecutionBackend,
): backend is ExecutionBackend & TargetedBackend {
  return 'configuredTarget' in backend;
}

/** Every field that changes WHERE or AS WHOM a command runs. All seven. */
const SSH_TARGET_KEYS = [
  'host',
  'user',
  'port',
  'identityFile',
  'knownHostsFile',
  'strictHostKeys',
  'remoteWorkdir',
] as const;

/**
 * Whether two ssh blocks describe the same target. Field by field over the
 * whole block, not just `host`: a changed `user`, `port` or `identityFile`
 * changes what actually executes just as completely, and a check that only
 * watched the hostname would call those edits applied when they are not.
 *
 * `host` is trimmed on both sides because `packages/config` trims it on the way
 * to the backend and the passthrough read here does not — a difference in
 * whitespace alone is not an operator changing machines.
 */
function sameTarget(a: SshTargetConfig, b: SshTargetConfig): boolean {
  return SSH_TARGET_KEYS.every((key) => {
    const left = a[key];
    const right = b[key];
    if (key === 'host') return String(left).trim() === String(right).trim();
    return left === right;
  });
}

/** `execution.ssh.*`, exactly as config.yaml carries it. No defaults. */
interface SshTargetConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
  strictHostKeys?: 'accept-new' | 'yes';
  remoteWorkdir?: string;
}

export interface ExecutionServiceOptions {
  /** `<dataDir>/config.yaml`, read through the repository already rooted there.
   *  Narrowed to `read` — this service never writes config, and a wider type
   *  would be a capability it does not need. */
  config: Pick<ConfigRepository, 'read'>;
  /**
   * The LOOP's registry, from `buildInfrastructure`. Optional because a
   * deployment can serve the web surface without one (onboarding mode, tests,
   * and any composition root that has not threaded it through). Absent means
   * this process cannot reach the object that would execute, and the probe says
   * so rather than guessing.
   */
  executionBackends?: ExecutionBackendRegistry;
  /**
   * Personalities that REQUIRE remote execution (`execution: remote`) — the
   * posture line under the header (`ssh — used by: remote-hands`). They are the
   * ones this deployment's ssh target has to serve, and the ones whose exec
   * tools refuse outright when it is missing.
   */
  personalities: { list(): ReadonlyArray<{ id: string; execution?: string }> };
}

export class ExecutionService {
  constructor(private readonly opts: ExecutionServiceOptions) {}

  async probeSsh(): Promise<ExecutionProbeResult> {
    const usedBy = this.opts.personalities
      .list()
      .filter((p) => p.execution === 'remote')
      .map((p) => p.id);
    return { usedBy, result: await this.probeTarget() };
  }

  private async probeTarget(): Promise<ExecutionProbeState> {
    const ssh = await this.readTarget();
    // Presence of `host` is the switch (D2). No host is not a failure — it is a
    // deployment that does not execute remotely, which is the default.
    if (!ssh) return { state: 'not_configured' };

    // The same renderer the character sheet and the compose path use, so the
    // string the pane probes is the string every other surface names.
    const { formatSshTarget } = await import('@ethosagent/wiring');
    const target = formatSshTarget(ssh);

    const resolved = this.sshBackend();
    if ('error' in resolved) return { state: 'backend_unresolved', target, error: resolved.error };
    const backend = resolved.backend;
    if (!isProbeable(backend)) {
      return {
        state: 'backend_unresolved',
        target,
        error: `execution backend "${backend.name}" exposes no probe()`,
      };
    }

    // The instance's OWN target, before any connection is opened. `target`
    // above is what config says; this is what the backend will really dial.
    if (!hasTargetIdentity(backend)) {
      return {
        state: 'backend_unresolved',
        target,
        error:
          `execution backend "${backend.name}" does not expose the target it was built with, ` +
          'so this process cannot tell whether it still matches the configuration',
      };
    }
    const active = backend.configuredTarget;
    if (!active) {
      return {
        state: 'backend_unresolved',
        target,
        error: `execution backend "${backend.name}" was built with no ssh target`,
      };
    }
    if (!sameTarget(active, ssh)) {
      // NEITHER host is contacted. Probing the old one answers about a machine
      // the operator has stopped pointing at; probing the new one answers about
      // a machine no tool will touch until a restart.
      return { state: 'stale_config', target, activeTarget: formatSshTarget(active) };
    }

    // `probe()`, never `isAvailable()`: the latter trusts a success for 60 s,
    // and a button whose whole purpose is "tell me about NOW" must not answer
    // about a minute ago.
    const startedAt = Date.now();
    const result = await backend.probe();
    const latencyMs = Date.now() - startedAt;
    if (result.ok) return { state: 'reachable', target, latencyMs };
    return {
      state: 'unreachable',
      target,
      // Verbatim. Not summarised, not prefixed, not sentence-cased: the whole
      // value of this line is that `Permission denied (publickey)` and
      // `Connection timed out` are different problems and the operator can see
      // which one they have.
      error: result.error ?? 'ssh failed with no diagnostic output',
    };
  }

  /**
   * Whether the backend the posture NAMES can be constructed at all — the admin
   * panel's boot-failure row. Resolving opens no connection, so this is cheap
   * enough for a status poll; reachability is {@link probeSsh}.
   *
   * Null when no remote target is configured: there is nothing to fail, and a
   * fresh install must not be told otherwise.
   */
  async backendHealth(): Promise<{ name: 'ssh'; resolved: boolean; error: string | null } | null> {
    const ssh = await this.readTarget();
    if (!ssh) return null;
    const resolved = this.sshBackend();
    if ('error' in resolved) return { name: 'ssh', resolved: false, error: resolved.error };
    return { name: 'ssh', resolved: true, error: null };
  }

  /** `execution.ssh.*` from config.yaml, or null when no host is declared. */
  private async readTarget(): Promise<SshTargetConfig | null> {
    const p = (await this.opts.config.read())?.passthrough ?? {};
    const host = p['execution.ssh.host'];
    if (!host) return null;
    const portRaw = p['execution.ssh.port'];
    const strict = p['execution.ssh.strictHostKeys'];
    // RAW throughout. A defaulted `user` or `port` would render a target string
    // the operator never wrote — and that string is what the pane says it
    // probed, so it has to be the truth.
    return {
      host,
      ...(p['execution.ssh.user'] ? { user: p['execution.ssh.user'] } : {}),
      ...(portRaw !== undefined && /^\d+$/.test(portRaw) ? { port: Number(portRaw) } : {}),
      ...(p['execution.ssh.identityFile'] ? { identityFile: p['execution.ssh.identityFile'] } : {}),
      ...(p['execution.ssh.knownHostsFile']
        ? { knownHostsFile: p['execution.ssh.knownHostsFile'] }
        : {}),
      ...(strict === 'accept-new' || strict === 'yes' ? { strictHostKeys: strict } : {}),
      ...(p['execution.ssh.remoteWorkdir']
        ? { remoteWorkdir: p['execution.ssh.remoteWorkdir'] }
        : {}),
    };
  }

  /**
   * The loop's ssh backend, LOOKED UP — `get()` only, and there is no fallback
   * to `resolve()`.
   *
   * `get()` returns the instance composition already built and takes no ctx, so
   * it can neither construct anything nor decide what a later caller inherits.
   * That is the entire point. A `resolve()` here would build a backend under
   * exactly the two conditions the surface is least entitled to: a constitution
   * that REFUSED one (`execution.requireSandbox` / `forbidLocal`, where
   * `resolveSshExecutionBackend` deliberately returns undefined and exec tools
   * are `not_available`), and a cold registry where the probe's own ctx would
   * be memoised for the tools.
   *
   * So `undefined` is reported as `backend_unresolved`. This service cannot see
   * the execution POSTURE — that is per-personality, built by
   * `buildExecutionPosture` from the personality config plus the operator
   * constitution, and the only personality data reaching here is `{ id,
   * execution }` — so it cannot repeat the resolver's own `sshRefused.message`
   * and does not invent a substitute for it. The reason it gives names both
   * possibilities and claims neither, which is the true state of this process's
   * knowledge; the personality's character sheet carries the posture's own
   * wording.
   */
  private sshBackend(): { backend: ExecutionBackend } | { error: string } {
    const registry = this.opts.executionBackends;
    if (!registry) {
      return {
        error:
          'no execution-backend registry is wired into this process, so the ssh backend that ' +
          'would run remote commands cannot be reached from here',
      };
    }
    const existing = registry.get('ssh');
    if (existing) return { backend: existing };
    return {
      error:
        "no ssh execution backend was built at startup — either no personality's execution " +
        'posture needed one, or the execution constitution refused it ' +
        '(execution.requireSandbox / forbidLocal), under which exec tools are unavailable. ' +
        "This surface does not construct one to find out; see the personality's character sheet.",
    };
  }
}
