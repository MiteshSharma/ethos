import type { Constitution, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type ContainerizedDetectionInput,
  constitutionForbidsLocal,
  detectContainerized,
  formatSshTarget,
  resolveExecutionPosture,
} from '../resolve-execution-posture';

function p(extra: Partial<PersonalityConfig> & Record<string, unknown>): PersonalityConfig {
  return { id: 'p', name: 'p', ...extra } as unknown as PersonalityConfig;
}

// `execution` is a typed union on PersonalityConfig, so an unrecognised value
// cannot be written in TypeScript — but it CAN arrive off disk from a
// hand-edited `config.yaml`, which is exactly what `readExecutionOverride`
// validates against. Built untyped on purpose.
const BOGUS_OVERRIDE = {
  id: 'p',
  name: 'p',
  toolset: ['terminal'],
  execution: 'bogus',
} as unknown as PersonalityConfig;

// Containerized detection input that finds NOTHING — the resolver's default
// would otherwise probe the real host (which may be a container in CI).
const NOT_CONTAINERIZED: ContainerizedDetectionInput = {
  env: {},
  fileExists: () => false,
  readFile: () => null,
};

describe('resolveExecutionPosture — backend selection', () => {
  it('selects docker for an exec-bearing toolset', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    expect(posture.backend).toBe('docker');
  });

  it('selects none for a chat-only personality', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['memory_read', 'web_search'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    expect(posture.backend).toBe('none');
  });

  it('selects none when toolset is absent (never silently local)', () => {
    const posture = resolveExecutionPosture({
      personality: p({}),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    expect(posture.backend).toBe('none');
  });

  it('honors an explicit execution override over tool inference', () => {
    expect(
      resolveExecutionPosture({
        personality: p({ toolset: ['terminal'], execution: 'local' }),
        containerized: NOT_CONTAINERIZED,
        sshConfigured: false,
      }).backend,
    ).toBe('local');
    // An `ssh` override is honored as intent, but with no target configured
    // (`sshConfigured: false`) and local permitted it resolves to honest
    // `local` (host) — see the P2 suite below for the full contract.
    expect(
      resolveExecutionPosture({
        personality: p({ toolset: ['terminal'], execution: 'ssh' }),
        containerized: NOT_CONTAINERIZED,
        sshConfigured: false,
      }).backend,
    ).toBe('local');
    expect(
      resolveExecutionPosture({
        personality: p({ toolset: ['terminal'], execution: 'none' }),
        containerized: NOT_CONTAINERIZED,
        sshConfigured: false,
      }).backend,
    ).toBe('none');
  });

  it('ignores an unrecognized override and falls back to inference', () => {
    expect(
      resolveExecutionPosture({
        personality: BOGUS_OVERRIDE,
        containerized: NOT_CONTAINERIZED,
        sshConfigured: false,
      }).backend,
    ).toBe('docker');
  });

  it('routes an exec personality to local when Ethos is containerized', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: { env: { ETHOS_EXECUTION_BACKEND: 'local' } },
      sshConfigured: false,
    });
    expect(posture.backend).toBe('local');
    expect(posture.containerized).toBe(true);
  });

  it('does NOT mark local-via-override as containerized', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'local' }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    expect(posture.backend).toBe('local');
    expect(posture.containerized).toBe(false);
  });
});

describe('resolveExecutionPosture — network + memory + scratch', () => {
  it('defaults network to none and memory to 256MB', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    expect(posture.networkMode).toBe('none');
    expect(posture.memoryMb).toBe(256);
  });

  it('resolves bridge when safety.network is set without an allowlist', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], safety: { network: {} } }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    expect(posture.networkMode).toBe('bridge');
  });

  it('includes /tmp scratch when docker mounts do not cover it', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      mounts: [{ hostPath: '/work', containerPath: '/work', mode: 'rw' }],
    });
    expect(posture.scratchPaths).toContain('/tmp');
  });

  it('omits scratch + mounts for a non-docker posture', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'local' }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      mounts: [{ hostPath: '/work', containerPath: '/work', mode: 'rw' }],
    });
    expect(posture.mounts).toEqual([]);
    expect(posture.scratchPaths).toEqual([]);
  });
});

describe('detectContainerized', () => {
  it('detects nothing on a bare host', () => {
    expect(detectContainerized(NOT_CONTAINERIZED)).toEqual({
      containerized: false,
      explicit: false,
    });
  });

  it('honors the ETHOS_EXECUTION_BACKEND=local env override (explicit)', () => {
    const d = detectContainerized({ env: { ETHOS_EXECUTION_BACKEND: 'local' } });
    expect(d).toEqual({
      containerized: true,
      signal: 'env:ETHOS_EXECUTION_BACKEND=local',
      explicit: true,
    });
  });

  it('honors execution.containerized: true config (explicit)', () => {
    const d = detectContainerized({ ...NOT_CONTAINERIZED, containerizedConfig: true });
    expect(d).toEqual({
      containerized: true,
      signal: 'config:execution.containerized',
      explicit: true,
    });
  });

  it('auto-detects /.dockerenv', () => {
    const d = detectContainerized({
      env: {},
      fileExists: (path) => path === '/.dockerenv',
      readFile: () => null,
    });
    expect(d).toEqual({ containerized: true, signal: 'detect:/.dockerenv', explicit: false });
  });

  it('auto-detects a docker match in /proc/1/cgroup', () => {
    const d = detectContainerized({
      env: {},
      fileExists: () => false,
      readFile: (path) => (path === '/proc/1/cgroup' ? '12:cpuset:/docker/abc123' : null),
    });
    expect(d).toEqual({ containerized: true, signal: 'detect:/proc/1/cgroup', explicit: false });
  });

  it('auto-detects KUBERNETES_SERVICE_HOST', () => {
    const d = detectContainerized({
      env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
      fileExists: () => false,
      readFile: () => null,
    });
    expect(d).toEqual({
      containerized: true,
      signal: 'detect:KUBERNETES_SERVICE_HOST',
      explicit: false,
    });
  });

  it('does not match an unrelated cgroup', () => {
    const d = detectContainerized({
      env: {},
      fileExists: () => false,
      readFile: () => '12:cpuset:/user.slice',
    });
    expect(d.containerized).toBe(false);
  });
});

describe('resolveExecutionPosture — A1 docker-absent decision', () => {
  it('produces a consent-allowed decision when the daemon is down (no silent fallback)', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerAvailable: false,
    });
    // Posture stays docker — no silent local fallback.
    expect(posture.backend).toBe('docker');
    expect(posture.dockerAbsent).toEqual({
      blocked: true,
      canInstall: true,
      canConsentLocal: true,
    });
  });

  it('withholds the consent option when the constitution forbids local (forbidLocal)', () => {
    const constitution: Constitution = { execution: { forbidLocal: true } };
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerAvailable: false,
      constitution,
    });
    expect(posture.dockerAbsent?.canConsentLocal).toBe(false);
    expect(posture.dockerAbsent?.consentForbiddenReason).toMatch(/forbids the local posture/);
  });

  it('withholds the consent option when requireSandbox is set', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerAvailable: false,
      constitution: { execution: { requireSandbox: true } },
    });
    expect(posture.dockerAbsent?.canConsentLocal).toBe(false);
  });

  it('produces no A1 state when the daemon is available', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerAvailable: true,
    });
    expect(posture.dockerAbsent).toBeUndefined();
  });

  it('produces no A1 state for a non-docker posture even when daemon is down', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'local' }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerAvailable: false,
    });
    expect(posture.dockerAbsent).toBeUndefined();
  });
});

describe('resolveExecutionPosture — F1 docker-unbuildable honest fallback', () => {
  it('resolves an honest local posture when docker is disabled in-process (constitution permits)', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerBuildable: false,
    });
    // Honest: backend reflects what actually runs (host), not Docker.
    expect(posture.backend).toBe('local');
    expect(posture.hostFallback).toEqual({ reason: 'docker-disabled' });
    // Not the containerized case — Ethos is not in a container here.
    expect(posture.containerized).toBe(false);
    expect(posture.dockerAbsent).toBeUndefined();
  });

  it('stays a docker hard-fail when docker is disabled but the constitution forbids local', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerBuildable: false,
      constitution: { execution: { forbidLocal: true } },
    });
    // Never silently runs host: posture stays docker with no consent escape.
    expect(posture.backend).toBe('docker');
    expect(posture.hostFallback).toBeUndefined();
    expect(posture.dockerAbsent).toEqual({
      blocked: true,
      canInstall: true,
      canConsentLocal: false,
      consentForbiddenReason: expect.stringMatching(/forbids the local posture/),
    });
  });

  it('keeps the docker posture (no fallback) when dockerBuildable is unset', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    expect(posture.backend).toBe('docker');
    expect(posture.hostFallback).toBeUndefined();
  });

  it('does not fall back a chat-only personality (no exec tool)', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['memory_read'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerBuildable: false,
    });
    expect(posture.backend).toBe('none');
    expect(posture.hostFallback).toBeUndefined();
  });
});

describe('resolveExecutionPosture — P1 run_tests / lint are exec-bearing', () => {
  // run_tests / lint route through makeCommandTool → arbitrary `command` bash.
  // A personality whose toolset lists ONLY these must NOT resolve to `none`
  // (which would wire no docker backend and silently run host bash).
  for (const tool of ['run_tests', 'lint'] as const) {
    it(`resolves docker (not none) for a [${tool}]-only toolset`, () => {
      const posture = resolveExecutionPosture({
        personality: p({ toolset: [tool] }),
        containerized: NOT_CONTAINERIZED,
        sshConfigured: false,
      });
      expect(posture.backend).toBe('docker');
    });
  }

  it('a [run_tests]-only personality under disableDocker+forbidLocal refuses (never host)', () => {
    // disableDocker is modeled as dockerBuildable:false; forbidLocal forbids the
    // host fallback. Resolver keeps backend `docker` with a hard-fail decision —
    // the compose path then sets hostExecForbidden=true so run_tests returns
    // not_available rather than silently running host bash.
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['run_tests'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      dockerBuildable: false,
      constitution: { execution: { forbidLocal: true } },
    });
    expect(posture.backend).toBe('docker');
    expect(posture.hostFallback).toBeUndefined();
    expect(posture.dockerAbsent?.canConsentLocal).toBe(false);
  });
});

describe('resolveExecutionPosture — P2 ssh posture with NO target configured', () => {
  // No `execution.ssh.host`: there is nothing to connect to, so a
  // `backend: 'ssh'` posture left untouched would silently fall to host while
  // the sheet claimed "ssh (remote host)".
  it('resolves an honest local posture when local is permitted (runs host, not silent ssh)', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'ssh' }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
    });
    // Honest: backend reflects what actually runs (host), not ssh.
    expect(posture.backend).toBe('local');
    expect(posture.hostFallback).toEqual({ reason: 'ssh-unavailable' });
    expect(posture.containerized).toBe(false);
  });

  it('stays ssh (so exec tools refuse) when the constitution forbids local', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'ssh' }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      constitution: { execution: { forbidLocal: true } },
    });
    // Never silently host: posture stays ssh; the compose path forbids host exec
    // for an ssh posture with no backend, so exec tools become not_available.
    expect(posture.backend).toBe('ssh');
    expect(posture.hostFallback).toBeUndefined();
    // ...and it says WHY, distinguishably from a configured-but-refused target.
    expect(posture.sshRefused).toEqual({
      reason: 'unconfigured',
      message: expect.stringContaining('no execution.ssh.host is configured'),
    });
  });
});

describe('resolveExecutionPosture — ssh target CONFIGURED', () => {
  const ssh = (extra: Record<string, unknown> = {}) => ({
    personality: p({ toolset: ['terminal'], execution: 'ssh' }),
    containerized: NOT_CONTAINERIZED,
    sshConfigured: true,
    ...extra,
  });

  // THE regression this suite exists for. With a target configured the posture
  // must STAY `ssh`: flipping it to `local` here is a silent host execution
  // under a sheet that names a remote machine.
  it('keeps backend ssh and records no host fallback', () => {
    const posture = resolveExecutionPosture(ssh());
    expect(posture.backend).toBe('ssh');
    expect(posture.hostFallback).toBeUndefined();
    expect(posture.sshRefused).toBeUndefined();
  });

  it('never reports the ssh-unavailable host fallback once a target exists', () => {
    // The `ssh-unavailable` reason means "no backend to reach" — it must not
    // survive into a deployment that HAS one, on any permitting constitution.
    for (const constitution of [
      undefined,
      {},
      { execution: {} },
      { execution: { requireSandbox: false } },
    ] as (Constitution | undefined)[]) {
      const posture = resolveExecutionPosture(
        ssh(constitution === undefined ? {} : { constitution }),
      );
      expect(posture.hostFallback?.reason).not.toBe('ssh-unavailable');
      expect(posture.backend).toBe('ssh');
    }
  });

  it('surfaces the configured target for display, and only on an ssh posture', () => {
    expect(resolveExecutionPosture(ssh({ sshTarget: 'deploy@build-01:22' })).sshTarget).toBe(
      'deploy@build-01:22',
    );
    // A posture that resolved AWAY from ssh must not still advertise a target.
    const fellBack = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'], execution: 'ssh' }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: false,
      sshTarget: 'deploy@build-01:22',
    });
    expect(fellBack.backend).toBe('local');
    expect(fellBack.sshTarget).toBeUndefined();
  });

  // D7 — ssh is remote-host TRUST, not mount-confinement, so a constitution
  // demanding a sandbox refuses it even with a reachable target. Enforcement is
  // the compose path's (no ssh backend is built under a forbidding
  // constitution, so `hostExecForbidden` fires); the resolver's job is to say
  // so honestly, and distinguishably from "no target configured".
  for (const key of ['requireSandbox', 'forbidLocal'] as const) {
    it(`refuses with a sandbox-specific reason under constitution ${key}`, () => {
      const posture = resolveExecutionPosture(
        ssh({ constitution: { execution: { [key]: true } } as Constitution }),
      );
      expect(posture.backend).toBe('ssh');
      // NOT `local` — the refusal must never become a silent host fallback.
      expect(posture.hostFallback).toBeUndefined();
      expect(posture.sshRefused?.reason).toBe('constitution-requires-sandbox');
      expect(posture.sshRefused?.message).toContain('requires a sandbox');
      expect(posture.sshRefused?.message).toContain('remote-host trust');
    });
  }

  it('keeps the refused posture pointing at its target so the sheet can name it', () => {
    const posture = resolveExecutionPosture(
      ssh({
        constitution: { execution: { requireSandbox: true } },
        sshTarget: 'deploy@build-01:22',
      }),
    );
    expect(posture.sshTarget).toBe('deploy@build-01:22');
    expect(posture.sshRefused?.reason).toBe('constitution-requires-sandbox');
  });

  it('leaves a non-ssh posture untouched by the ssh inputs', () => {
    const posture = resolveExecutionPosture({
      personality: p({ toolset: ['terminal'] }),
      containerized: NOT_CONTAINERIZED,
      sshConfigured: true,
      sshTarget: 'deploy@build-01:22',
      constitution: { execution: { requireSandbox: true } },
    });
    expect(posture.backend).toBe('docker');
    expect(posture.sshRefused).toBeUndefined();
    expect(posture.sshTarget).toBeUndefined();
  });
});

describe('formatSshTarget', () => {
  it('renders only what the operator actually configured', () => {
    expect(formatSshTarget({ host: 'build-01' })).toBe('build-01');
    expect(formatSshTarget({ host: 'build-01', user: 'deploy' })).toBe('deploy@build-01');
    expect(formatSshTarget({ host: 'build-01', port: 2222 })).toBe('build-01:2222');
    expect(formatSshTarget({ host: 'build-01', user: 'deploy', port: 22 })).toBe(
      'deploy@build-01:22',
    );
  });
});

describe('constitutionForbidsLocal', () => {
  it('is false for an empty constitution', () => {
    expect(constitutionForbidsLocal(undefined)).toBe(false);
    expect(constitutionForbidsLocal({})).toBe(false);
  });
  it('is true when forbidLocal or requireSandbox is set', () => {
    expect(constitutionForbidsLocal({ execution: { forbidLocal: true } })).toBe(true);
    expect(constitutionForbidsLocal({ execution: { requireSandbox: true } })).toBe(true);
  });
});
