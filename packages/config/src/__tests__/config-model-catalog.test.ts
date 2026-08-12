import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('modelCatalog config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('parses modelCatalog.enabled: false', async () => {
    const cfg = await load([...base, 'modelCatalog.enabled: false'].join('\n'));
    expect(cfg?.modelCatalog?.enabled).toBe(false);
  });

  it('parses modelCatalog.enabled: true', async () => {
    const cfg = await load([...base, 'modelCatalog.enabled: true'].join('\n'));
    expect(cfg?.modelCatalog?.enabled).toBe(true);
  });

  it('parses modelCatalog.url', async () => {
    const cfg = await load(
      [...base, 'modelCatalog.url: https://custom.example.com/catalog.json'].join('\n'),
    );
    expect(cfg?.modelCatalog?.url).toBe('https://custom.example.com/catalog.json');
  });

  it('parses modelCatalog.ttlHours', async () => {
    const cfg = await load([...base, 'modelCatalog.ttlHours: 12'].join('\n'));
    expect(cfg?.modelCatalog?.ttlHours).toBe(12);
  });

  it('parses modelCatalog.providers.<id>.url', async () => {
    const cfg = await load(
      [
        ...base,
        'modelCatalog.providers.anthropic.url: https://internal.example.com/anthropic.json',
        'modelCatalog.providers.openai.url: https://internal.example.com/openai.json',
      ].join('\n'),
    );
    expect(cfg?.modelCatalog?.providers).toEqual({
      anthropic: { url: 'https://internal.example.com/anthropic.json' },
      openai: { url: 'https://internal.example.com/openai.json' },
    });
  });

  it('leaves modelCatalog undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.modelCatalog).toBeUndefined();
  });

  it('round-trips modelCatalog config through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      modelCatalog: {
        enabled: false,
        url: 'https://custom.example.com/catalog.json',
        ttlHours: 12,
        providers: {
          anthropic: { url: 'https://internal.example.com/anthropic.json' },
        },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.modelCatalog).toEqual(original.modelCatalog);
  });

  it('round-trips modelCatalog with only enabled: false', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      modelCatalog: {
        enabled: false,
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.modelCatalog?.enabled).toBe(false);
  });

  it('does not serialize modelCatalog when enabled is true (default)', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      modelCatalog: {
        enabled: true,
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    // enabled: true is not serialized (it's the default)
    expect(raw).not.toContain('modelCatalog.enabled');
  });
});
