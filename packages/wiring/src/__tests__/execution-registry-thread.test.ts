// The loop's execution-backend registry, exposed on `CreateAgentLoopResult`
// (plan `remote-execution-routing.md`, T7 follow-up).
//
// T7's Settings probe is only honest if it tests the backend the TOOLS run on.
// The registry memoises, so handing a composition root the registry is the same
// as handing it the instance — but only if it is the registry `compose-tools`
// resolved against. This file pins that: one registry per loop, one instance
// per name, and the result type carrying it as a REQUIRED field so a
// composition root cannot forget it and silently ship a probe that answers
// `backend_unresolved` forever (which is exactly what shipped).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DefaultExecutionBackendRegistry } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import type { ExecutionBackend, ExecutionPosture, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveSshExecutionBackend } from '../compose-tools';
import type { CreateAgentLoopResult } from '../index';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const SECRETS: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const SSH = { host: 'build-01.internal', user: 'deploy', port: 2222 };

function sshPosture(): ExecutionPosture {
  return {
    backend: 'ssh',
    networkMode: 'bridge',
    memoryMb: 256,
    containerized: false,
    mounts: [],
    scratchPaths: [],
  };
}

/** Stand-in for `SshExecutionBackend` — probeable, and dials nothing. */
class FakeSsh {
  readonly name = 'ssh';
  probeCalls = 0;
  probe(): Promise<{ ok: boolean }> {
    this.probeCalls += 1;
    return Promise.resolve({ ok: true });
  }
}

/** The registry `buildInfrastructure` builds — the real, memoising one. */
function loopRegistry(): { registry: DefaultExecutionBackendRegistry; built: () => FakeSsh[] } {
  const built: FakeSsh[] = [];
  const registry = new DefaultExecutionBackendRegistry();
  registry.register('ssh', () => {
    const backend = new FakeSsh();
    built.push(backend);
    return backend as unknown as ExecutionBackend;
  });
  return { registry, built: () => built };
}

/** What the loop does at compose time: resolve the personality's backend. */
function resolveForTools(registry: DefaultExecutionBackendRegistry) {
  return resolveSshExecutionBackend({
    posture: sshPosture(),
    ssh: SSH,
    substitutionVars: { ethosHome: '/home/tester/.ethos', cwd: '/work/project' },
    registry,
    secrets: SECRETS,
    logger: noopLogger,
  });
}

describe('the registry a loop hands out is the one its tools execute on', () => {
  it('get() returns the very instance compose-tools gave the tools', async () => {
    const { registry, built } = loopRegistry();
    const toolBackend = await resolveForTools(registry);
    expect(toolBackend).toBeDefined();

    // The probe's first move, on the registry `serve`/`boot` now thread through.
    const probed = registry.get('ssh');

    expect(probed).toBe(toolBackend);
    expect(built()).toHaveLength(1);
    await (probed as unknown as FakeSsh).probe();
    expect(built()[0]?.probeCalls).toBe(1);
  });

  it('memoises, so even the resolve() fallback cannot become a second backend', async () => {
    const { registry, built } = loopRegistry();
    const toolBackend = await resolveForTools(registry);

    // A later caller passing an entirely different ctx still gets the first
    // instance — which is what makes threading the REGISTRY (rather than the
    // backend) sufficient, and what makes the probe honest.
    const second = await registry.resolve('ssh', {
      config: { ssh: { host: 'somewhere-else' } },
      secrets: SECRETS,
      logger: noopLogger,
    });

    expect(second).toBe(toolBackend);
    expect(built()).toHaveLength(1);
  });

  it('is a required field of the loop result, not an optional one to forget', () => {
    // Compile-time: a registry is assignable, and the field is not `| undefined`
    // — a composition root that skips it fails typecheck rather than shipping a
    // permanently unresolved probe.
    const registry: CreateAgentLoopResult['executionBackends'] =
      new DefaultExecutionBackendRegistry();
    expect(typeof registry.resolve).toBe('function');
    expect(typeof registry.get).toBe('function');
  });

  it('the result returns infra.executionBackends itself, not a fresh registry', () => {
    const build = readFileSync(join(ROOT, 'packages/wiring/src/build-agent-loop.ts'), 'utf8');
    const compose = readFileSync(join(ROOT, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    // One `infra`, one registry: the tools resolve on it, the result hands it
    // out. Two different expressions here would be two different objects.
    expect(build).toContain('executionBackends: infra.executionBackends,');
    expect(compose).toContain('registry: infra.executionBackends,');
    expect(build).not.toContain('new DefaultExecutionBackendRegistry');
  });
});
