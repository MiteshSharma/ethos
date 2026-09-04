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
import { PluginLoader } from '@ethosagent/plugin-loader';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ContextInjector } from '@ethosagent/types';
import { PluginInfoSchema } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginsService } from '../plugins.service';

// `plugins.list()` used to be a pure disk read — it never asked the loader what
// actually happened, so a plugin that failed to load looked identical to one
// that loaded cleanly. These cases drive a real loader over a real plugin dir
// and assert the live status, error and safety findings survive the merge and
// the wire schema.

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

let dataDir: string;

beforeEach(async () => {
  dataDir = join(
    tmpdir(),
    `ethos-plugins-wire-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(dataDir, 'plugins'), { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writePlugin(id: string, code: string): Promise<void> {
  const dir = join(dataDir, 'plugins', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@test/${id}`,
      version: '1.2.3',
      description: 'test plugin',
      ethos: { id, type: 'plugin', pluginContractMajor: 4 },
    }),
  );
  await writeFile(join(dir, 'index.ts'), code);
}

async function listPlugins(): Promise<ReturnType<typeof PluginInfoSchema.parse>[]> {
  const storage = new FsStorage();
  const loader = new PluginLoader(makeRegistries(), { storage, dataDir });
  await loader.loadFromDirectory(join(dataDir, 'plugins'));
  const service = new PluginsService({ storage, dataDir, pluginLoader: loader });
  const { plugins } = await service.list();
  // Parse rather than trust: this is the shape the web client receives.
  return plugins.map((p) => PluginInfoSchema.parse(p));
}

describe('plugins.list() safety findings', () => {
  it('reports a yellow-but-loaded plugin with its findings', async () => {
    await writePlugin(
      'market-data',
      `
export async function activate(api) {
  api.registerTool({
    name: 'market_quote',
    description: 'Fetch a quote',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: await (await fetch(url())).text() }; },
  });
}
function url() { return 'https://example.invalid/q'; }
      `.trim(),
    );

    const row = (await listPlugins()).find((p) => p.id === 'market-data');
    expect(row?.status).toBe('loaded');
    expect(row?.error).toBeNull();
    const findings = row?.scanFindings ?? [];
    expect(findings.some((f) => f.rule === 'network-access' && f.severity === 'yellow')).toBe(true);
    expect(findings[0]?.file).toBe('index.ts');
  });

  it('reports a blocked plugin as failed, with the reason', async () => {
    await writePlugin(
      'sneaky',
      `
export async function activate(api) {
  const run = eval(recipe());
  api.registerTool({
    name: 'evil_tool',
    description: 'Nope',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: String(run) }; },
  });
}
function recipe() { return '1 + 1'; }
      `.trim(),
    );

    const row = (await listPlugins()).find((p) => p.id === 'sneaky');
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('Blocked by safety scan');
    expect(row?.scanFindings?.some((f) => f.severity === 'red')).toBe(true);
  });

  it('leaves a plugin the loader never saw with a null status', async () => {
    await writePlugin('untouched', 'export async function activate() {}');

    const storage = new FsStorage();
    const service = new PluginsService({ storage, dataDir });
    const { plugins } = await service.list();
    const row = plugins.map((p) => PluginInfoSchema.parse(p)).find((p) => p.id === 'untouched');
    expect(row).toBeDefined();
    expect(row?.status).toBeNull();
    expect(row?.scanFindings).toBeUndefined();
  });
});
