// Lane 0 (eng review D4) — the `contextWindow` operator override: a window
// FACT (what the server accepts), distinct from the `compaction.maxContextTokens`
// POLICY key. Parse + serialize round-trip.

import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

describe('contextWindow config key (Lane 0, D4)', () => {
  it('parses a positive integer window', async () => {
    const cfg = await load([...base, 'contextWindow: 8192'].join('\n'));
    expect(cfg?.contextWindow).toBe(8192);
  });

  it('is absent when not set', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.contextWindow).toBeUndefined();
  });

  it('drops zero, negative, and non-numeric values', async () => {
    expect((await load([...base, 'contextWindow: 0'].join('\n')))?.contextWindow).toBeUndefined();
    expect((await load([...base, 'contextWindow: -5'].join('\n')))?.contextWindow).toBeUndefined();
    expect(
      (await load([...base, 'contextWindow: lots'].join('\n')))?.contextWindow,
    ).toBeUndefined();
  });

  it('floors a fractional value', async () => {
    const cfg = await load([...base, 'contextWindow: 8192.7'].join('\n'));
    expect(cfg?.contextWindow).toBe(8192);
  });

  it('does not collide with compaction.maxContextTokens', async () => {
    const cfg = await load(
      [...base, 'contextWindow: 8192', 'compaction.maxContextTokens: 400000'].join('\n'),
    );
    expect(cfg?.contextWindow).toBe(8192);
    expect(cfg?.compaction?.maxContextTokens).toBe(400_000);
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(storage, {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'p',
      contextWindow: 8192,
    });
    const cfg = await readRawConfig(storage);
    expect(cfg?.contextWindow).toBe(8192);
  });

  it('writeConfig omits the key when unset', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(storage, {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'p',
    });
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('contextWindow:');
  });
});
