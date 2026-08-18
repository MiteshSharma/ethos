import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// `callCapture.personalityId` — the single system-wide call-capture binding
// (plan/phases/call-capture-extension.md decision 3).

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(
    join(ethosDir(), 'config.yaml'),
    ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher', ...lines].join(
      '\n',
    ),
  );
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('callCapture.personalityId', () => {
  it('is undefined when the key is absent', async () => {
    const cfg = await load([]);
    expect(cfg.callCapture).toBeUndefined();
  });

  it('parses to { personalityId }', async () => {
    const cfg = await load(['callCapture.personalityId: assistant']);
    expect(cfg.callCapture).toEqual({ personalityId: 'assistant' });
  });

  it('round-trips through writeConfig -> readRawConfig', async () => {
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      callCapture: { personalityId: 'receptionist' },
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.callCapture).toEqual({ personalityId: 'receptionist' });
  });
});
