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
});
