import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { ContextInjector } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginLoader } from '../index';

function makeRegistries() {
  const injectors: ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
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
    const loader = new PluginLoader(registries);

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
    const loader = new PluginLoader(registries);

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
    const loader = new PluginLoader(registries);

    await writePlugin(testDir, 'broken-plugin', '// no activate export');

    await loader.loadFromDirectory(testDir);
    expect(loader.list()).toHaveLength(0);
  });

  it('does not throw when directory does not exist', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);
    await expect(loader.loadFromDirectory(join(testDir, 'nonexistent'))).resolves.not.toThrow();
  });

  it('list() returns loaded plugin ids', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);

    await writePlugin(testDir, 'plugin-a', 'export async function activate(api) {}');
    await writePlugin(testDir, 'plugin-b', 'export async function activate(api) {}');

    await loader.loadFromDirectory(testDir);

    const ids = loader.list();
    expect(ids).toContain('plugin-a');
    expect(ids).toContain('plugin-b');
  });

  it('unloadAll() removes all plugins', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);

    await writePlugin(testDir, 'p1', 'export async function activate(api) {}');
    await writePlugin(testDir, 'p2', 'export async function activate(api) {}');

    await loader.loadFromDirectory(testDir);
    expect(loader.list()).toHaveLength(2);

    await loader.unloadAll();
    expect(loader.list()).toHaveLength(0);
  });

  it('loadFromNodeModules discovers scoped @ethos-plugins/* packages', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries);

    // Lay out a fake node_modules with both a flat ethos-plugin-* and a scoped one.
    const flatDir = join(testDir, 'ethos-plugin-flat');
    await mkdir(flatDir, { recursive: true });
    await writeFile(
      join(flatDir, 'package.json'),
      JSON.stringify({ name: 'ethos-plugin-flat', main: 'index.ts', ethos: { type: 'plugin' } }),
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
        ethos: { type: 'plugin' },
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

  // --- Phase 30.6 — plugin contract version gate ---------------------------

  describe('Phase 30.6: contract major gate', () => {
    it('rejects a directory plugin declaring an incompatible pluginContractMajor', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries);

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

      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args) => warns.push(args.join(' '));
      try {
        await loader.loadFromDirectory(testDir);
      } finally {
        console.warn = origWarn;
      }

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
      const loader = new PluginLoader(registries);

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

      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args) => warns.push(args.join(' '));
      try {
        await loader.loadFromNodeModules(testDir);
      } finally {
        console.warn = origWarn;
      }

      expect(registries.tools.get('bad_tool')).toBeUndefined();
      expect(warns.find((w) => /ethos-plugin-bad.*pluginContractMajor=42/.test(w))).toBeDefined();
    });

    it('allows a plugin without pluginContractMajor (backward compat)', async () => {
      const registries = makeRegistries();
      const loader = new PluginLoader(registries);

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
      expect(loader.isLoaded('no-major')).toBe(true);
      expect(registries.tools.get('compat_tool')).toBeDefined();
    });
  });
});
