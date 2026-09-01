// Item 11 — `browser.navigationTimeoutMs` / `browser.commandTimeoutMs`:
// the Playwright budgets the browser toolset used to hardcode.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('browser timeout config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses both timeouts', async () => {
    const cfg = await load(
      [...base, 'browser.navigationTimeoutMs: 45000', 'browser.commandTimeoutMs: 5000'].join('\n'),
    );
    expect(cfg?.browser).toEqual({ navigationTimeoutMs: 45000, commandTimeoutMs: 5000 });
  });

  it('parses a single timeout on its own', async () => {
    const cfg = await load([...base, 'browser.commandTimeoutMs: 20000'].join('\n'));
    expect(cfg?.browser).toEqual({ commandTimeoutMs: 20000 });
  });

  it('drops out-of-range and non-numeric values, keeping the rest', async () => {
    const cfg = await load(
      [...base, 'browser.navigationTimeoutMs: 999', 'browser.commandTimeoutMs: 10000'].join('\n'),
    );
    expect(cfg?.browser).toEqual({ commandTimeoutMs: 10000 });

    const tooBig = await load([...base, 'browser.navigationTimeoutMs: 600001'].join('\n'));
    expect(tooBig?.browser).toBeUndefined();

    const nonNumeric = await load([...base, 'browser.commandTimeoutMs: forever'].join('\n'));
    expect(nonNumeric?.browser).toBeUndefined();
  });

  it('leaves browser undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.browser).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      browser: { navigationTimeoutMs: 60000, commandTimeoutMs: 15000 },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.browser).toEqual(original.browser);
  });
});
