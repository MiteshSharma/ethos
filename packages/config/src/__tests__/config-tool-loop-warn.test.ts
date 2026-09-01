// Item 12 — `toolLoop.maxToolCallsWarnAt` / `toolLoop.maxIdenticalToolCallsWarnAt`:
// soft-warn tiers under the agent loop's hard tool-call caps.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('toolLoop soft-warn config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses both thresholds', async () => {
    const cfg = await load(
      [...base, 'toolLoop.maxToolCallsWarnAt: 40', 'toolLoop.maxIdenticalToolCallsWarnAt: 10'].join(
        '\n',
      ),
    );
    expect(cfg?.toolLoop).toEqual({ maxToolCallsWarnAt: 40, maxIdenticalToolCallsWarnAt: 10 });
  });

  it('parses a single threshold on its own', async () => {
    const cfg = await load([...base, 'toolLoop.maxToolCallsWarnAt: 12'].join('\n'));
    expect(cfg?.toolLoop).toEqual({ maxToolCallsWarnAt: 12 });
  });

  it('drops a non-positive or non-numeric threshold and keeps the rest', async () => {
    const cfg = await load(
      [...base, 'toolLoop.maxToolCallsWarnAt: 0', 'toolLoop.maxIdenticalToolCallsWarnAt: 8'].join(
        '\n',
      ),
    );
    expect(cfg?.toolLoop).toEqual({ maxIdenticalToolCallsWarnAt: 8 });
    const bad = await load([...base, 'toolLoop.maxToolCallsWarnAt: soon'].join('\n'));
    expect(bad?.toolLoop).toBeUndefined();
  });

  it('leaves toolLoop undefined when no keys are present (no warn tier)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.toolLoop).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      toolLoop: { maxToolCallsWarnAt: 40, maxIdenticalToolCallsWarnAt: 10 },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.toolLoop).toEqual(original.toolLoop);
  });
});
