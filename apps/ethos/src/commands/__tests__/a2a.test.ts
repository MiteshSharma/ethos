// `ethos a2a` command core (plan §5). Exercises the handlers over a stub
// A2aPeeringPort + an in-memory config seam, so no real personalities/secrets or
// A2A stores are needed. Assertions are on the service calls + config writes, not
// exact console strings (those are cosmetic).

import type { EthosConfig } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { A2aIdentityView, A2aPeerRow } from '@ethosagent/wiring';
import { A2aPeeringError } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type A2aCommandDeps, type A2aPeeringPort, resetDirContents, runA2aCommand } from '../a2a';

function baseConfig(overrides: Partial<EthosConfig> = {}): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-3',
    apiKey: 'sk-test',
    personality: 'swing-trader',
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<A2aIdentityView> = {}): A2aIdentityView {
  return {
    personalityId: 'swing-trader',
    name: 'Swing Trader',
    fingerprint: '441ac7fe5ce567bfdbe3ca8c6baad206',
    wellKnownUrl: 'http://localhost:3000/.well-known/agent-card.json?personality=swing-trader',
    jsonRpcUrl: 'http://localhost:3000/a2a/swing-trader',
    authUrl: 'http://localhost:3000/a2a-auth/swing-trader',
    did: 'did:key:z6MkExample',
    exposedSkills: ['market-brief'],
    ...overrides,
  };
}

function makePort(overrides: Partial<A2aPeeringPort> = {}): A2aPeeringPort {
  return {
    identity: vi.fn(async () => makeIdentity()),
    previewPeer: vi.fn(async () => ({
      // biome-ignore lint/suspicious/noExplicitAny: minimal card stub for tests
      card: { name: 'EM' } as any,
      fingerprint: 'c4d022bcabcd',
    })),
    addPeer: vi.fn(
      async (_pid: string, args: { url: string; expectedFingerprint?: string; label?: string }) =>
        ({
          fingerprint: args.expectedFingerprint ?? 'c4d022bcabcd',
          access: 'full',
          enabled: false,
          ...(args.label !== undefined ? { label: args.label } : {}),
          url: args.url,
        }) satisfies A2aPeerRow,
    ),
    listPeers: vi.fn(async () => []),
    setEnabled: vi.fn(async () => {}),
    removePeer: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<A2aCommandDeps> & { config?: EthosConfig } = {}): {
  deps: A2aCommandDeps;
  saved: EthosConfig[];
  port: A2aPeeringPort;
} {
  const saved: EthosConfig[] = [];
  const config = overrides.config ?? baseConfig();
  const port = overrides.peering ?? makePort();
  const deps: A2aCommandDeps = {
    peering: port,
    loadConfig: overrides.loadConfig ?? (async () => config),
    saveConfig:
      overrides.saveConfig ??
      (async (c) => {
        saved.push(c);
      }),
    confirm: overrides.confirm ?? (async () => true),
    resetA2aDir: overrides.resetA2aDir ?? (async () => []),
    now: overrides.now ?? (() => 1_000_000),
  };
  return { deps, saved, port };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = undefined;
});

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
}

describe('ethos a2a identity', () => {
  it('prints the identity view for the active personality', async () => {
    const { deps, port } = makeDeps();
    await runA2aCommand(['identity'], deps);
    expect(port.identity).toHaveBeenCalledWith('swing-trader');
    expect(output(logSpy)).toContain('441ac7fe5ce567bfdbe3ca8c6baad206');
    expect(output(logSpy)).toContain('market-brief');
  });

  it('honours --personality', async () => {
    const { deps, port } = makeDeps();
    await runA2aCommand(['identity', '--personality', 'em'], deps);
    expect(port.identity).toHaveBeenCalledWith('em');
  });

  it('maps unknown_personality to a clean error + non-zero exit', async () => {
    const port = makePort({
      identity: vi.fn(async () => {
        throw new A2aPeeringError('unknown_personality', 'no such personality');
      }),
    });
    const { deps } = makeDeps({ peering: port });
    await runA2aCommand(['identity', '--personality', 'ghost'], deps);
    expect(process.exitCode).toBe(1);
    expect(output(errSpy)).toContain('unknown personality');
  });
});

describe('ethos a2a peer add', () => {
  it('without --fingerprint previews and does NOT write', async () => {
    const { deps, port } = makeDeps();
    await runA2aCommand(['peer', 'add', '--url', 'http://peer/card'], deps);
    expect(port.previewPeer).toHaveBeenCalledWith('http://peer/card');
    expect(port.addPeer).not.toHaveBeenCalled();
    expect(output(logSpy)).toContain('c4d022bcabcd');
  });

  it('with a matching fingerprint writes a disabled peer', async () => {
    const { deps, port } = makeDeps();
    await runA2aCommand(
      [
        'peer',
        'add',
        '--url',
        'http://peer/card',
        '--fingerprint',
        'c4d022bcabcd',
        '--label',
        'My EM',
      ],
      deps,
    );
    expect(port.addPeer).toHaveBeenCalledWith('swing-trader', {
      url: 'http://peer/card',
      expectedFingerprint: 'c4d022bcabcd',
      label: 'My EM',
    });
    expect(output(logSpy)).toContain('disabled');
  });

  it('reports fingerprint_mismatch with a non-zero exit and no partial write', async () => {
    const port = makePort({
      addPeer: vi.fn(async () => {
        throw new A2aPeeringError(
          'fingerprint_mismatch',
          'Card fingerprint AAA does not match BBB.',
        );
      }),
    });
    const { deps } = makeDeps({ peering: port });
    await runA2aCommand(['peer', 'add', '--url', 'http://peer/card', '--fingerprint', 'BBB'], deps);
    expect(process.exitCode).toBe(1);
    expect(output(errSpy)).toContain('mismatch');
  });

  it('errors when --url is missing', async () => {
    const { deps, port } = makeDeps();
    await runA2aCommand(['peer', 'add', '--fingerprint', 'x'], deps);
    expect(process.exitCode).toBe(1);
    expect(port.addPeer).not.toHaveBeenCalled();
  });
});

describe('ethos a2a peer list', () => {
  it('renders rows with relative + never last-seen, and empty notice', async () => {
    const rows: A2aPeerRow[] = [
      {
        fingerprint: 'c4d022bcabcd1234',
        label: 'EM',
        url: 'http://peer/card',
        access: 'full',
        enabled: true,
        lastSeenAt: 1_000_000 - 120_000, // 2 minutes before the injected clock
      },
      { fingerprint: 'nopeer', access: 'full', enabled: false },
    ];
    const port = makePort({ listPeers: vi.fn(async () => rows) });
    const { deps } = makeDeps({ peering: port });
    await runA2aCommand(['peer', 'list'], deps);
    const out = output(logSpy);
    expect(out).toContain('EM');
    expect(out).toContain('2m ago');
    expect(out).toContain('never');
  });

  it('prints an empty notice when there are no peers', async () => {
    const { deps } = makeDeps();
    await runA2aCommand(['peer', 'list'], deps);
    expect(output(logSpy)).toContain('no peers configured');
  });
});

describe('ethos a2a peer enable/disable/remove', () => {
  it('enable calls setEnabled(true)', async () => {
    const { deps, port } = makeDeps();
    await runA2aCommand(['peer', 'enable', 'fp123'], deps);
    expect(port.setEnabled).toHaveBeenCalledWith('swing-trader', 'fp123', true);
  });

  it('disable calls setEnabled(false)', async () => {
    const { deps, port } = makeDeps();
    await runA2aCommand(['peer', 'disable', 'fp123', '--personality', 'em'], deps);
    expect(port.setEnabled).toHaveBeenCalledWith('em', 'fp123', false);
  });

  it('remove with --yes skips the prompt and removes', async () => {
    const confirmFn = vi.fn(async () => true);
    const { deps, port } = makeDeps({ confirm: confirmFn });
    await runA2aCommand(['peer', 'remove', 'fp123', '--yes'], deps);
    expect(confirmFn).not.toHaveBeenCalled();
    expect(port.removePeer).toHaveBeenCalledWith('swing-trader', 'fp123');
  });

  it('remove aborts when the user declines', async () => {
    const { deps, port } = makeDeps({ confirm: async () => false });
    await runA2aCommand(['peer', 'remove', 'fp123'], deps);
    expect(port.removePeer).not.toHaveBeenCalled();
  });
});

describe('ethos a2a reset', () => {
  it('without --yes asks for confirmation, and does not reset when declined', async () => {
    const confirmFn = vi.fn(async () => false);
    const resetFn = vi.fn(async () => ['tasks.db', 'peers']);
    const { deps } = makeDeps({ confirm: confirmFn, resetA2aDir: resetFn });
    await runA2aCommand(['reset'], deps);
    expect(confirmFn).toHaveBeenCalled();
    expect(resetFn).not.toHaveBeenCalled();
    expect(output(logSpy)).toContain('aborted');
  });

  it('with --yes skips the prompt and resets', async () => {
    const confirmFn = vi.fn(async () => true);
    const resetFn = vi.fn(async () => ['tasks.db', 'peers', 'allowlist']);
    const { deps } = makeDeps({ confirm: confirmFn, resetA2aDir: resetFn });
    await runA2aCommand(['reset', '--yes'], deps);
    expect(confirmFn).not.toHaveBeenCalled();
    expect(resetFn).toHaveBeenCalled();
    expect(output(logSpy)).toContain('tasks.db');
  });

  it('confirmed and accepted still resets (interactive yes)', async () => {
    const resetFn = vi.fn(async () => ['tasks.db']);
    const { deps } = makeDeps({ confirm: async () => true, resetA2aDir: resetFn });
    await runA2aCommand(['reset'], deps);
    expect(resetFn).toHaveBeenCalled();
  });

  it('reports when there is nothing to reset', async () => {
    const { deps } = makeDeps({ resetA2aDir: async () => [] });
    await runA2aCommand(['reset', '--yes'], deps);
    expect(output(logSpy)).toContain('nothing to reset');
  });
});

describe('ethos a2a enable/disable/status', () => {
  it('enable writes a2a.enabled: true and warns when webBaseUrl is unset', async () => {
    const { deps, saved } = makeDeps({ config: baseConfig({ webBaseUrl: undefined }) });
    await runA2aCommand(['enable'], deps);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.a2a).toEqual({ enabled: true });
    expect(output(logSpy)).toContain('webBaseUrl');
  });

  it('enable does not warn when webBaseUrl is set', async () => {
    const { deps, saved } = makeDeps({
      config: baseConfig({ webBaseUrl: 'https://agent.example' }),
    });
    await runA2aCommand(['enable'], deps);
    expect(saved[0]?.a2a).toEqual({ enabled: true });
    expect(output(logSpy)).not.toContain('default port');
  });

  it('disable writes a2a.enabled: false', async () => {
    const { deps, saved } = makeDeps();
    await runA2aCommand(['disable'], deps);
    expect(saved[0]?.a2a).toEqual({ enabled: false });
  });

  it('status reports the peer count for the active personality', async () => {
    const rows: A2aPeerRow[] = [
      { fingerprint: 'a', access: 'full', enabled: true },
      { fingerprint: 'b', access: 'full', enabled: false },
    ];
    const port = makePort({ listPeers: vi.fn(async () => rows) });
    const { deps } = makeDeps({ peering: port, config: baseConfig({ a2a: { enabled: true } }) });
    await runA2aCommand(['status'], deps);
    expect(port.listPeers).toHaveBeenCalledWith('swing-trader');
    expect(output(logSpy)).toContain('2 configured');
  });

  it('status warns when the active personality exposes zero skills (T0.1)', async () => {
    const port = makePort({ identity: vi.fn(async () => makeIdentity({ exposedSkills: [] })) });
    const { deps } = makeDeps({ peering: port, config: baseConfig({ a2a: { enabled: true } }) });
    await runA2aCommand(['status'], deps);
    const out = output(logSpy);
    expect(out).toContain('FORBIDDEN_SCOPE');
    expect(out).toContain('exposeToAgents');
    expect(out).toContain('swing-trader');
  });

  it('status stays silent when the active personality exposes at least one skill', async () => {
    const port = makePort({
      identity: vi.fn(async () => makeIdentity({ exposedSkills: ['market-brief'] })),
    });
    const { deps } = makeDeps({ peering: port, config: baseConfig({ a2a: { enabled: true } }) });
    await runA2aCommand(['status'], deps);
    expect(output(logSpy)).not.toContain('FORBIDDEN_SCOPE');
  });

  it('status does not check exposed skills when A2A is disabled', async () => {
    const port = makePort({ identity: vi.fn(async () => makeIdentity({ exposedSkills: [] })) });
    const { deps } = makeDeps({ peering: port, config: baseConfig({ a2a: { enabled: false } }) });
    await runA2aCommand(['status'], deps);
    expect(port.identity).not.toHaveBeenCalled();
  });
});

// `resetDirContents` is the real filesystem-clearing behaviour behind `ethos
// a2a reset` (the command-level tests above stub the whole seam). Exercised
// against a fixture `InMemoryStorage`, never the real ~/.ethos/.
describe('resetDirContents', () => {
  it('removes every top-level entry under the directory and returns their names', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/a2a');
    await storage.write('/a2a/tasks.db', 'binary-ish');
    await storage.mkdir('/a2a/peers');
    await storage.write('/a2a/peers/fp1.json', '{}');
    await storage.mkdir('/a2a/allowlist');
    await storage.write('/a2a/allowlist/fp1.json', '{}');

    const removed = await resetDirContents(storage, '/a2a');

    expect(removed.sort()).toEqual(['allowlist', 'peers', 'tasks.db']);
    expect(await storage.list('/a2a')).toEqual([]);
    expect(await storage.exists('/a2a/tasks.db')).toBe(false);
    expect(await storage.exists('/a2a/peers/fp1.json')).toBe(false);
    // The directory itself survives — only its CONTENTS are cleared.
    expect(await storage.exists('/a2a')).toBe(true);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const storage = new InMemoryStorage();
    const removed = await resetDirContents(storage, '/a2a');
    expect(removed).toEqual([]);
  });
});
