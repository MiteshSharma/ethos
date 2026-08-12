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
import { FsStorage, InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { ContextInjector, Logger } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginLoader } from '../index';

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
  testDir = join(tmpdir(), `ethos-plugin-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// Writes a minimal plugin to a temp directory and returns the dir path
async function writePlugin(dir: string, name: string, code: string): Promise<string> {
  const pluginDir = join(dir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'index.ts'), code);
  return pluginDir;
}

describe('PluginLoader', () => {
  it('loads a plugin that registers a tool', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    await writePlugin(
      testDir,
      'my-plugin',
      `
import { ok } from '@ethosagent/plugin-sdk/tool-helpers';
export async function activate(api) {
  api.registerTool({
    name: 'my_plugin_tool',
    description: 'Test tool',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: 'from plugin' }; },
  });
}
      `.trim(),
    );

    await loader.loadFromDirectory(testDir);

    expect(loader.isLoaded('my-plugin')).toBe(true);
    expect(registries.tools.get('my_plugin_tool')).toBeDefined();
  });

  it('unloads a plugin and removes its tools', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    await writePlugin(
      testDir,
      'unload-test',
      `
export async function activate(api) {
  api.registerTool({
    name: 'removable_tool',
    description: 'Will be removed',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: 'x' }; },
  });
}
export async function deactivate() {}
      `.trim(),
    );

    await loader.loadFromDirectory(testDir);
    expect(registries.tools.get('removable_tool')).toBeDefined();

    await loader.unload('unload-test');
    expect(loader.isLoaded('unload-test')).toBe(false);
    expect(registries.tools.get('removable_tool')).toBeUndefined();
  });

  it('skips directories without activate export', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    await writePlugin(testDir, 'broken-plugin', '// no activate export');

    await loader.loadFromDirectory(testDir);
    expect(loader.list()).toHaveLength(0);
  });

  it('does not throw when directory does not exist', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });
    await expect(loader.loadFromDirectory(join(testDir, 'nonexistent'))).resolves.not.toThrow();
  });

  it('list() returns loaded plugin ids', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    await writePlugin(testDir, 'plugin-a', 'export async function activate(api) {}');
    await writePlugin(testDir, 'plugin-b', 'export async function activate(api) {}');

    await loader.loadFromDirectory(testDir);

    const ids = loader.list();
    expect(ids).toContain('plugin-a');
    expect(ids).toContain('plugin-b');
  });

  it('unloadAll() removes all plugins', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    await writePlugin(testDir, 'p1', 'export async function activate(api) {}');
    await writePlugin(testDir, 'p2', 'export async function activate(api) {}');

    await loader.loadFromDirectory(testDir);
    expect(loader.list()).toHaveLength(2);

    await loader.unloadAll();
    expect(loader.list()).toHaveLength(0);
  });

  it('loadFromNodeModules discovers scoped @ethos-plugins/* packages', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    // Lay out a fake node_modules with both a flat ethos-plugin-* and a scoped one.
    const flatDir = join(testDir, 'ethos-plugin-flat');
    await mkdir(flatDir, { recursive: true });
    await writeFile(
      join(flatDir, 'package.json'),
      JSON.stringify({
        name: 'ethos-plugin-flat',
        main: 'index.ts',
        ethos: { type: 'plugin', pluginContractMajor: 4 },
      }),
    );
    await writeFile(
      join(flatDir, 'index.ts'),
      `export async function activate(api) {
        api.registerTool({
          name: 'flat_tool',
          description: '',
          schema: { type: 'object', properties: {} },
          async execute() { return { ok: true, value: 'flat' }; },
        });
      }`,
    );

    const scopedDir = join(testDir, '@ethos-plugins', 'scoped');
    await mkdir(scopedDir, { recursive: true });
    await writeFile(
      join(scopedDir, 'package.json'),
      JSON.stringify({
        name: '@ethos-plugins/scoped',
        main: 'index.ts',
        ethos: { type: 'plugin', pluginContractMajor: 4 },
      }),
    );
    await writeFile(
      join(scopedDir, 'index.ts'),
      `export async function activate(api) {
        api.registerTool({
          name: 'scoped_tool',
          description: '',
          schema: { type: 'object', properties: {} },
          async execute() { return { ok: true, value: 'scoped' }; },
        });
      }`,
    );

    await loader.loadFromNodeModules(testDir);

    expect(registries.tools.get('flat_tool')).toBeDefined();
    expect(registries.tools.get('scoped_tool')).toBeDefined();
  });

  // --- Credential management -------------------------------------------------

  describe('credential methods', () => {
    it('setCredential throws for an unknown plugin id', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets: new InMemorySecretsResolver(),
        dataDir: testDir,
      });

      await expect(loader.setCredential('nonexistent', 'API_KEY', 'secret')).rejects.toThrow(
        'Plugin "nonexistent" is not loaded',
      );
    });

    it('setCredential puts the value in the vault and only meta on disk', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      await writePlugin(testDir, 'cred-test', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      expect(loader.isLoaded('cred-test')).toBe(true);

      await loader.setCredential('cred-test', 'API_KEY', 'my-secret-value');

      // G-SEC — the value is in the vault, and nowhere on disk.
      expect(await secrets.get('plugins/cred-test/API_KEY')).toBe('my-secret-value');
      expect(await credStorage.exists('/test-data/plugins/cred-test/credentials/API_KEY')).toBe(
        false,
      );

      // Verify the meta file was written
      const metaRaw = await credStorage.read(
        '/test-data/plugins/cred-test/credentials/API_KEY.meta',
      );
      expect(metaRaw).not.toBeNull();
      const meta = JSON.parse(metaRaw ?? '');
      expect(meta.updatedAt).toBeDefined();
    });

    it('getCredentialMeta returns null for unset credential', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      const meta = await loader.getCredentialMeta('some-plugin', 'MISSING_KEY');
      expect(meta).toBeNull();
    });

    it('getCredentialMeta returns updatedAt after setCredential', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      await writePlugin(testDir, 'meta-test', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);

      await loader.setCredential('meta-test', 'TOKEN', 'abc123');

      const meta = await loader.getCredentialMeta('meta-test', 'TOKEN');
      expect(meta).not.toBeNull();
      expect(meta?.updatedAt).toBeDefined();
      // Should be a valid ISO date string
      expect(Number.isNaN(Date.parse(meta?.updatedAt ?? ''))).toBe(false);
    });

    it('clearCredential removes credential and meta files', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      await writePlugin(testDir, 'clear-test', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);

      await loader.setCredential('clear-test', 'SECRET', 'value');

      // Verify they exist
      expect(await secrets.get('plugins/clear-test/SECRET')).toBe('value');
      expect(
        await credStorage.exists('/test-data/plugins/clear-test/credentials/SECRET.meta'),
      ).toBe(true);

      await loader.clearCredential('clear-test', 'SECRET');

      expect(await secrets.get('plugins/clear-test/SECRET')).toBeNull();
      expect(
        await credStorage.exists('/test-data/plugins/clear-test/credentials/SECRET.meta'),
      ).toBe(false);
    });

    it('listCredentialKeys merges manifest declarations with storage state', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      // Write a plugin with credential declarations in package.json
      const pluginDir = join(testDir, 'list-test');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'list-test',
          version: '1.0.0',
          ethos: {
            type: 'plugin',
            pluginContractMajor: 4,
            credentials: [
              {
                key: 'API_KEY',
                label: 'API Key',
                type: 'secret',
                description: 'Main API key',
                required: true,
              },
              {
                key: 'WORKSPACE',
                label: 'Workspace ID',
                type: 'text',
              },
            ],
          },
        }),
      );
      await writeFile(join(pluginDir, 'index.ts'), 'export async function activate(api) {}');

      await loader.loadFromDirectory(testDir);

      // Set only one of the declared credentials
      await loader.setCredential('list-test', 'API_KEY', 'secret-value');

      // Also write an undeclared credential straight into the vault
      await secrets.set('plugins/list-test/EXTRA_TOKEN', 'extra-value');
      await credStorage.mkdir('/test-data/plugins/list-test/credentials');
      await credStorage.write(
        '/test-data/plugins/list-test/credentials/EXTRA_TOKEN.meta',
        JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z' }),
      );

      const keys = await loader.listCredentialKeys('list-test');

      // Should have 3 entries: API_KEY (declared+set), WORKSPACE (declared+unset), EXTRA_TOKEN (undeclared+set)
      expect(keys).toHaveLength(3);

      const apiKey = keys.find((k) => k.key === 'API_KEY');
      expect(apiKey).toBeDefined();
      expect(apiKey?.isSet).toBe(true);
      expect(apiKey?.label).toBe('API Key');
      expect(apiKey?.type).toBe('secret');
      expect(apiKey?.description).toBe('Main API key');
      expect(apiKey?.required).toBe(true);
      expect(apiKey?.updatedAt).toBeDefined();

      const workspace = keys.find((k) => k.key === 'WORKSPACE');
      expect(workspace).toBeDefined();
      expect(workspace?.isSet).toBe(false);
      expect(workspace?.label).toBe('Workspace ID');
      expect(workspace?.updatedAt).toBeNull();

      const extra = keys.find((k) => k.key === 'EXTRA_TOKEN');
      expect(extra).toBeDefined();
      expect(extra?.isSet).toBe(true);
      expect(extra?.label).toBe('EXTRA_TOKEN');
      expect(extra?.type).toBe('text');
      expect(extra?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('migrates a pre-vault plaintext credential on first touch', async () => {
      // The upgrade case: a plugin installed before credentials moved into the
      // vault. Its credential must keep working with no operator action, and
      // the plaintext copy must not survive the migration.
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      const legacyDir = '/test-data/plugins/legacy-test/credentials';
      await credStorage.mkdir(legacyDir);
      await credStorage.write(`${legacyDir}/API_KEY`, 'sk-from-before');

      expect(await loader.getCredentialValue('legacy-test', 'API_KEY')).toBe('sk-from-before');
      expect(await secrets.get('plugins/legacy-test/API_KEY')).toBe('sk-from-before');
      expect(await credStorage.exists(`${legacyDir}/API_KEY`)).toBe(false);
    });

    it('a migrated credential is visible to hasSecret when the plugin loads', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      const legacyDir = '/test-data/plugins/prime-test/credentials';
      await credStorage.mkdir(legacyDir);
      await credStorage.write(`${legacyDir}/TOKEN`, 'tok');

      // The plugin asks synchronously during activate() — the only moment that
      // proves priming happened before the api was handed over.
      await writePlugin(
        testDir,
        'prime-test',
        `export async function activate(api) {
          globalThis.__primeTestHasSecret = api.hasSecret('TOKEN');
        }`,
      );
      await loader.loadFromDirectory(testDir);

      expect(loader.isLoaded('prime-test')).toBe(true);
      expect((globalThis as Record<string, unknown>).__primeTestHasSecret).toBe(true);
    });

    it('listCredentialKeys returns empty array for plugin with no credentials', async () => {
      const registries = makeRegistries();
      const credStorage = new InMemoryStorage();
      const secrets = new InMemorySecretsResolver();
      const loader = new PluginLoader(registries, {
        storage: new FsStorage(),
        credentialStorage: credStorage,
        secrets,
        dataDir: '/test-data',
      });

      await writePlugin(testDir, 'no-creds', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);

      const keys = await loader.listCredentialKeys('no-creds');
      expect(keys).toHaveLength(0);
    });
  });

  // --- Data source registration -----------------------------------------------

  describe('data source registration', () => {
    it('getDataSourcePath returns path registered by plugin', async () => {
      const registries = makeRegistries();
      registries.dataSources = new Map();
      const loader = new PluginLoader(registries, { storage: new FsStorage() });

      await writePlugin(
        testDir,
        'ds-plugin',
        `
export async function activate(api) {
  api.registerDataSource('my-db', '/path/to/db.sqlite');
}
        `.trim(),
      );

      await loader.loadFromDirectory(testDir);
      expect(loader.getDataSourcePath('ds-plugin', 'my-db')).toBe('/path/to/db.sqlite');
    });

    it('getDataSourcePath returns null for unknown source', async () => {
      const registries = makeRegistries();
      registries.dataSources = new Map();
      const loader = new PluginLoader(registries, { storage: new FsStorage() });

      await writePlugin(testDir, 'ds-plugin2', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      expect(loader.getDataSourcePath('ds-plugin2', 'missing')).toBeNull();
    });

    it('getPluginPath returns plugin directory', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries, { storage: new FsStorage() });

      await writePlugin(testDir, 'path-plugin', 'export async function activate(api) {}');
      await loader.loadFromDirectory(testDir);
      expect(loader.getPluginPath('path-plugin')).toBe(join(testDir, 'path-plugin'));
    });

    it('getPluginPath returns null for unknown plugin', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries, { storage: new FsStorage() });
      expect(loader.getPluginPath('nonexistent')).toBeNull();
    });
  });

  // --- Phase 30.6 — plugin contract version gate ---------------------------

  describe('Phase 30.6: contract major gate', () => {
    it('rejects a directory plugin declaring an incompatible pluginContractMajor', async () => {
      const registries = makeRegistries();
      const warns: string[] = [];
      const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => {
          warns.push(msg);
        },
        error: () => {},
        child: () => logger,
      };
      const loader = new PluginLoader(registries, { storage: new FsStorage(), logger });

      const pluginDir = join(testDir, 'old-major');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'old-major',
          version: '1.0.0',
          ethos: { type: 'plugin', pluginContractMajor: 999 },
        }),
      );
      await writeFile(
        join(pluginDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'should_not_register',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'no' }; },
          });
        }`,
      );

      await loader.loadFromDirectory(testDir);

      expect(loader.isLoaded('old-major')).toBe(false);
      expect(registries.tools.get('should_not_register')).toBeUndefined();
      // Rejection message names plugin, declared major, current major, and links to MIGRATIONS.md
      const msg = warns.find((w) => w.includes('old-major'));
      expect(msg).toBeDefined();
      expect(msg).toMatch(/pluginContractMajor=999/);
      expect(msg).toMatch(/MIGRATIONS\.md/);
    });

    it('rejects an npm-discovered plugin declaring an incompatible major', async () => {
      const registries = makeRegistries();
      const warns: string[] = [];
      const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => {
          warns.push(msg);
        },
        error: () => {},
        child: () => logger,
      };
      const loader = new PluginLoader(registries, { storage: new FsStorage(), logger });

      const pluginDir = join(testDir, 'ethos-plugin-bad');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({
          name: 'ethos-plugin-bad',
          main: 'index.ts',
          ethos: { type: 'plugin', pluginContractMajor: 42 },
        }),
      );
      await writeFile(
        join(pluginDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'bad_tool',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'no' }; },
          });
        }`,
      );

      await loader.loadFromNodeModules(testDir);

      expect(registries.tools.get('bad_tool')).toBeUndefined();
      expect(warns.find((w) => /ethos-plugin-bad.*pluginContractMajor=42/.test(w))).toBeDefined();
    });

    // P2.6/S8 — an Ethos plugin that declares NO contract major is rejected
    // (unknown contract). This replaces the old backward-compat allowance.
    it('rejects an Ethos plugin that declares no pluginContractMajor (S8)', async () => {
      const registries = makeRegistries();
      const warns: string[] = [];
      const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => {
          warns.push(msg);
        },
        error: () => {},
        child: () => logger,
      };
      const loader = new PluginLoader(registries, { storage: new FsStorage(), logger });

      const pluginDir = join(testDir, 'no-major');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'no-major', version: '1.0.0', ethos: { type: 'plugin' } }),
      );
      await writeFile(
        join(pluginDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'compat_tool',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'ok' }; },
          });
        }`,
      );

      await loader.loadFromDirectory(testDir);

      // Not imported: not loaded and its tool never registered.
      expect(loader.isLoaded('no-major')).toBe(false);
      expect(registries.tools.get('compat_tool')).toBeUndefined();
      // Status tracked as failed with a reason naming the missing field.
      const manifest = loader.listManifests().find((m) => m.id === 'no-major');
      expect(manifest?.status).toBe('failed');
      expect(manifest?.error).toMatch(/pluginContractMajor/);
      // Rejection logged.
      expect(warns.find((w) => /no-major.*pluginContractMajor/.test(w))).toBeDefined();
    });

    it('does not gate an OpenClaw / non-Ethos package lacking a contract major', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries, { storage: new FsStorage() });

      // ethos.type is NOT 'plugin' — this is not an Ethos-native plugin, so the
      // contract gate must not reject it for a missing pluginContractMajor.
      const pluginDir = join(testDir, 'not-ethos');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'not-ethos', version: '1.0.0' }),
      );
      await writeFile(
        join(pluginDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'non_ethos_tool',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'ok' }; },
          });
        }`,
      );

      await loader.loadFromDirectory(testDir);
      expect(loader.isLoaded('not-ethos')).toBe(true);
      expect(registries.tools.get('non_ethos_tool')).toBeDefined();
    });

    // P2.6/S7 — load failures are retrievable by the caller via getFailures().
    it('exposes load failures to the caller via getFailures() (S7)', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries, { storage: new FsStorage() });

      const pluginDir = join(testDir, 'failing');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'failing', version: '1.0.0', ethos: { type: 'plugin' } }),
      );
      await writeFile(join(pluginDir, 'index.ts'), 'export async function activate(api) {}');

      await loader.loadFromDirectory(testDir);

      const failures = loader.getFailures();
      const failure = failures.find((f) => f.id === 'failing');
      expect(failure).toBeDefined();
      expect(failure?.status).toBe('failed');
      expect(failure?.error).toMatch(/pluginContractMajor/);
    });

    // P2.6 — isolation: one plugin's rejection must not block a valid sibling.
    it('one plugin failing does not block a sibling from loading', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries, { storage: new FsStorage() });

      // Sibling A — rejected (Ethos plugin, no contract major).
      const badDir = join(testDir, 'bad-sibling');
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, 'package.json'),
        JSON.stringify({ name: 'bad-sibling', version: '1.0.0', ethos: { type: 'plugin' } }),
      );
      await writeFile(
        join(badDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'bad_sibling_tool',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'no' }; },
          });
        }`,
      );

      // Sibling B — valid (declares a compatible major).
      const goodDir = join(testDir, 'good-sibling');
      await mkdir(goodDir, { recursive: true });
      await writeFile(
        join(goodDir, 'package.json'),
        JSON.stringify({
          name: 'good-sibling',
          version: '1.0.0',
          ethos: { type: 'plugin', pluginContractMajor: 4 },
        }),
      );
      await writeFile(
        join(goodDir, 'index.ts'),
        `export async function activate(api) {
          api.registerTool({
            name: 'good_sibling_tool',
            description: '',
            schema: { type: 'object', properties: {} },
            async execute() { return { ok: true, value: 'yes' }; },
          });
        }`,
      );

      await loader.loadFromDirectory(testDir);

      // Bad sibling rejected, good sibling loaded — isolation holds.
      expect(loader.isLoaded('bad-sibling')).toBe(false);
      expect(registries.tools.get('bad_sibling_tool')).toBeUndefined();
      expect(loader.isLoaded('good-sibling')).toBe(true);
      expect(registries.tools.get('good_sibling_tool')).toBeDefined();
    });
  });
});
