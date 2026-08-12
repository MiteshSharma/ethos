// Plugin capability grants — the consent record, and what it does at load time.
//
// A grant is not containment. These tests pin the two things it IS: a durable,
// inspectable record of what the operator was shown, and a revocation the
// loader refuses on before it imports anything.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import type { ScanFinding } from '@ethosagent/safety-scanner';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { ContextInjector, Logger } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  derivePluginId,
  grantsPath,
  isGrantRevoked,
  type PluginGrant,
  readGrants,
  recordGrant,
  revokeGrant,
} from '../grants';
import { PluginLoader } from '../index';

const PLUGINS_DIR = '/data/plugins';

const findings: ScanFinding[] = [
  {
    severity: 'yellow',
    rule: 'dynamic-code',
    message: 'Uses new Function()',
    line: 12,
    excerpt: 'const f = new Function(src)',
  },
];

function makeGrant(overrides: Partial<PluginGrant> = {}): PluginGrant {
  return {
    id: 'tools-zerodha',
    package: '@ethos-plugins/tools-zerodha',
    version: '1.4.2',
    source: 'npm:@ethos-plugins/tools-zerodha@1.4.2',
    capabilities: { shell: true, network: ['api.kite.trade'] },
    scan: { tier: 'community', findings, hasRed: false, hasYellow: true },
    grantedAt: '2026-08-12T10:00:00.000Z',
    consent: 'interactive',
    ...overrides,
  };
}

describe('plugin grants store', () => {
  it('returns no grants when nothing has been recorded', async () => {
    const storage = new InMemoryStorage();
    expect(await readGrants(storage, PLUGINS_DIR)).toEqual({});
  });

  it('records a grant that reads back verbatim', async () => {
    const storage = new InMemoryStorage();
    const grant = makeGrant();
    await recordGrant(storage, PLUGINS_DIR, grant);

    const grants = await readGrants(storage, PLUGINS_DIR);
    expect(grants['tools-zerodha']).toEqual(grant);
  });

  it('preserves the scan snapshot exactly as it was at install', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, makeGrant());

    const grants = await readGrants(storage, PLUGINS_DIR);
    const scan = grants['tools-zerodha']?.scan;
    // Findings survive field-for-field — a reviewer sees what the operator saw,
    // not a re-scan of code that may have changed since.
    expect(scan?.findings).toEqual(findings);
    expect(scan?.findings[0]?.excerpt).toBe('const f = new Function(src)');
    expect(scan?.findings[0]?.line).toBe(12);
    expect(scan?.tier).toBe('community');
    expect(scan?.hasYellow).toBe(true);
    expect(scan?.hasRed).toBe(false);
  });

  it('records the declared capabilities the operator was shown', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, makeGrant());
    const grants = await readGrants(storage, PLUGINS_DIR);
    expect(grants['tools-zerodha']?.capabilities).toEqual({
      shell: true,
      network: ['api.kite.trade'],
    });
  });

  it('distinguishes an undeclared network from one declared with no host limit', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(
      storage,
      PLUGINS_DIR,
      makeGrant({ id: 'a', capabilities: { shell: false, network: null } }),
    );
    await recordGrant(
      storage,
      PLUGINS_DIR,
      makeGrant({ id: 'b', capabilities: { shell: false, network: [] } }),
    );
    const grants = await readGrants(storage, PLUGINS_DIR);
    expect(grants.a?.capabilities.network).toBeNull();
    expect(grants.b?.capabilities.network).toEqual([]);
  });

  it('records the consent mode, so an unattended --yes grant is visible later', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, makeGrant({ consent: 'flag' }));
    const grants = await readGrants(storage, PLUGINS_DIR);
    expect(grants['tools-zerodha']?.consent).toBe('flag');
  });

  it('writes the grant file under the plugins dir', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, makeGrant());
    expect(grantsPath(PLUGINS_DIR)).toBe('/data/plugins/grants.json');
    expect(await storage.read('/data/plugins/grants.json')).not.toBeNull();
  });

  it('revokes a grant without deleting the record', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, makeGrant());

    expect(
      await revokeGrant(storage, PLUGINS_DIR, 'tools-zerodha', '2026-08-13T00:00:00.000Z'),
    ).toBe(true);

    const grants = await readGrants(storage, PLUGINS_DIR);
    expect(grants['tools-zerodha']?.revokedAt).toBe('2026-08-13T00:00:00.000Z');
    // The record — including the scan snapshot — stays inspectable after revocation.
    expect(grants['tools-zerodha']?.scan.findings).toEqual(findings);
    expect(isGrantRevoked(grants, 'tools-zerodha')).toBe(true);
  });

  it('returns false when there is nothing to revoke', async () => {
    const storage = new InMemoryStorage();
    expect(await revokeGrant(storage, PLUGINS_DIR, 'missing')).toBe(false);
    await recordGrant(storage, PLUGINS_DIR, makeGrant());
    await revokeGrant(storage, PLUGINS_DIR, 'tools-zerodha');
    expect(await revokeGrant(storage, PLUGINS_DIR, 'tools-zerodha')).toBe(false);
  });

  it('a re-install supersedes an earlier revocation', async () => {
    const storage = new InMemoryStorage();
    await recordGrant(storage, PLUGINS_DIR, makeGrant());
    await revokeGrant(storage, PLUGINS_DIR, 'tools-zerodha');
    await recordGrant(storage, PLUGINS_DIR, makeGrant({ version: '1.5.0' }));

    const grants = await readGrants(storage, PLUGINS_DIR);
    expect(grants['tools-zerodha']?.revokedAt).toBeUndefined();
    expect(isGrantRevoked(grants, 'tools-zerodha')).toBe(false);
  });

  it('throws on a malformed grant file rather than silently un-revoking everything', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(PLUGINS_DIR);
    await storage.write(grantsPath(PLUGINS_DIR), '{ not json');
    await expect(readGrants(storage, PLUGINS_DIR)).rejects.toThrow();
  });
});

describe('derivePluginId', () => {
  it('prefers the declared ethos.id', () => {
    expect(derivePluginId({ name: '@ethos-plugins/tools-zerodha', ethos: { id: 'zerodha' } })).toBe(
      'zerodha',
    );
  });

  it('strips the scope when no id is declared', () => {
    expect(derivePluginId({ name: '@ethos-plugins/tools-zerodha' })).toBe('tools-zerodha');
  });

  it('falls back to the supplied name', () => {
    expect(derivePluginId(undefined, '@scope/ethos-plugin-foo')).toBe('ethos-plugin-foo');
  });
});

// ---------------------------------------------------------------------------
// Load-time refusal
// ---------------------------------------------------------------------------

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

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `ethos-grants-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(testDir, 'plugins'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeDemoPlugin(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.ts'),
    `
export async function activate(api) {
  api.registerTool({
    name: 'granted_tool',
    description: 'Test tool',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: 'ran' }; },
  });
}
    `.trim(),
  );
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'demo-plugin',
      version: '1.0.0',
      ethos: { type: 'plugin', pluginContractMajor: 4, skills_dir: 'skills' },
    }),
  );
  await mkdir(join(dir, 'skills'), { recursive: true });
}

describe('PluginLoader honours a revoked grant', () => {
  it('loads a plugin whose grant has not been revoked', async () => {
    const storage = new FsStorage();
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage, dataDir: testDir });

    const pluginDir = join(testDir, 'plugins', 'demo-plugin');
    await writeDemoPlugin(pluginDir);
    await recordGrant(storage, join(testDir, 'plugins'), makeGrant({ id: 'demo-plugin' }));

    await loader.loadFromPluginDir(pluginDir, 'demo-plugin');

    expect(loader.isLoaded('demo-plugin')).toBe(true);
    expect(registries.tools.get('granted_tool')).toBeDefined();
  });

  it('refuses to import a plugin whose grant was revoked', async () => {
    const storage = new FsStorage();
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage, dataDir: testDir });

    const pluginDir = join(testDir, 'plugins', 'demo-plugin');
    await writeDemoPlugin(pluginDir);
    await recordGrant(storage, join(testDir, 'plugins'), makeGrant({ id: 'demo-plugin' }));
    await revokeGrant(storage, join(testDir, 'plugins'), 'demo-plugin');

    await loader.loadFromPluginDir(pluginDir, 'demo-plugin');

    expect(loader.isLoaded('demo-plugin')).toBe(false);
    expect(registries.tools.get('granted_tool')).toBeUndefined();
    const failure = loader.getFailures().find((m) => m.id === 'demo-plugin');
    expect(failure?.error).toContain('revoked capability grant');
  });

  it('a revoked plugin contributes no skills either', async () => {
    const storage = new FsStorage();
    const loader = new PluginLoader(makeRegistries(), { storage, dataDir: testDir });

    const pluginDir = join(testDir, 'plugins', 'demo-plugin');
    await writeDemoPlugin(pluginDir);
    await recordGrant(storage, join(testDir, 'plugins'), makeGrant({ id: 'demo-plugin' }));
    await revokeGrant(storage, join(testDir, 'plugins'), 'demo-plugin');

    await loader.loadFromPluginDir(pluginDir, 'demo-plugin');

    expect(loader.getPluginSkillSources()).toEqual([]);
  });

  it('matches a revocation recorded against the declared ethos.id', async () => {
    const storage = new FsStorage();
    const loader = new PluginLoader(makeRegistries(), { storage, dataDir: testDir });

    const pluginDir = join(testDir, 'plugins', 'dir-name');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'index.ts'), 'export async function activate() {}');
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        ethos: { type: 'plugin', id: 'declared-id', pluginContractMajor: 4 },
      }),
    );
    await recordGrant(storage, join(testDir, 'plugins'), makeGrant({ id: 'declared-id' }));
    await revokeGrant(storage, join(testDir, 'plugins'), 'declared-id');

    await loader.loadFromPluginDir(pluginDir, 'dir-name');

    expect(loader.isLoaded('dir-name')).toBe(false);
  });

  it('refuses to auto-install a lockfile plugin that has no grant on this machine', async () => {
    const storage = new FsStorage();
    const warnings: string[] = [];
    const loader = new PluginLoader(makeRegistries(), {
      storage,
      dataDir: testDir,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
      } as unknown as Logger,
    });

    const personalityDir = join(testDir, 'personalities', 'demo');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(
      join(personalityDir, 'plugins.lock'),
      JSON.stringify({
        'tools-zerodha': {
          package: '@ethos-plugins/tools-zerodha',
          version: '1.4.2',
          registry: 'https://registry.npmjs.org',
          integrity: 'sha512-abc',
        },
      }),
    );

    await loader.resolveFromLockfile(personalityDir, ['tools-zerodha']);

    expect(warnings.join('\n')).toContain('no capability grant is recorded');
    expect(loader.isLoaded('tools-zerodha')).toBe(false);
  });

  it('picks up a revocation written after the loader was constructed', async () => {
    // `ethos plugin revoke` runs in a different process; the loader must not
    // serve a cached grant file.
    const storage = new FsStorage();
    const loader = new PluginLoader(makeRegistries(), { storage, dataDir: testDir });

    const pluginDir = join(testDir, 'plugins', 'demo-plugin');
    await writeDemoPlugin(pluginDir);
    await recordGrant(storage, join(testDir, 'plugins'), makeGrant({ id: 'demo-plugin' }));

    await loader.loadFromPluginDir(pluginDir, 'demo-plugin');
    expect(loader.isLoaded('demo-plugin')).toBe(true);

    await revokeGrant(storage, join(testDir, 'plugins'), 'demo-plugin');
    await loader.unload('demo-plugin');
    await loader.loadFromPluginDir(pluginDir, 'demo-plugin');

    expect(loader.isLoaded('demo-plugin')).toBe(false);
  });
});
