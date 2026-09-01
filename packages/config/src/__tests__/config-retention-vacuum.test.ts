// Item 6 — post-prune VACUUM knobs on the `retention:` block
// (`retention.vacuumAfterPrune` / `retention.minVacuumIntervalDays`).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('retention: post-prune vacuum config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses both vacuum keys', async () => {
    const cfg = await load(
      [...base, 'retention.vacuumAfterPrune: true', 'retention.minVacuumIntervalDays: 7'].join(
        '\n',
      ),
    );
    expect(cfg?.retention).toEqual({ vacuumAfterPrune: true, minVacuumIntervalDays: 7 });
  });

  it('parses an explicit false without disturbing the TTL fields', async () => {
    const cfg = await load(
      [...base, 'retention.messages: 30d', 'retention.vacuumAfterPrune: false'].join('\n'),
    );
    expect(cfg?.retention).toEqual({ messages: '30d', vacuumAfterPrune: false });
  });

  it('drops a non-boolean vacuumAfterPrune (opt-in stays off)', async () => {
    const cfg = await load([...base, 'retention.vacuumAfterPrune: yes'].join('\n'));
    expect(cfg?.retention?.vacuumAfterPrune).toBeUndefined();
  });

  it('drops a negative or non-numeric interval', async () => {
    const negative = await load([...base, 'retention.minVacuumIntervalDays: -1'].join('\n'));
    expect(negative?.retention?.minVacuumIntervalDays).toBeUndefined();
    const nonNumeric = await load([...base, 'retention.minVacuumIntervalDays: weekly'].join('\n'));
    expect(nonNumeric?.retention?.minVacuumIntervalDays).toBeUndefined();
  });

  it('floors a fractional interval and accepts zero', async () => {
    const cfg = await load(
      [...base, 'retention.minVacuumIntervalDays: 2.9', 'retention.vacuumAfterPrune: true'].join(
        '\n',
      ),
    );
    expect(cfg?.retention).toEqual({ vacuumAfterPrune: true, minVacuumIntervalDays: 2 });
    const zero = await load([...base, 'retention.minVacuumIntervalDays: 0'].join('\n'));
    expect(zero?.retention).toEqual({ minVacuumIntervalDays: 0 });
  });

  it('leaves retention undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.retention).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      retention: {
        messages: '90d',
        vacuumAfterPrune: true,
        minVacuumIntervalDays: 14,
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.retention).toEqual(original.retention);
  });
});
