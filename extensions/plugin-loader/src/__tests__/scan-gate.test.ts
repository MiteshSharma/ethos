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
import { FsStorage } from '@ethosagent/storage-fs';
import type { ContextInjector } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginLoader } from '../index';

// The safety gate at load time. A deliberately installed plugin that calls
// `fetch` — every market-data, news or API plugin — trips the scanner's
// yellow `network-access` rule, and used to be refused with no way to say
// otherwise and no trace in any UI. Yellow now loads and the findings are
// retained for the Plugins tab; red still blocks, and that is the half these
// tests exist to hold down.

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
  testDir = join(tmpdir(), `ethos-scan-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writePlugin(name: string, code: string): Promise<void> {
  const dir = join(testDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.ts'), code);
}

const NETWORK_PLUGIN = `
export async function activate(api) {
  api.registerTool({
    name: 'market_quote',
    description: 'Fetch a quote',
    schema: { type: 'object', properties: {} },
    async execute() {
      const res = await fetch(buildUrl());
      return { ok: true, value: await res.text() };
    },
  });
}
function buildUrl() { return 'https://example.invalid/quote'; }
`.trim();

const EVAL_PLUGIN = `
export async function activate(api) {
  const run = eval(readRecipe());
  api.registerTool({
    name: 'evil_tool',
    description: 'Nope',
    schema: { type: 'object', properties: {} },
    async execute() { return { ok: true, value: String(run) }; },
  });
}
function readRecipe() { return '1 + 1'; }
`.trim();

describe('load-time safety scan', () => {
  it('loads a plugin whose only findings are yellow, and keeps them', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    await writePlugin('market-data', NETWORK_PLUGIN);
    await loader.loadFromDirectory(testDir);

    expect(registries.tools.get('market_quote')).toBeDefined();

    const manifest = loader.listManifests().find((m) => m.id === 'market-data');
    expect(manifest?.status).toBe('loaded');
    const findings = manifest?.scanFindings ?? [];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === 'yellow')).toBe(true);
    expect(findings.some((f) => f.rule === 'network-access')).toBe(true);
    // The scanner reads one source string at a time; the loader is what knows
    // which file it came from, so the file has to survive aggregation.
    expect(findings[0]?.file).toBe('index.ts');
    expect(loader.getFailures()).toHaveLength(0);
  });

  it('still blocks a plugin with a red finding, and reports why', async () => {
    const registries = makeRegistries();
    const loader = new PluginLoader(registries, { storage: new FsStorage() });

    await writePlugin('sneaky', EVAL_PLUGIN);
    await loader.loadFromDirectory(testDir);

    expect(registries.tools.get('evil_tool')).toBeUndefined();

    const failure = loader.getFailures().find((m) => m.id === 'sneaky');
    expect(failure).toBeDefined();
    expect(failure?.error).toContain('Blocked by safety scan');
    expect(failure?.scanFindings?.some((f) => f.severity === 'red')).toBe(true);
  });
});
