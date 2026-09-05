// WhatsApp channel-mode parity: `observe` is a third valid `default_mode`
// (plan/phases/ambient-group-monitoring.md §3).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, loadConfigStrict, readRawConfig, writeConfig } from '../index';

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];

async function storageWith(yaml: string): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return storage;
}

describe('whatsapp.<n>.default_mode: observe', () => {
  it('parses observe', async () => {
    const storage = await storageWith(
      [...BASE, 'whatsapp.0.id: wa1', 'whatsapp.0.default_mode: observe'].join('\n'),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.whatsapp).toEqual([{ id: 'wa1', default_mode: 'observe' }]);
  });

  it('round-trips observe through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'p',
      whatsapp: [{ id: 'wa1', default_mode: 'observe' }],
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('whatsapp.0.default_mode: observe');
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.whatsapp).toEqual(original.whatsapp);
  });

  it('rejects an out-of-range default_mode and names all three modes', async () => {
    const storage = await storageWith(
      [...BASE, 'whatsapp.0.id: wa1', 'whatsapp.0.default_mode: lurk'].join('\n'),
    );
    const loaded = await loadConfigStrict(storage);
    expect(
      loaded?.parseErrors.some((e) =>
        e.includes(
          "whatsapp[0]: invalid default_mode 'lurk' (expected 'all', 'mention_only' or 'observe').",
        ),
      ),
    ).toBe(true);
    expect(loaded?.config.whatsapp ?? []).toHaveLength(0);
  });
});
