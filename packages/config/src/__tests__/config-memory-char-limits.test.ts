// Item 8 — per-key markdown memory ceilings (`memory.charLimits.memory` /
// `memory.charLimits.user`).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('memory.charLimits config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses both ceilings', async () => {
    const cfg = await load(
      [...base, 'memory.charLimits.memory: 524288', 'memory.charLimits.user: 262144'].join('\n'),
    );
    expect(cfg?.memoryCharLimits).toEqual({ memory: 524_288, user: 262_144 });
  });

  it('parses one ceiling on its own and leaves the backend selector alone', async () => {
    const cfg = await load([...base, 'memory: vector', 'memory.charLimits.user: 1024'].join('\n'));
    expect(cfg?.memoryCharLimits).toEqual({ user: 1024 });
    expect(cfg?.memory).toBe('vector');
  });

  it('drops non-positive and non-numeric ceilings', async () => {
    const cfg = await load(
      [...base, 'memory.charLimits.memory: 0', 'memory.charLimits.user: lots'].join('\n'),
    );
    expect(cfg?.memoryCharLimits).toBeUndefined();
  });

  it('floors a fractional ceiling', async () => {
    const cfg = await load([...base, 'memory.charLimits.memory: 1024.7'].join('\n'));
    expect(cfg?.memoryCharLimits).toEqual({ memory: 1024 });
  });

  it('leaves memoryCharLimits undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.memoryCharLimits).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      memory: 'markdown' as const,
      memoryCharLimits: { memory: 65_536, user: 32_768 },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.memoryCharLimits).toEqual(original.memoryCharLimits);
    expect(roundTripped?.memory).toBe('markdown');
  });
});
