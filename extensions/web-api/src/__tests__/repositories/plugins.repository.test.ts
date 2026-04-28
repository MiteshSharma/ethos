import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginsRepository } from '../../repositories/plugins.repository';

describe('PluginsRepository', () => {
  let dir: string;
  let repo: PluginsRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-plugins-'));
    repo = new PluginsRepository({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty when no plugins dir exists', async () => {
    expect(await repo.listPlugins()).toEqual([]);
  });

  it('discovers plugins with valid manifests, sorted by name', async () => {
    await mkdir(join(dir, 'plugins', 'zebra'), { recursive: true });
    await mkdir(join(dir, 'plugins', 'alpha'), { recursive: true });
    await writeFile(
      join(dir, 'plugins', 'zebra', 'package.json'),
      JSON.stringify({
        name: 'zebra-plugin',
        version: '1.2.3',
        description: 'Zebra-themed tools',
        ethos: { type: 'plugin', pluginContractMajor: 1 },
      }),
    );
    await writeFile(
      join(dir, 'plugins', 'alpha', 'package.json'),
      JSON.stringify({
        name: 'alpha-plugin',
        version: '0.1.0',
        ethos: { type: 'plugin', id: 'alpha' },
      }),
    );

    const plugins = await repo.listPlugins();
    expect(plugins.map((p) => p.name)).toEqual(['alpha-plugin', 'zebra-plugin']);
    expect(plugins[0]).toMatchObject({ id: 'alpha', source: 'user', pluginContractMajor: null });
    expect(plugins[1]).toMatchObject({ pluginContractMajor: 1, description: 'Zebra-themed tools' });
  });

  it('skips dirs without an ethos.type === plugin manifest', async () => {
    await mkdir(join(dir, 'plugins', 'not-a-plugin'), { recursive: true });
    await writeFile(
      join(dir, 'plugins', 'not-a-plugin', 'package.json'),
      JSON.stringify({ name: 'random-pkg', version: '1.0.0' }),
    );
    expect(await repo.listPlugins()).toEqual([]);
  });

  it('skips dirs with malformed manifests rather than throwing', async () => {
    await mkdir(join(dir, 'plugins', 'broken'), { recursive: true });
    await writeFile(join(dir, 'plugins', 'broken', 'package.json'), '{ not json');
    await mkdir(join(dir, 'plugins', 'good'), { recursive: true });
    await writeFile(
      join(dir, 'plugins', 'good', 'package.json'),
      JSON.stringify({ name: 'good', version: '1.0.0', ethos: { type: 'plugin' } }),
    );
    const plugins = await repo.listPlugins();
    expect(plugins.map((p) => p.id)).toEqual(['good']);
  });
});
