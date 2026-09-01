// Item 2 — `logs.level`: the lowest severity ConsoleLogger prints.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('logs.level config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses each of the four levels', async () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const cfg = await load([...base, `logs.level: ${level}`].join('\n'));
      expect(cfg?.logs).toEqual({ level });
    }
  });

  it('drops an unrecognised level rather than defaulting it', async () => {
    const cfg = await load([...base, 'logs.level: verbose'].join('\n'));
    expect(cfg?.logs).toBeUndefined();
  });

  it('coexists with logs.rotation on the same block', async () => {
    const cfg = await load([...base, 'logs.rotation.maxFiles: 3', 'logs.level: warn'].join('\n'));
    expect(cfg?.logs).toEqual({ rotation: { maxFiles: 3 }, level: 'warn' });
  });

  it('leaves logs undefined when no keys are present (everything prints)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.logs).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      logs: { rotation: { maxBytes: 1024, maxFiles: 2 }, level: 'error' as const },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.logs).toEqual(original.logs);
  });
});
