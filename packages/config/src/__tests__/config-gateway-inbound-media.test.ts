// Item 5 — `gateway.maxInboundMediaBytes`: the per-adapter inbound-attachment
// cap override. One value; each adapter falls back to its own default.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('gateway inbound-media cap config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses the cap', async () => {
    const cfg = await load([...base, 'gateway.maxInboundMediaBytes: 52428800'].join('\n'));
    expect(cfg?.gateway).toEqual({ maxInboundMediaBytes: 52428800 });
  });

  it('drops an out-of-range or non-numeric cap', async () => {
    const tooSmall = await load([...base, 'gateway.maxInboundMediaBytes: 1023'].join('\n'));
    expect(tooSmall?.gateway).toBeUndefined();

    const tooBig = await load([...base, 'gateway.maxInboundMediaBytes: 134217729'].join('\n'));
    expect(tooBig?.gateway).toBeUndefined();

    // The ceiling itself is accepted — every adapter buffers the whole download,
    // so 128 MiB is the largest allocation an untrusted sender can force.
    const atCeiling = await load([...base, 'gateway.maxInboundMediaBytes: 134217728'].join('\n'));
    expect(atCeiling?.gateway).toEqual({ maxInboundMediaBytes: 134217728 });

    const nonNumeric = await load([...base, 'gateway.maxInboundMediaBytes: huge'].join('\n'));
    expect(nonNumeric?.gateway).toBeUndefined();
  });

  it('leaves gateway undefined when the key is absent', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.gateway).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      gateway: { maxInboundMediaBytes: 8 * 1024 * 1024 },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.gateway).toEqual(original.gateway);
  });
});
