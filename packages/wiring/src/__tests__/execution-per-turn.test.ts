// Execution routing follows the TURN's personality, not the process's.
//
// The defect these guard: the posture was resolved ONCE, from ONE personality,
// at composition, and frozen into the tools. But the personality a turn runs as
// is whatever the caller passes — a team routes every member's turn through the
// loop built for `manifest.coordinator`, the CLI `/personality` command swaps
// the id on a loop already composed, and web-api sends any non-team
// personality's turn to the loop built for `config.personality`. So a member
// declaring `execution: remote` ran on the coordinator's LOCAL backend, and,
// booted the other way round, every other personality's commands went to the
// remote host as the ssh login user — while `ethos personality show <id>` and
// the web Execution tab, which compute the posture per requested personality,
// printed the truthful one.
//
// Every assertion here names WHAT REACHED THE BACKEND (or the host spawn), not
// a return value: a command that ran on the wrong machine and then returned
// successfully is precisely the failure, and only the destination tells them
// apart.

import { DefaultExecutionBackendRegistry } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import { createCodeTools } from '@ethosagent/tools-code';
import { createProcessTools } from '@ethosagent/tools-process';
import { createTerminalTools } from '@ethosagent/tools-terminal';
import type {
  ExecChunk,
  ExecOpts,
  ExecSession,
  ExecutionBackend,
  PersonalityConfig,
  SecretsResolver,
  Tool,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createExecutionRouting, type ExecutionRoutingInput } from '../compose-tools';

const SECRETS: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const SUBSTITUTION = { ethosHome: '/home/tester/.ethos', cwd: '/work/project' };
const SSH = { host: 'build-01.internal', user: 'deploy', port: 2222 };

function person(over: Partial<PersonalityConfig> & { id: string }): PersonalityConfig {
  return {
    name: over.id,
    description: 'test',
    toolset: ['terminal', 'run_tests', 'lint', 'process_start'],
    ...over,
  } as PersonalityConfig;
}

/** A registry of personalities, looked up by id — the live-registry seam. */
function registryOf(...people: PersonalityConfig[]) {
  const byId = new Map(people.map((p) => [p.id, p]));
  return { get: (id: string) => byId.get(id) };
}

interface Recorder {
  backend: ExecutionBackend;
  execs: Array<{ cmd: string; opts: ExecOpts }>;
  sessionsFor: string[];
}

/**
 * A backend that records what reached it. `name` is what makes a tool treat a
 * route as remote — there is no flag — so an `ssh` recorder stands in for the
 * remote host and a `docker` recorder for the container.
 */
function recorder(name: string): Recorder {
  const execs: Array<{ cmd: string; opts: ExecOpts }> = [];
  const sessionsFor: string[] = [];
  async function* stream(): AsyncIterable<ExecChunk> {
    yield { stream: 'stdout', data: name };
    yield { stream: 'exit', code: 0 };
  }
  const backend: ExecutionBackend = {
    name,
    isAvailable: () => Promise.resolve(true),
    exec(cmd, opts) {
      execs.push({ cmd, opts });
      return stream();
    },
    spawnSession(personalityId: string): ExecSession {
      sessionsFor.push(personalityId);
      return {
        personalityId,
        exec(cmd, opts) {
          execs.push({ cmd, opts: opts ?? {} });
          return stream();
        },
        dispose: () => Promise.resolve(),
      };
    },
    mountsFor: () => [],
    dispose: () => Promise.resolve(),
  };
  return { backend, execs, sessionsFor };
}

function makeRouting(
  over: Partial<ExecutionRoutingInput> &
    Pick<ExecutionRoutingInput, 'personalities' | 'activePerson'>,
) {
  return createExecutionRouting({
    registry: new DefaultExecutionBackendRegistry(),
    secrets: SECRETS,
    logger: noopLogger,
    substitutionVars: SUBSTITUTION,
    // Docker disabled makes the non-remote postures deterministic on any host:
    // a `docker` posture with no buildable backend resolves to an HONEST
    // `local` one, which is also what a containerized CI box resolves to. Both
    // roads lead to "runs here", which is the thing a remote personality must
    // never share.
    disableDocker: true,
    // Pinned so a container-hosted test run cannot silently turn a `docker`
    // posture into `local` and quietly skip what it came to prove.
    containerized: { env: {}, fileExists: () => false, readFile: () => null },
    ...over,
  });
}

function ctxFor(personalityId: string, hostSpawns: { count: number }) {
  return {
    sessionId: 's1',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/work/project',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    personalityId,
    scopedProcess: {
      spawn: () => {
        hostSpawns.count++;
        return Promise.resolve({ exitCode: 0, stdout: 'this-machine', stderr: '' });
      },
    },
  };
}

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

// ---------------------------------------------------------------------------
// The central regression: teams
// ---------------------------------------------------------------------------

describe('a team member with `execution: remote` does not run on the coordinator loop’s backend', () => {
  const coordinator = person({ id: 'coordinator' });
  const member = person({ id: 'member', execution: 'remote' });

  async function teamSetup() {
    const ssh = recorder('ssh');
    const registry = new DefaultExecutionBackendRegistry();
    registry.register('ssh', () => ssh.backend);
    const routing = await makeRouting({
      personalities: registryOf(coordinator, member),
      activePerson: coordinator,
      registry,
      ssh: SSH,
    });
    return { ssh, routing };
  }

  it('sends the member’s terminal command to the remote host, never to this one', async () => {
    const { ssh, routing } = await teamSetup();
    // The loop was composed for the coordinator — its own posture runs HERE.
    expect(routing.posture.backend).toBe('local');
    expect(routing.backend).toBeUndefined();

    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    const hostSpawns = { count: 0 };

    const result = await terminal.execute({ command: 'hostname' }, ctxFor('member', hostSpawns));

    expect(result.ok).toBe(true);
    // THE assertion: the destination, not the return value.
    expect(hostSpawns.count).toBe(0);
    expect(ssh.execs.map((e) => e.cmd)).toEqual(['hostname']);
    // And the container/host boundary the personality carries travels with it.
    expect(ssh.execs[0]?.opts.personality?.id).toBe('member');
  });

  it('sends run_tests and lint to the remote host on the member’s turn too', async () => {
    const { ssh, routing } = await teamSetup();
    const tools = createCodeTools({ route: routing.exec });
    const hostSpawns = { count: 0 };

    await tool(tools, 'run_tests').execute({}, ctxFor('member', hostSpawns));
    await tool(tools, 'lint').execute({}, ctxFor('member', hostSpawns));

    expect(hostSpawns.count).toBe(0);
    expect(ssh.execs.map((e) => e.cmd)).toEqual(['pnpm test', 'pnpm lint']);
  });

  it('leaves the coordinator’s own turn exactly where it was — on this machine', async () => {
    const { ssh, routing } = await teamSetup();
    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    const hostSpawns = { count: 0 };

    await terminal.execute({ command: 'hostname' }, ctxFor('coordinator', hostSpawns));

    expect(hostSpawns.count).toBe(1);
    expect(ssh.execs).toHaveLength(0);
  });

  it('refuses process_* on the member’s turn instead of spawning it here (D4, per turn)', async () => {
    const { ssh, routing } = await teamSetup();
    const tools = createProcessTools('/tmp/ethos-per-turn-test', { route: routing.process });

    const result = await tool(tools, 'process_start').execute(
      { command: 'sleep 60' },
      ctxFor('member', { count: 0 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toBe('not_available');
    expect(result.error).toBe('process tools are not routed over ssh in v1');
    expect(ssh.execs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The CLI `/personality` switch — the same loop, a new id
// ---------------------------------------------------------------------------

describe('CLI `/personality` switch', () => {
  it('does not use the previous personality’s backend', async () => {
    const local = person({ id: 'local-hands' });
    const remote = person({ id: 'remote-hands', execution: 'remote' });
    const ssh = recorder('ssh');
    const registry = new DefaultExecutionBackendRegistry();
    registry.register('ssh', () => ssh.backend);
    const routing = await makeRouting({
      personalities: registryOf(local, remote),
      activePerson: local,
      registry,
      ssh: SSH,
    });

    // ONE tool instance, exactly as `/personality` leaves it: the command only
    // changes `state.personalityId` on a loop already composed.
    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    const hostSpawns = { count: 0 };

    await terminal.execute({ command: 'before' }, ctxFor('local-hands', hostSpawns));
    await terminal.execute({ command: 'after' }, ctxFor('remote-hands', hostSpawns));

    expect(hostSpawns.count).toBe(1); // the first call, and only the first
    expect(ssh.execs.map((e) => e.cmd)).toEqual(['after']);
  });
});

// ---------------------------------------------------------------------------
// The mirror — booted AS the remote personality
// ---------------------------------------------------------------------------

describe('booted as the `execution: remote` personality', () => {
  const remote = person({ id: 'remote-hands', execution: 'remote' });
  const other = person({ id: 'someone-else' });

  async function mirrorSetup() {
    const ssh = recorder('ssh');
    const registry = new DefaultExecutionBackendRegistry();
    registry.register('ssh', () => ssh.backend);
    const routing = await makeRouting({
      personalities: registryOf(remote, other),
      activePerson: remote,
      registry,
      ssh: SSH,
    });
    return { ssh, routing };
  }

  it('never sends another personality’s commands to the remote host', async () => {
    const { ssh, routing } = await mirrorSetup();
    expect(routing.backend?.name).toBe('ssh'); // the boot personality DOES route

    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    const hostSpawns = { count: 0 };

    await terminal.execute({ command: 'hostname' }, ctxFor('someone-else', hostSpawns));

    // The remote box is somebody else's machine and the ssh login user is
    // unconfined there. Nothing this personality asked for goes to it.
    expect(ssh.execs).toHaveLength(0);
    expect(hostSpawns.count).toBe(1);
  });

  it('still routes the remote personality’s own turn remotely', async () => {
    const { ssh, routing } = await mirrorSetup();
    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    const hostSpawns = { count: 0 };

    await terminal.execute({ command: 'hostname' }, ctxFor('remote-hands', hostSpawns));

    expect(ssh.execs.map((e) => e.cmd)).toEqual(['hostname']);
    expect(hostSpawns.count).toBe(0);
  });

  it('tells the model its shell is remote only on the turn that actually is', async () => {
    const { routing } = await mirrorSetup();

    expect((await routing.resolveTurn('remote-hands'))?.backend?.name).toBe('ssh');
    expect((await routing.resolveTurn('someone-else'))?.backend).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mounts and network mode (docker) follow the turn's personality
// ---------------------------------------------------------------------------

describe('the docker container is built from the TURN’s personality', () => {
  it('hands the backend the turn’s personality — its fs_reach, its network policy', async () => {
    const boot = person({
      id: 'boot',
      fs_reach: { workdir: '/work/boot' },
      safety: { network: { allow: ['boot.example'] } },
    } as Partial<PersonalityConfig> & { id: string });
    const guest = person({
      id: 'guest',
      fs_reach: { workdir: '/work/guest' },
      safety: { network: { allow: ['guest.example'] } },
    } as Partial<PersonalityConfig> & { id: string });

    const docker = recorder('docker');
    const registry = new DefaultExecutionBackendRegistry();
    registry.register('docker', () => docker.backend);
    const routing = await makeRouting({
      personalities: registryOf(boot, guest),
      activePerson: boot,
      registry,
      disableDocker: false,
    });
    expect(routing.posture.backend).toBe('docker');

    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    await terminal.execute({ command: 'pwd' }, ctxFor('guest', { count: 0 }));

    // `DockerExecutionBackend.exec` derives BOTH the mount set
    // (`mountsFor(opts.personality)`) and `networkMode`
    // (`resolveNetworkMode(opts.personality)`) from this object. Handing it the
    // boot personality is how personality B's container came to carry A's
    // reach.
    const passed = docker.execs.at(-1)?.opts.personality;
    expect(passed?.id).toBe('guest');
    expect(passed?.fs_reach?.workdir).toBe('/work/guest');
    expect(passed?.safety?.network?.allow).toEqual(['guest.example']);
    // The SessionManager lane is keyed by personality id too, so the guest gets
    // its own container lane rather than joining the boot personality's.
    expect(docker.sessionsFor).toContain('guest');
    expect(docker.sessionsFor).not.toContain('boot');
  });
});

// ---------------------------------------------------------------------------
// Degradation direction, and the common case
// ---------------------------------------------------------------------------

describe('routing edges', () => {
  it('refuses a personality the registry does not know, rather than lending it the default’s route', async () => {
    const remote = person({ id: 'remote-hands', execution: 'remote' });
    const ssh = recorder('ssh');
    const registry = new DefaultExecutionBackendRegistry();
    registry.register('ssh', () => ssh.backend);
    const routing = await makeRouting({
      personalities: registryOf(remote),
      activePerson: remote,
      registry,
      ssh: SSH,
    });

    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    const hostSpawns = { count: 0 };

    const result = await terminal.execute({ command: 'hostname' }, ctxFor('ghost', hostSpawns));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toBe('not_available');
    expect(ssh.execs).toHaveLength(0);
    expect(hostSpawns.count).toBe(0);
  });

  it('leaves a single-personality deployment exactly as it was', async () => {
    const only = person({ id: 'solo' });
    const routing = await makeRouting({
      personalities: registryOf(only),
      activePerson: only,
    });

    const [terminal] = createTerminalTools({ route: routing.exec });
    if (!terminal) throw new Error('terminal not built');
    const hostSpawns = { count: 0 };

    // The turn's id, and the no-id case a directly driven tool presents: both
    // land on the deployment default, which is what this process composed for.
    await terminal.execute({ command: 'a' }, ctxFor('solo', hostSpawns));
    const noId = ctxFor('solo', hostSpawns) as Record<string, unknown>;
    noId.personalityId = undefined;
    await terminal.execute({ command: 'b' }, noId as never);

    expect(hostSpawns.count).toBe(2);
    expect((await routing.exec('solo')).personality?.id).toBe('solo');
    expect((await routing.exec(undefined)).personality?.id).toBe('solo');
  });
});
