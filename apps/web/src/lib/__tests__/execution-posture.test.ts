import type { ExecutionPostureWire } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERRIDE,
  edgeState,
  isExecTool,
  isHostOverrideDisabled,
  overrideOptions,
  postureBadge,
  postureColorVar,
  postureWhy,
  toolAffordance,
} from '../execution-posture';

// Phase 2a, lane E2 — the web Execution UI. These cover the pure derivations
// the React tab consumes; the posture itself is produced by the RPC, never
// recomputed here.

function posture(overrides: Partial<ExecutionPostureWire> = {}): ExecutionPostureWire {
  return {
    backend: 'docker',
    networkMode: 'none',
    memoryMb: 256,
    containerized: false,
    mounts: [],
    scratchPaths: ['/tmp'],
    ...overrides,
  };
}

describe('postureBadge', () => {
  it('labels docker posture as Sandboxed · Docker (success)', () => {
    const badge = postureBadge(posture({ backend: 'docker' }));
    expect(badge.label).toBe('Sandboxed · Docker');
    expect(badge.icon).toBe('▣');
    expect(badge.variant).toBe('success');
  });

  it('labels containerized posture as Sandboxed · container (success)', () => {
    const badge = postureBadge(posture({ backend: 'local', containerized: true }));
    expect(badge.label).toBe('Sandboxed · container');
    expect(badge.variant).toBe('success');
  });

  it('labels host (local) posture as Un-sandboxed · runs on host (warning)', () => {
    const badge = postureBadge(posture({ backend: 'local', containerized: false }));
    expect(badge.label).toBe('Un-sandboxed · runs on host');
    expect(badge.icon).toBe('△');
    expect(badge.variant).toBe('warning');
  });

  it('labels none posture as No execution (neutral)', () => {
    const badge = postureBadge(posture({ backend: 'none' }));
    expect(badge.label).toBe('No execution');
    expect(badge.icon).toBe('○');
    expect(badge.variant).toBe('neutral');
  });

  it('labels docker-absent as Docker required — not running (error), overriding the backend', () => {
    const badge = postureBadge(
      posture({
        backend: 'docker',
        dockerAbsent: { blocked: true, canInstall: true, canConsentLocal: true },
      }),
    );
    expect(badge.label).toBe('Docker required — not running');
    expect(badge.icon).toBe('▲');
    expect(badge.variant).toBe('error');
  });
});

describe('postureColorVar', () => {
  it('maps each variant to a semantic CSS token', () => {
    expect(postureColorVar('success')).toBe('var(--success)');
    expect(postureColorVar('warning')).toBe('var(--warning)');
    expect(postureColorVar('error')).toBe('var(--error)');
    expect(postureColorVar('neutral')).toBe('var(--text-secondary)');
  });
});

describe('postureWhy', () => {
  it('explains each posture in one line', () => {
    expect(postureWhy(posture({ backend: 'docker' }))).toContain('isolated container');
    expect(postureWhy(posture({ backend: 'none' }))).toContain('no execution tools');
    expect(postureWhy(posture({ containerized: true, backend: 'local' }))).toContain(
      'container is the boundary',
    );
  });

  it('names the ssh target the resolver formatted, adding no port of its own', () => {
    expect(postureWhy(posture({ backend: 'ssh', sshTarget: 'deploy@build-01:22' }))).toContain(
      'deploy@build-01:22',
    );
    // A host with no explicit port stays portless all the way to the screen.
    expect(postureWhy(posture({ backend: 'ssh', sshTarget: 'build-01' }))).not.toContain(':22');
  });

  it("prefers the resolver's refusal wording over a second explanation of it", () => {
    const message = 'ssh refused: constitution requires a sandbox';
    const why = postureWhy(
      posture({
        backend: 'ssh',
        sshTarget: 'deploy@build-01:22',
        sshRefused: { reason: 'constitution-requires-sandbox', message },
      }),
    );
    expect(why).toBe(message);
    // And it must not still claim the tools run there.
    expect(why).not.toContain('Execution tools run on');
  });

  it('does not blame a declared `execution: none` on an absent toolset', () => {
    // `requirement === 'none'` short-circuits BEFORE the `hasExecTool` test in
    // `resolveExecutionPosture`, so a personality whose toolset names `terminal`
    // still resolves to `backend: 'none'`. Asserting "no execution tools" there
    // states something false about the toolset.
    const declared = postureWhy(posture({ backend: 'none', requirement: 'none' }));
    expect(declared).toContain('execution: none');
    expect(declared).not.toContain('no execution tools');
    // The undeclared case keeps the wording it had.
    expect(postureWhy(posture({ backend: 'none' }))).toContain('no execution tools');
  });
});

describe('override control', () => {
  it('defaults to Auto', () => {
    expect(DEFAULT_OVERRIDE).toBe('auto');
  });

  it('offers Auto/Docker/Host/Remote', () => {
    const opts = overrideOptions(posture());
    expect(opts.map((o) => o.value)).toEqual(['auto', 'docker', 'host', 'remote']);
  });

  it('enables Host when local is permitted', () => {
    const opts = overrideOptions(posture());
    const host = opts.find((o) => o.value === 'host');
    expect(host?.disabledReason).toBeUndefined();
    expect(isHostOverrideDisabled(posture())).toBe(false);
  });

  it('disables Host with a reason when the constitution forbids local', () => {
    const p = posture({
      dockerAbsent: {
        blocked: true,
        canInstall: true,
        canConsentLocal: false,
        consentForbiddenReason: 'multi-tenant constitution forbids local',
      },
    });
    const host = overrideOptions(p).find((o) => o.value === 'host');
    expect(host?.disabledReason).toBe('multi-tenant constitution forbids local');
    expect(isHostOverrideDisabled(p)).toBe(true);
  });
});

describe('toolAffordance', () => {
  it('marks exec tools (terminal/process/code) as runs sandboxed → Execution', () => {
    for (const t of [
      'terminal',
      'run_code',
      'run_tests',
      'lint',
      'process_start',
      'process_stop',
    ]) {
      expect(isExecTool(t)).toBe(true);
      const a = toolAffordance(t);
      expect(a.kind).toBe('exec');
      if (a.kind === 'exec') {
        expect(a.label).toBe('runs sandboxed');
        expect(a.link).toBe('Execution');
      }
    }
  });

  it('marks host-side tools (read_file/write_file/memory) as app-confined', () => {
    for (const t of ['read_file', 'write_file', 'memory_read', 'memory_write', 'session_search']) {
      expect(isExecTool(t)).toBe(false);
      const a = toolAffordance(t);
      expect(a.kind).toBe('host');
      if (a.kind === 'host') {
        expect(a.label).toBe('host-side (app-confined)');
      }
    }
  });
});

describe('edgeState', () => {
  it('selects docker-absent with consent allowed', () => {
    const e = edgeState(
      posture({ dockerAbsent: { blocked: true, canInstall: true, canConsentLocal: true } }),
    );
    expect(e.kind).toBe('docker-absent');
    if (e.kind === 'docker-absent') expect(e.canConsentLocal).toBe(true);
  });

  it('selects docker-absent with consent withheld and a reason', () => {
    const e = edgeState(
      posture({
        dockerAbsent: {
          blocked: true,
          canInstall: true,
          canConsentLocal: false,
          consentForbiddenReason: 'forbidden by constitution',
        },
      }),
    );
    expect(e.kind).toBe('docker-absent');
    if (e.kind === 'docker-absent') {
      expect(e.canConsentLocal).toBe(false);
      expect(e.consentForbiddenReason).toBe('forbidden by constitution');
    }
  });

  it('selects containerized for the in-container posture', () => {
    expect(edgeState(posture({ containerized: true, backend: 'local' })).kind).toBe(
      'containerized',
    );
  });

  it('selects none for an ordinary docker posture', () => {
    expect(edgeState(posture({ backend: 'docker' })).kind).toBe('none');
  });
});
