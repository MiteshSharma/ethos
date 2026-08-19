import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readConfig, readRawConfig, writeConfig } from '../index';

// D10 (4.1) — `web.host` / `web.port` / `web.corsOrigins` share the `web.*`
// block with the pre-existing `search_backend` / `extract_backend` keys.

const base = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function load(yaml: string): Promise<EthosConfig | null> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

describe('parseConfigYaml — web.host / web.port / web.corsOrigins', () => {
  it('parses all three alongside the existing search/extract backend keys', async () => {
    const cfg = await load(
      [
        ...base,
        'web.search_backend: exa',
        'web.host: 0.0.0.0',
        'web.port: 3000',
        'web.corsOrigins: https://chat.example.com',
      ].join('\n'),
    );
    expect(cfg?.web).toEqual({
      search_backend: 'exa',
      host: '0.0.0.0',
      port: 3000,
      corsOrigins: 'https://chat.example.com',
    });
  });

  it('leaves web undefined when none of the keys are set', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.web).toBeUndefined();
  });

  it('drops an out-of-range or non-integer port rather than clamping it', async () => {
    const cfg = await load([...base, 'web.port: 99999', 'web.host: 0.0.0.0'].join('\n'));
    expect(cfg?.web).toEqual({ host: '0.0.0.0' });
  });

  it('round-trips web.host / web.port / web.corsOrigins through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      web: {
        host: '0.0.0.0',
        port: 3000,
        corsOrigins: 'https://chat.example.com',
      },
    } satisfies EthosConfig;
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.web).toEqual(original.web);
  });
});
