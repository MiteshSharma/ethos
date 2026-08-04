// §5 — global compaction gate thresholds (`compaction.pressure` / `.target`).

import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('compaction: global gate thresholds config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses compaction.pressure and compaction.target', async () => {
    const cfg = await load(
      [...base, 'compaction.pressure: 0.85', 'compaction.target: 0.6'].join('\n'),
    );
    expect(cfg?.compaction).toEqual({ pressure: 0.85, target: 0.6 });
  });

  it('parses a single field on its own', async () => {
    const cfg = await load([...base, 'compaction.pressure: 0.9'].join('\n'));
    expect(cfg?.compaction).toEqual({ pressure: 0.9 });
  });

  it('drops an out-of-range value (>1) and leaves the rest', async () => {
    const cfg = await load(
      [...base, 'compaction.pressure: 1.5', 'compaction.target: 0.7'].join('\n'),
    );
    expect(cfg?.compaction).toEqual({ target: 0.7 });
  });

  it('drops a non-positive value', async () => {
    const cfg = await load([...base, 'compaction.pressure: 0'].join('\n'));
    expect(cfg?.compaction).toBeUndefined();
  });

  it('leaves compaction undefined when no keys are present (defaults unchanged)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.compaction).toBeUndefined();
  });

  it('parses the Item 7 absolute ceiling and user-tail keys', async () => {
    const cfg = await load(
      [...base, 'compaction.maxContextTokens: 400000', 'compaction.minTailUserMessages: 5'].join(
        '\n',
      ),
    );
    expect(cfg?.compaction).toEqual({ maxContextTokens: 400_000, minTailUserMessages: 5 });
  });

  it('drops a non-positive ceiling but keeps a zero user tail (0 = disabled)', async () => {
    const cfg = await load(
      [...base, 'compaction.maxContextTokens: 0', 'compaction.minTailUserMessages: 0'].join('\n'),
    );
    expect(cfg?.compaction).toEqual({ minTailUserMessages: 0 });
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      compaction: {
        pressure: 0.85,
        target: 0.6,
        maxContextTokens: 400_000,
        minTailUserMessages: 4,
      },
    };
    await writeConfig(storage, original);
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.compaction).toEqual(original.compaction);
  });
});
