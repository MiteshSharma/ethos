// Item 3 — `cron.maxParallelJobs`: cap on cron jobs executing at once.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('cron.maxParallelJobs config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses the cap on its own', async () => {
    const cfg = await load([...base, 'cron.maxParallelJobs: 3'].join('\n'));
    expect(cfg?.cron).toEqual({ maxParallelJobs: 3 });
  });

  it('sits alongside the trigger/arming sub-blocks', async () => {
    const cfg = await load(
      [...base, 'cron.trigger.external: true', 'cron.maxParallelJobs: 2'].join('\n'),
    );
    expect(cfg?.cron).toEqual({ trigger: { external: true }, maxParallelJobs: 2 });
  });

  it('drops a non-positive or non-numeric cap', async () => {
    expect((await load([...base, 'cron.maxParallelJobs: 0'].join('\n')))?.cron).toBeUndefined();
    expect((await load([...base, 'cron.maxParallelJobs: -1'].join('\n')))?.cron).toBeUndefined();
    expect((await load([...base, 'cron.maxParallelJobs: many'].join('\n')))?.cron).toBeUndefined();
  });

  it('leaves cron undefined when no keys are present (uncapped)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.cron).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      cron: { maxParallelJobs: 4 },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.cron).toEqual(original.cron);
  });
});
