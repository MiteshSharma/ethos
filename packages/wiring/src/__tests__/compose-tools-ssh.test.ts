// Remote execution routing (plan `remote-execution-routing.md`, T5) — an
// `execution: ssh` personality with a configured target must actually run its
// commands on that target. The failure this file exists to catch is the quiet
// one: routing that never happens, so `terminal` runs HERE while the character
// sheet names a remote host and the operator believes their build machine is
// doing the work. Every assertion about "it routed" therefore names the
// backend, never merely the absence of an error.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultExecutionBackendRegistry } from '@ethosagent/core';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { SshExecutionBackend } from '@ethosagent/execution-ssh';
import { noopLogger } from '@ethosagent/logger';
import { createCodeTools } from '@ethosagent/tools-code';
import { createProcessTools } from '@ethosagent/tools-process';
import { createTerminalTools } from '@ethosagent/tools-terminal';
import type {
  Constitution,
  ExecChunk,
  ExecOpts,
  ExecutionBackend,
  ExecutionPosture,
  PersonalityConfig,
  SecretsResolver,
  Tool,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRemoteExecutionInjector,
  resolveExecRefusal,
  resolveSshExecutionBackend,
} from '../compose-tools';

const SECRETS: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const SUBSTITUTION = { ethosHome: '/home/tester/.ethos', cwd: '/work/project' };

const SSH_TARGET = { host: 'build-01.internal', user: 'deploy', port: 2222 };

/** The refusal a Docker posture emits — the one an ssh refusal must NOT reuse. */
const DOCKER_SENTENCE =
  'Execution requires a Docker sandbox, but none is available and the constitution forbids running un-sandboxed on the host.';

function posture(overrides: Partial<ExecutionPosture> = {}): ExecutionPosture {
  return {
    backend: 'ssh',
    networkMode: 'bridge',
    memoryMb: 256,
    containerized: false,
    mounts: [],
    scratchPaths: [],
    ...overrides,
  };
}

/**
 * The registry the compose path uses, wired exactly as `build-infrastructure`
 * wires it — the real ssh factory, and the real LOCAL one alongside it, so a
 * test can tell "routed remotely" from "quietly ran here". Neither factory
 * dials anything at construction time.
 */
function makeRegistry(): { registry: DefaultExecutionBackendRegistry; localBuilt: () => number } {
  const registry = new DefaultExecutionBackendRegistry();
  let localCount = 0;
  registry.register('local', (ctx) => {
    localCount++;
    return new LocalExecutionBackend(ctx);
  });
  registry.register('ssh', (ctx) => new SshExecutionBackend(ctx));
  return { registry, localBuilt: () => localCount };
}

function makeCtx(workingDir = '/work/project') {
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    personalityId: 'remote-hands',
  };
}

function getTool(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

interface RecordingBackend extends ExecutionBackend {
  calls: Array<{ cmd: string; opts: ExecOpts }>;
  availabilityChecks: number;
  lastProbeError?: string;
}

/**
 * A stand-in backend that records what the TOOL handed it. `name` is the ONLY
 * thing that makes a tool behave remotely now — there is no flag to pass — so a
 * test that wants the non-remote path names a non-ssh backend, exactly as the
 * compose path would wire one.
 */
function recordingBackend(opts?: {
  available?: boolean;
  probeError?: string;
  name?: string;
}): RecordingBackend {
  const backend: RecordingBackend = {
    name: opts?.name ?? 'ssh',
    calls: [],
    availabilityChecks: 0,
    ...(opts?.probeError !== undefined ? { lastProbeError: opts.probeError } : {}),
    isAvailable: () => {
      backend.availabilityChecks++;
      return Promise.resolve(opts?.available ?? true);
    },
    exec: (cmd: string, execOpts: ExecOpts) => {
      backend.calls.push({ cmd, opts: execOpts });
      async function* gen(): AsyncIterable<ExecChunk> {
        yield { stream: 'stdout', data: 'remote-host\n' };
        yield { stream: 'exit', code: 0 };
      }
      return gen();
    },
    spawnSession: (personalityId: string) => ({
      personalityId,
      exec: (cmd: string, execOpts: ExecOpts = {}) => backend.exec(cmd, execOpts),
      dispose: () => Promise.resolve(),
    }),
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return backend;
}

const PERSONALITY = { id: 'remote-hands', name: 'remote-hands' } as PersonalityConfig;

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

describe('resolveSshExecutionBackend', () => {
  it('resolves an SSH backend when the posture is ssh, a host is configured, and the constitution permits', async () => {
    const { registry } = makeRegistry();

    const backend = await resolveSshExecutionBackend({
      posture: posture(),
      ssh: SSH_TARGET,
      substitutionVars: SUBSTITUTION,
      registry,
      secrets: SECRETS,
      logger: noopLogger,
    });

    expect(backend).toBeDefined();
    // THE regression: not "no error was thrown" — the resolved backend IS the
    // remote one. A gate that silently fails open leaves this `undefined` (and
    // execution on the host); a gate that resolves the wrong backend fails here.
    expect(backend?.name).toBe('ssh');
    expect(backend).toBeInstanceOf(SshExecutionBackend);
  });

  it('never builds the local backend for an ssh posture with a configured host', async () => {
    const { registry, localBuilt } = makeRegistry();

    const backend = await resolveSshExecutionBackend({
      posture: posture(),
      ssh: SSH_TARGET,
      substitutionVars: SUBSTITUTION,
      registry,
      secrets: SECRETS,
      logger: noopLogger,
    });

    expect(backend?.name).toBe('ssh');
    expect(localBuilt()).toBe(0);
    expect(registry.get('local')).toBeUndefined();
  });

  it('forwards the operator target verbatim, including the fields beyond host/user/port', async () => {
    const registry = new DefaultExecutionBackendRegistry();
    let seen: unknown;
    registry.register('ssh', (ctx) => {
      seen = ctx.config.ssh;
      return new SshExecutionBackend(ctx);
    });

    await resolveSshExecutionBackend({
      posture: posture(),
      ssh: {
        ...SSH_TARGET,
        identityFile: '/keys/id_ed25519',
        knownHostsFile: '/keys/known_hosts',
        strictHostKeys: 'yes',
        remoteWorkdir: '/srv/work',
      },
      substitutionVars: SUBSTITUTION,
      registry,
      secrets: SECRETS,
      logger: noopLogger,
    });

    expect(seen).toEqual({
      host: 'build-01.internal',
      user: 'deploy',
      port: 2222,
      identityFile: '/keys/id_ed25519',
      knownHostsFile: '/keys/known_hosts',
      strictHostKeys: 'yes',
      remoteWorkdir: '/srv/work',
    });
  });

  it('resolves nothing when the constitution requires a sandbox (D7)', async () => {
    const { registry } = makeRegistry();
    const constitution: Constitution = { execution: { requireSandbox: true } };

    const backend = await resolveSshExecutionBackend({
      posture: posture(),
      ssh: SSH_TARGET,
      constitution,
      substitutionVars: SUBSTITUTION,
      registry,
      secrets: SECRETS,
      logger: noopLogger,
    });

    expect(backend).toBeUndefined();
  });

  it('resolves nothing when the constitution forbids local (D7)', async () => {
    const { registry } = makeRegistry();

    const backend = await resolveSshExecutionBackend({
      posture: posture(),
      ssh: SSH_TARGET,
      constitution: { execution: { forbidLocal: true } },
      substitutionVars: SUBSTITUTION,
      registry,
      secrets: SECRETS,
      logger: noopLogger,
    });

    expect(backend).toBeUndefined();
  });

  it('resolves nothing when no host is configured, and nothing for a non-ssh posture', async () => {
    const { registry } = makeRegistry();

    expect(
      await resolveSshExecutionBackend({
        posture: posture(),
        substitutionVars: SUBSTITUTION,
        registry,
        secrets: SECRETS,
        logger: noopLogger,
      }),
    ).toBeUndefined();

    expect(
      await resolveSshExecutionBackend({
        posture: posture({ backend: 'local' }),
        ssh: SSH_TARGET,
        substitutionVars: SUBSTITUTION,
        registry,
        secrets: SECRETS,
        logger: noopLogger,
      }),
    ).toBeUndefined();
  });

  it('fails loud when the backend cannot be resolved, naming the target and the reason', async () => {
    const registry = new DefaultExecutionBackendRegistry();
    registry.register('ssh', () => {
      throw new Error('ssh: connect to host build-01.internal port 2222: Connection timed out');
    });

    await expect(
      resolveSshExecutionBackend({
        posture: posture(),
        ssh: SSH_TARGET,
        substitutionVars: SUBSTITUTION,
        registry,
        secrets: SECRETS,
        logger: noopLogger,
      }),
    ).rejects.toThrow(/deploy@build-01\.internal:2222.*Connection timed out/s);
  });
});

// ---------------------------------------------------------------------------
// What the tools do with the routed backend
// ---------------------------------------------------------------------------

describe('terminal under an ssh posture', () => {
  it('runs the command through the remote backend and never touches the host process', async () => {
    const backend = recordingBackend();
    let hostSpawns = 0;
    const [terminal] = createTerminalTools({
      backend,
      personality: PERSONALITY,
    });
    if (!terminal) throw new Error('terminal not built');

    const result = await terminal.execute(
      { command: 'hostname' },
      {
        ...makeCtx(),
        scopedProcess: {
          spawn: () => {
            hostSpawns++;
            return Promise.resolve({ exitCode: 0, stdout: 'this-machine', stderr: '' });
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(backend.calls.map((c) => c.cmd)).toEqual(['hostname']);
    expect(hostSpawns).toBe(0);
  });

  it('does NOT send the host working directory to the remote (D8)', async () => {
    const backend = recordingBackend();
    const [terminal] = createTerminalTools({
      backend,
      personality: PERSONALITY,
    });
    if (!terminal) throw new Error('terminal not built');

    await terminal.execute({ command: 'pwd' }, makeCtx('/home/tester/secret-project'));

    // The host's cwd names a directory on THIS machine. On the remote it is
    // either absent or a different directory wearing the same name; either way
    // it is not the operator's `remoteWorkdir`, which is what must apply.
    expect(backend.calls[0]?.opts.cwd).toBeUndefined();
    expect(JSON.stringify(backend.calls[0]?.opts)).not.toContain('secret-project');
  });

  it('passes an explicit cwd argument through verbatim as a remote path', async () => {
    const backend = recordingBackend();
    const [terminal] = createTerminalTools({
      backend,
      personality: PERSONALITY,
    });
    if (!terminal) throw new Error('terminal not built');

    await terminal.execute({ command: 'pwd', cwd: '/srv/elsewhere' }, makeCtx());

    expect(backend.calls[0]?.opts.cwd).toBe('/srv/elsewhere');
  });

  it('keeps the host working directory under a non-remote posture', async () => {
    const backend = recordingBackend({ name: 'docker' });
    const [terminal] = createTerminalTools({ backend, personality: PERSONALITY });
    if (!terminal) throw new Error('terminal not built');

    await terminal.execute({ command: 'pwd' }, makeCtx('/work/project'));

    expect(backend.calls[0]?.opts.cwd).toBe('/work/project');
  });

  it('refuses with the SSH reason, not the Docker sentence, when the constitution forbids it', async () => {
    // What the resolver puts on the posture when a target is configured but the
    // constitution requires a sandbox — the compose path hands this verbatim to
    // the tools rather than inventing a second wording.
    const sshRefusal =
      'ssh refused: the constitution requires a sandbox (execution.requireSandbox / forbidLocal). ssh is remote-host trust, not mount-confinement, so it does not satisfy that requirement.';
    const [terminal] = createTerminalTools({
      personality: PERSONALITY,
      hostExecForbidden: true,
      hostExecForbiddenMessage: sshRefusal,
    });
    if (!terminal) throw new Error('terminal not built');

    const result = await terminal.execute({ command: 'hostname' }, makeCtx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toBe('not_available');
    expect(result.error).toBe(sshRefusal);
    expect(result.error).not.toContain('Docker');
  });

  it('still emits the Docker sentence when no posture-specific message is given', async () => {
    const [terminal] = createTerminalTools({ personality: PERSONALITY, hostExecForbidden: true });
    if (!terminal) throw new Error('terminal not built');

    const result = await terminal.execute({ command: 'hostname' }, makeCtx());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toBe(DOCKER_SENTENCE);
  });
});

describe('process tools under an ssh posture (D4)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ethos-ssh-process-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses process_start with the v1 reason instead of spawning on the host', async () => {
    // The compose path passes NO backend and an explicit refusal under ssh.
    const tools = createProcessTools(dataDir, {
      personality: PERSONALITY,
      hostExecForbidden: true,
      hostExecForbiddenMessage: 'process tools are not routed over ssh in v1',
    });

    const result = await getTool(tools, 'process_start').execute(
      { command: 'sleep 60' },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toBe('not_available');
    expect(result.error).toBe('process tools are not routed over ssh in v1');
    expect(result.error).not.toContain('Docker');
  });
});

describe('code tools under an ssh posture', () => {
  it('declares ssh as the spawned binary at BOTH capability sites', () => {
    const tools = createCodeTools({
      backend: recordingBackend(),
      personality: PERSONALITY,
    });

    // run_code — the site the plan names.
    expect(getTool(tools, 'run_code').capabilities?.process?.allowedBinaries).toEqual(['ssh']);
    // run_tests / lint — the second site, built by the shared command runner.
    // Missing this one leaves both tools declaring `docker` while executing ssh.
    expect(getTool(tools, 'run_tests').capabilities?.process?.allowedBinaries).toEqual(['ssh']);
    expect(getTool(tools, 'lint').capabilities?.process?.allowedBinaries).toEqual(['ssh']);
  });

  it('keeps docker/bash at both sites when execution is not remote', () => {
    const routed = createCodeTools({
      backend: recordingBackend({ name: 'docker' }),
      personality: PERSONALITY,
    });
    expect(getTool(routed, 'run_code').capabilities?.process?.allowedBinaries).toEqual(['docker']);
    expect(getTool(routed, 'run_tests').capabilities?.process?.allowedBinaries).toEqual(['docker']);

    const host = createCodeTools({ personality: PERSONALITY });
    expect(getTool(host, 'lint').capabilities?.process?.allowedBinaries).toEqual(['bash']);
  });

  it('sends run_code to a stdin-driven runner unwrapped and with an empty env', async () => {
    const backend = recordingBackend();
    const tools = createCodeTools({
      backend,
      personality: PERSONALITY,
    });

    const result = await getTool(tools, 'run_code').execute(
      { runtime: 'python', code: 'print(1)' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const call = backend.calls[0];
    expect(call?.cmd).toBe('python3 -');
    // `sh -c 'python3 -'` would leave the runner reading the wrapper's stdin.
    expect(call?.opts.shell).toBe(false);
    // The ssh backend THROWS on a non-empty env; a routed caller must send none.
    expect(call?.opts.env).toEqual({});
    expect(call?.opts.stdin).toBe('print(1)');
  });

  it('does not send the host working directory to a remote run_tests, but keeps an explicit cwd (D8)', async () => {
    const backend = recordingBackend();
    const tools = createCodeTools({
      backend,
      personality: PERSONALITY,
    });
    const runTests = getTool(tools, 'run_tests');

    await runTests.execute({}, makeCtx('/home/tester/secret-project'));
    expect(backend.calls[0]?.opts.cwd).toBeUndefined();

    await runTests.execute({ cwd: '/srv/work' }, makeCtx('/home/tester/secret-project'));
    expect(backend.calls[1]?.opts.cwd).toBe('/srv/work');
  });

  it('surfaces the probe stderr when the target is unreachable, and re-probes every call', async () => {
    const backend = recordingBackend({
      available: false,
      probeError: 'deploy@build-01.internal: Permission denied (publickey).',
    });
    const tools = createCodeTools({ backend, personality: PERSONALITY });
    const runCode = getTool(tools, 'run_code');

    const first = await runCode.execute({ runtime: 'bash', code: 'echo hi' }, makeCtx());
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('expected refusal');
    expect(first.code).toBe('not_available');
    // "not available" alone leaves an operator guessing between a wrong key and
    // an unreachable host. The probe already knows which.
    expect(first.error).toContain('Permission denied (publickey)');

    // A failure is never cached: the next invocation asks again, so a transient
    // blip does not pin the tool to `not_available`.
    await runCode.execute({ runtime: 'bash', code: 'echo hi' }, makeCtx());
    expect(backend.availabilityChecks).toBe(2);
    expect(backend.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// `execution: none` (HIGH 1)
//
// The governed schema change made `execution: none` loadable from a
// personality's config.yaml, documented as "execution refused". The refusal gate
// computed nothing for it, so `terminal` / `run_tests` / `lint` / `process_start`
// fell through to their local `ScopedProcess` paths and ran on the host: a field
// granting precisely what it claims to deny. Every assertion below names the
// SPAWN, not merely the return value — a tool that refuses after spawning has
// already run the command.
// ---------------------------------------------------------------------------

const NONE_REFUSAL =
  'execution posture "none": this personality has no execution backend and does not run commands';

describe('execution: none', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ethos-none-posture-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('forbids host execution unconditionally, in its own words', () => {
    // Unconditional in `backendWired`: no backend is ever resolved at this
    // posture, so neither answer may excuse the refusal.
    expect(resolveExecRefusal(posture({ backend: 'none' }), false)).toEqual({
      forbidden: true,
      message: NONE_REFUSAL,
    });
    expect(resolveExecRefusal(posture({ backend: 'none' }), true)).toEqual({
      forbidden: true,
      message: NONE_REFUSAL,
    });
    // A `none` personality is not waiting for a sandbox that failed to start.
    // Blaming Docker would send an operator installing one.
    expect(NONE_REFUSAL).not.toContain('Docker');
  });

  it('still lets a wired backend execute at the other postures', () => {
    expect(resolveExecRefusal(posture({ backend: 'ssh' }), true).forbidden).toBe(false);
    expect(resolveExecRefusal(posture({ backend: 'local' }), false).forbidden).toBe(false);
    expect(resolveExecRefusal(posture({ backend: 'docker' }), false).forbidden).toBe(true);
  });

  it('leaves every execution-bearing tool refusing, and never spawns on the host', async () => {
    // Exactly what `composeAllTools` hands the tool factories at this posture.
    const refusal = resolveExecRefusal(posture({ backend: 'none' }), false);
    const wiring = {
      personality: PERSONALITY,
      hostExecForbidden: refusal.forbidden,
      ...(refusal.message !== undefined ? { hostExecForbiddenMessage: refusal.message } : {}),
    };

    let hostSpawns = 0;
    const ctx = {
      ...makeCtx(),
      scopedProcess: {
        spawn: () => {
          hostSpawns++;
          return Promise.resolve({ exitCode: 0, stdout: 'ran on the host', stderr: '' });
        },
      },
    };

    const tools = [
      ...createTerminalTools(wiring),
      ...createCodeTools(wiring),
      ...createProcessTools(dataDir, wiring),
    ];
    const args: Record<string, unknown> = {
      terminal: { command: 'hostname' },
      run_code: { runtime: 'bash', code: 'hostname' },
      run_tests: {},
      lint: {},
      process_start: { command: 'sleep 60' },
    };

    for (const name of ['terminal', 'run_code', 'run_tests', 'lint', 'process_start']) {
      const result = await getTool(tools, name).execute(args[name] ?? {}, ctx);
      // THE assertion, checked per tool and before the return value: a refusal
      // returned after the command already ran is not a refusal, and naming the
      // spawn is what tells the two apart.
      expect(hostSpawns, `${name} spawned on the host`).toBe(0);
      expect(result.ok, name).toBe(false);
      if (result.ok) throw new Error(`expected ${name} to refuse`);
      expect(result.code, name).toBe('not_available');
    }

    // `run_code` has no host path at all — it self-gates on a wired backend and
    // speaks its own sentence. The four that DO have one must speak the
    // posture's.
    for (const name of ['terminal', 'run_tests', 'lint', 'process_start']) {
      const result = await getTool(tools, name).execute(args[name] ?? {}, ctx);
      if (result.ok) throw new Error(`expected ${name} to refuse`);
      expect(result.error, name).toBe(NONE_REFUSAL);
    }

    expect(hostSpawns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Remoteness is derived, not passed (HIGH 2)
//
// `remoteBackend` used to be an optional boolean travelling BESIDE `backend`,
// so any caller could hand a tool an ssh backend and omit the flag. The
// compiler accepted the dangerous default, and the two bugs it produced are the
// two already fixed once here: the host `ctx.workingDir` sent to the remote as
// a remote path, and a capability ledger declaring `docker` while executing
// `ssh`. These tests pass NO flag — there is none to pass.
// ---------------------------------------------------------------------------

describe('remote behaviour with no flag', () => {
  it('treats an ssh backend as remote in terminal: no host cwd, no host spawn', async () => {
    const backend = recordingBackend();
    let hostSpawns = 0;
    const [terminal] = createTerminalTools({ backend, personality: PERSONALITY });
    if (!terminal) throw new Error('terminal not built');

    const result = await terminal.execute(
      { command: 'pwd' },
      {
        ...makeCtx('/home/tester/secret-project'),
        scopedProcess: {
          spawn: () => {
            hostSpawns++;
            return Promise.resolve({ exitCode: 0, stdout: 'this-machine', stderr: '' });
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(backend.calls[0]?.opts.cwd).toBeUndefined();
    expect(JSON.stringify(backend.calls[0]?.opts)).not.toContain('secret-project');
    expect(hostSpawns).toBe(0);
  });

  it('treats an ssh backend as remote at both code capability sites', () => {
    const tools = createCodeTools({ backend: recordingBackend(), personality: PERSONALITY });
    expect(getTool(tools, 'run_code').capabilities?.process?.allowedBinaries).toEqual(['ssh']);
    expect(getTool(tools, 'run_tests').capabilities?.process?.allowedBinaries).toEqual(['ssh']);
    expect(getTool(tools, 'lint').capabilities?.process?.allowedBinaries).toEqual(['ssh']);
  });

  it('does not treat a docker backend as remote, from the same call shape', async () => {
    // The identical call, one field of the BACKEND different. Remoteness follows
    // the thing that actually executes, so the two cannot disagree.
    const backend = recordingBackend({ name: 'docker' });
    const [terminal] = createTerminalTools({ backend, personality: PERSONALITY });
    if (!terminal) throw new Error('terminal not built');

    await terminal.execute({ command: 'pwd' }, makeCtx('/work/project'));

    expect(backend.calls[0]?.opts.cwd).toBe('/work/project');
    const code = createCodeTools({ backend, personality: PERSONALITY });
    expect(getTool(code, 'run_code').capabilities?.process?.allowedBinaries).toEqual(['docker']);
    expect(getTool(code, 'run_tests').capabilities?.process?.allowedBinaries).toEqual(['docker']);
  });
});

// ---------------------------------------------------------------------------
// The seam is actually wired
//
// `composeAllTools` needs a whole `InfrastructureResult` to call, so the gate
// above is proven behaviourally and its USE is proven here — the same shape
// `grounding-hardening.test.ts` uses for the `check: run` route. What these
// guard is a resolver that resolves nothing into the tools: a backend built and
// then not handed over is the same silent local execution as no backend at all.
// ---------------------------------------------------------------------------

describe('compose-tools wires the ssh gate to the tools', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'compose-tools.ts'), 'utf-8');

  it('assigns the routed backend from the gate', () => {
    expect(src).toContain('const built = await resolveSshExecutionBackend({');
  });

  it('hands the tools the posture refusal rather than a second wording', () => {
    expect(src).toContain(
      'const turnRefusal = resolveExecRefusal(turn.posture, turn.backend !== undefined);',
    );
    expect(src).toContain('const message = turn.buildError ?? turnRefusal.message;');
  });

  it('never hands the tools a remoteness flag beside the backend', () => {
    // The whole point of deriving remoteness inside the tool factories: a flag
    // passed beside the backend is a flag a caller can omit or contradict, and
    // both bugs that caused (a host cwd sent to the remote, a capability ledger
    // naming `docker` while running `ssh`) were shipped exactly that way. If
    // this string reappears here, the disagreement is back.
    expect(src).not.toContain('remoteBackend');
  });

  it('gives every exec tool the SAME per-turn router, and none a frozen backend', () => {
    // The defect this replaced: a backend resolved once from `activePerson` and
    // handed to tools that never look at the turn's personality. If a static
    // `backend:`/`personality:` pair reappears at these call sites, one
    // personality's commands are running under another's posture again.
    expect(src).toContain('for (const tool of createTerminalTools({ route: execRoute }))');
    expect(src).toContain('route: execRoute,');
    expect(src).toContain('route: processRoute,');
    expect(src).not.toContain('personality: activePerson,\n    hostExecForbidden');
  });

  it('tells the model what the router resolved, not what the process booted as', () => {
    // The injector and the tools must read ONE resolution: an injector keyed on
    // the boot personality says "your shell is remote" to the wrong turn, or
    // says nothing to the right one.
    expect(src).toContain('const turn = await routing.resolveTurn(personalityId);');
    expect(src).toContain("if (turn?.backend?.name !== 'ssh') return undefined;");
  });

  it('excludes process_* from remote routing (D4)', () => {
    expect(src).toContain("if (kind === 'process' && turn.posture.backend === 'ssh') {");
    expect(src).toContain('hostExecForbiddenMessage: processSshUnsupported,');
    expect(src).toContain(
      "const processSshUnsupported = 'process tools are not routed over ssh in v1';",
    );
  });
});

// ---------------------------------------------------------------------------
// What the model is told (D4)
// ---------------------------------------------------------------------------

describe('createRemoteExecutionInjector', () => {
  /** The shape compose-tools hands it: resolve the target for THIS turn's personality. */
  function injectorFor(routes: Record<string, { target: string; remoteWorkdir?: string }>) {
    return createRemoteExecutionInjector({
      resolveTarget: (personalityId) => Promise.resolve(routes[personalityId]),
    });
  }

  it('states plainly that terminal is remote, unconfined, and split from the file tools', async () => {
    const injector = injectorFor({
      'remote-hands': { target: 'deploy@build-01.internal:2222', remoteWorkdir: '/srv/work' },
    });

    const result = await injector.inject({ personalityId: 'remote-hands' } as never);
    const content = result?.content ?? '';

    expect(content).toContain('deploy@build-01.internal:2222');
    expect(content).toContain('They do NOT run on this machine.');
    // The security property. Not softened: there is no remote deny floor.
    expect(content).toContain('NO path floor');
    expect(content).toContain('read or write anything the ssh login user can');
    // The split: shell remote, files local.
    expect(content).toContain('stay on THIS machine');
    expect(content).toContain('/srv/work');
    expect(content).toContain('`process_*`');
  });

  it('names the remote login directory when no remote workdir is configured', async () => {
    const injector = injectorFor({ 'remote-hands': { target: 'build-01' } });
    const result = await injector.inject({ personalityId: 'remote-hands' } as never);
    expect(result?.content).toContain('the remote login directory');
  });

  it('injects only for a personality whose execution actually routes remotely', async () => {
    // The mirror of the routing defect, in the prompt: booted as the remote
    // personality, this used to gate on that BOOT id — so a local personality's
    // turn was told nothing (while its commands went to the remote box), and,
    // booted the other way, a remote personality's turn was told nothing at
    // all. It follows the turn now, and the turn only.
    const injector = injectorFor({ 'remote-hands': { target: 'build-01' } });

    expect(await injector.inject({ personalityId: 'remote-hands' } as never)).not.toBeNull();
    expect(await injector.inject({ personalityId: 'stays-local' } as never)).toBeNull();
  });
});
