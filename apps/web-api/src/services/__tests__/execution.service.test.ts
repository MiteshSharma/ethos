import type {
  ExecutionBackend,
  ExecutionBackendConfig,
  ExecutionBackendRegistry,
  Logger,
  SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { ConfigRepository } from '../../repositories/config.repository';
import { ExecutionService } from '../execution.service';

// `execution.probeSsh` (plan/phases/remote-execution-routing.md §6, T7).
//
// The load-bearing assertions are:
//
//   * the probe is UNCACHED — two calls open two connections, because the
//     button's whole purpose is to answer about NOW and the backend's own
//     `isAvailable()` would hand back a 60-second-old success;
//   * the ssh stderr arrives VERBATIM — `Permission denied (publickey)` and
//     `Connection timed out` need different fixes and only the real line says
//     which;
//   * a process with no registry says so, and never invents `unreachable`;
//   * the web layer NEVER constructs a backend — `resolve()` is not called even
//     when there is none, because composition refuses to build one under
//     `execution.requireSandbox` / `forbidLocal` and a probe that built its own
//     could report `reachable` for an object the constitution forbade;
//   * config edited after boot is `stale_config` — NEITHER host is contacted,
//     because the memoised backend still dials the old one and an answer about
//     either machine is a false answer to the question that was asked.

function config(passthrough: Record<string, string>): Pick<ConfigRepository, 'read'> {
  return {
    read: async () => ({ passthrough, modelRouting: {}, toolSettings: {}, providers: [] }),
  };
}

const CONFIGURED = {
  'execution.ssh.host': 'build-01',
  'execution.ssh.user': 'deploy',
  'execution.ssh.port': '22',
};

/** Counts the calls the button is supposed to make, one per press. */
class FakeSshBackend {
  readonly name = 'ssh';
  probeCalls = 0;
  isAvailableCalls = 0;
  /** What the real `SshExecutionBackend` freezes at construction — the target
   *  this instance will dial for the rest of its life, whatever config later
   *  says. Defaults to the block `CONFIGURED` describes. */
  readonly configuredTarget: { host: string; user?: string; port?: number };
  constructor(
    private readonly answer: { ok: boolean; error?: string },
    target: { host: string; user?: string; port?: number } = {
      host: 'build-01',
      user: 'deploy',
      port: 22,
    },
  ) {
    this.configuredTarget = target;
  }
  probe(): Promise<{ ok: boolean; error?: string }> {
    this.probeCalls += 1;
    return Promise.resolve(this.answer);
  }
  isAvailable(): Promise<boolean> {
    this.isAvailableCalls += 1;
    return Promise.resolve(this.answer.ok);
  }
}

/** Stands in for the LOOP's registry: memoising, exactly as the real one is. */
class FakeRegistry implements ExecutionBackendRegistry {
  resolveCalls = 0;
  constructor(private readonly instance: ExecutionBackend | null) {}
  register(): void {}
  unregister(): void {}
  async resolve(
    name: string,
    _ctx: {
      config: ExecutionBackendConfig;
      secrets: SecretsResolver;
      logger: Logger;
    },
  ): Promise<ExecutionBackend> {
    this.resolveCalls += 1;
    if (!this.instance) throw new Error(`Execution backend "${name}" is not registered`);
    return this.instance;
  }
  get(): ExecutionBackend | undefined {
    return this.instance ?? undefined;
  }
  list(): string[] {
    return this.instance ? ['ssh'] : [];
  }
}

function service(opts: {
  passthrough?: Record<string, string>;
  backend?: FakeSshBackend | null;
  registry?: ExecutionBackendRegistry;
  personalities?: Array<{ id: string; execution?: string }>;
}) {
  const registry =
    opts.registry ??
    (opts.backend === undefined
      ? undefined
      : new FakeRegistry(opts.backend as unknown as ExecutionBackend | null));
  return new ExecutionService({
    config: config(opts.passthrough ?? {}),
    personalities: { list: () => opts.personalities ?? [] },
    ...(registry ? { executionBackends: registry } : {}),
  });
}

describe('probeSsh', () => {
  it('reports not_configured when no host is set — a fresh install is not a failure', async () => {
    const answer = await service({ backend: new FakeSshBackend({ ok: true }) }).probeSsh();
    expect(answer.result).toEqual({ state: 'not_configured' });
  });

  it('reports the target and the round-trip time when the host answers', async () => {
    const answer = await service({
      passthrough: CONFIGURED,
      backend: new FakeSshBackend({ ok: true }),
    }).probeSsh();
    expect(answer.result.state).toBe('reachable');
    if (answer.result.state !== 'reachable') throw new Error('unreachable branch');
    expect(answer.result.target).toBe('deploy@build-01:22');
    expect(answer.result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('relays the ssh stderr VERBATIM, including a bare auth refusal', async () => {
    // ssh prints auth refusals WITHOUT its `ssh:` prefix, so this arrives as a
    // remote exit 255 rather than a transport error. It must survive unaltered.
    const stderr = 'deploy@build-01: Permission denied (publickey).';
    const answer = await service({
      passthrough: CONFIGURED,
      backend: new FakeSshBackend({ ok: false, error: stderr }),
    }).probeSsh();
    expect(answer.result).toEqual({
      state: 'unreachable',
      target: 'deploy@build-01:22',
      error: stderr,
    });
  });

  it('keeps a timeout distinguishable from a refusal', async () => {
    const stderr = 'ssh: connect to host build-01 port 22: Connection timed out';
    const answer = await service({
      passthrough: CONFIGURED,
      backend: new FakeSshBackend({ ok: false, error: stderr }),
    }).probeSsh();
    if (answer.result.state !== 'unreachable') throw new Error('expected unreachable');
    expect(answer.result.error).toBe(stderr);
  });

  it('is UNCACHED — two calls hit the backend twice, and never via isAvailable', async () => {
    const backend = new FakeSshBackend({ ok: true });
    const svc = service({ passthrough: CONFIGURED, backend });
    await svc.probeSsh();
    await svc.probeSsh();
    expect(backend.probeCalls).toBe(2);
    // `isAvailable()` caches a success for 60 s; using it would have made the
    // second press answer about the first.
    expect(backend.isAvailableCalls).toBe(0);
  });

  it('reaches the LOOP instance rather than constructing a second backend', async () => {
    const backend = new FakeSshBackend({ ok: true });
    const registry = new FakeRegistry(backend as unknown as ExecutionBackend);
    await service({ passthrough: CONFIGURED, registry }).probeSsh();
    // `get()` answered, so nothing was built: the object probed is the object
    // compose-tools resolved for the tools that actually run remotely.
    expect(registry.resolveCalls).toBe(0);
    expect(backend.probeCalls).toBe(1);
  });

  it('says the backend could not resolve, rather than calling the host unreachable', async () => {
    const answer = await service({ passthrough: CONFIGURED, backend: null }).probeSsh();
    expect(answer.result.state).toBe('backend_unresolved');
    if (answer.result.state !== 'backend_unresolved') throw new Error('expected unresolved');
    expect(answer.result.error).toContain('no ssh execution backend was built at startup');
  });

  it('never CONSTRUCTS a backend the constitution refused — get() only, no resolve()', async () => {
    // Composition declines to build an ssh backend under
    // `execution.requireSandbox` / `forbidLocal`, so exec tools are
    // `not_available`. A probe that resolved its own would build precisely that
    // refused object and could then report it reachable.
    const registry = new FakeRegistry(null);
    const answer = await service({ passthrough: CONFIGURED, registry }).probeSsh();
    expect(registry.resolveCalls).toBe(0);
    expect(answer.result.state).toBe('backend_unresolved');
    if (answer.result.state !== 'backend_unresolved') throw new Error('expected unresolved');
    // The reason names both possibilities and claims neither: this service
    // cannot see the per-personality posture, so it does not invent a
    // substitute for `sshRefused.message`.
    expect(answer.result.error).toContain('execution constitution refused it');
    expect(answer.result.error).toContain('requireSandbox');
  });

  it('does not construct a backend for backendHealth either', async () => {
    const registry = new FakeRegistry(null);
    const health = await service({ passthrough: CONFIGURED, registry }).backendHealth();
    expect(registry.resolveCalls).toBe(0);
    expect(health?.resolved).toBe(false);
  });

  it('says so plainly when this process has no registry at all', async () => {
    const answer = await service({ passthrough: CONFIGURED }).probeSsh();
    expect(answer.result.state).toBe('backend_unresolved');
    if (answer.result.state !== 'backend_unresolved') throw new Error('expected unresolved');
    expect(answer.result.error).toContain('registry');
    expect(answer.result.target).toBe('deploy@build-01:22');
  });

  it('renders the target exactly as configured — no defaulted port', async () => {
    const answer = await service({
      passthrough: { 'execution.ssh.host': 'build-01' },
      backend: new FakeSshBackend({ ok: true }, { host: 'build-01' }),
    }).probeSsh();
    if (answer.result.state !== 'reachable') throw new Error('expected reachable');
    expect(answer.result.target).toBe('build-01');
  });

  it('reports stale_config when the target was edited after this process booted', async () => {
    // The registry MEMOISES, so this instance still dials `deploy@build-01:22`
    // however many times config.yaml is saved.
    const backend = new FakeSshBackend({ ok: true });
    const answer = await service({
      passthrough: {
        'execution.ssh.host': 'build-02',
        'execution.ssh.user': 'deploy',
        'execution.ssh.port': '22',
      },
      backend,
    }).probeSsh();
    expect(answer.result).toEqual({
      state: 'stale_config',
      target: 'deploy@build-02:22',
      activeTarget: 'deploy@build-01:22',
    });
    // NEITHER host was contacted. Probing the old one answers about a machine
    // the operator has stopped pointing at; probing the new one answers about a
    // machine no tool will touch until a restart.
    expect(backend.probeCalls).toBe(0);
    expect(backend.isAvailableCalls).toBe(0);
  });

  it('names the target tools are STILL using, which is the operative half', async () => {
    const answer = await service({
      passthrough: { 'execution.ssh.host': 'build-02' },
      backend: new FakeSshBackend({ ok: true }),
    }).probeSsh();
    if (answer.result.state !== 'stale_config') throw new Error('expected stale_config');
    expect(answer.result.activeTarget).toBe('deploy@build-01:22');
    expect(answer.result.target).toBe('build-02');
  });

  it('treats a changed user, port or identity file as a changed target too', async () => {
    // Same host, different account: a probe that only watched the hostname
    // would call this edit applied when nothing about it is live yet.
    const edits: Array<Record<string, string>> = [
      { 'execution.ssh.user': 'root' },
      { 'execution.ssh.port': '2222' },
      { 'execution.ssh.identityFile': '~/.ssh/id_other' },
    ];
    for (const edit of edits) {
      const backend = new FakeSshBackend({ ok: true });
      const answer = await service({
        passthrough: { ...CONFIGURED, ...edit },
        backend,
      }).probeSsh();
      expect(answer.result.state).toBe('stale_config');
      expect(backend.probeCalls).toBe(0);
    }
  });

  it('probes normally when the running backend still matches the configuration', async () => {
    const backend = new FakeSshBackend({ ok: true });
    const answer = await service({ passthrough: CONFIGURED, backend }).probeSsh();
    expect(answer.result.state).toBe('reachable');
    expect(backend.probeCalls).toBe(1);
  });

  it('will not guess when the backend does not expose the target it was built with', async () => {
    const opaque = { name: 'ssh', probe: async () => ({ ok: true }) };
    const registry = new FakeRegistry(opaque as unknown as ExecutionBackend);
    const answer = await service({ passthrough: CONFIGURED, registry }).probeSsh();
    expect(answer.result.state).toBe('backend_unresolved');
    if (answer.result.state !== 'backend_unresolved') throw new Error('expected unresolved');
    expect(answer.result.error).toContain('does not expose the target it was built with');
  });

  it('names the personalities that route to the target, in every state', async () => {
    const personalities = [
      { id: 'remote-hands', execution: 'remote' },
      { id: 'engineer' },
      { id: 'chatty' },
    ];
    const unconfigured = await service({ personalities, backend: null }).probeSsh();
    expect(unconfigured.result.state).toBe('not_configured');
    // The one case that matters most: a personality declares a remote posture
    // and there is no host for it to reach.
    expect(unconfigured.usedBy).toEqual(['remote-hands']);

    const configured = await service({
      passthrough: CONFIGURED,
      backend: new FakeSshBackend({ ok: true }),
      personalities,
    }).probeSsh();
    expect(configured.usedBy).toEqual(['remote-hands']);
  });
});

describe('backendHealth — the admin panel row', () => {
  it('is null when no remote target is configured', async () => {
    expect(await service({ backend: null }).backendHealth()).toBeNull();
  });

  it('reports resolved when the backend exists', async () => {
    const health = await service({
      passthrough: CONFIGURED,
      backend: new FakeSshBackend({ ok: true }),
    }).backendHealth();
    expect(health).toEqual({ name: 'ssh', resolved: true, error: null });
  });

  it('reports the failure without opening a connection', async () => {
    const health = await service({ passthrough: CONFIGURED, backend: null }).backendHealth();
    expect(health?.resolved).toBe(false);
    expect(health?.error).toContain('no ssh execution backend was built at startup');
  });

  it('does not probe — resolving must stay cheap enough for a status poll', async () => {
    const backend = new FakeSshBackend({ ok: true });
    await service({ passthrough: CONFIGURED, backend }).backendHealth();
    expect(backend.probeCalls).toBe(0);
    expect(backend.isAvailableCalls).toBe(0);
  });
});
