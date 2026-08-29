// Lane 4a(d) — the `requestTimeoutMs` / `maxRetries` operator keys. Absent →
// the OpenAI SDK defaults (10-minute timeout, 2 retries) stay in force; the
// long default is deliberate (cold local model loads take minutes). Parse +
// serialize round-trip, with invalid values dropped so a typo cannot silently
// change client behavior.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

async function load(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return readRawConfig(storage);
}

const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

describe('requestTimeoutMs / maxRetries config keys (Lane 4a(d))', () => {
  it('parses a positive integer timeout and a non-negative retry count', async () => {
    const cfg = await load([...base, 'requestTimeoutMs: 120000', 'maxRetries: 0'].join('\n'));
    expect(cfg?.requestTimeoutMs).toBe(120_000);
    expect(cfg?.maxRetries).toBe(0);
  });

  it('both are absent when not set (SDK defaults stay in force)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.requestTimeoutMs).toBeUndefined();
    expect(cfg?.maxRetries).toBeUndefined();
  });

  it('drops zero, negative, and non-numeric timeouts', async () => {
    expect(
      (await load([...base, 'requestTimeoutMs: 0'].join('\n')))?.requestTimeoutMs,
    ).toBeUndefined();
    expect(
      (await load([...base, 'requestTimeoutMs: -5'].join('\n')))?.requestTimeoutMs,
    ).toBeUndefined();
    expect(
      (await load([...base, 'requestTimeoutMs: forever'].join('\n')))?.requestTimeoutMs,
    ).toBeUndefined();
  });

  it('drops negative, fractional, and non-numeric retry counts', async () => {
    expect((await load([...base, 'maxRetries: -1'].join('\n')))?.maxRetries).toBeUndefined();
    expect((await load([...base, 'maxRetries: 1.5'].join('\n')))?.maxRetries).toBeUndefined();
    expect((await load([...base, 'maxRetries: lots'].join('\n')))?.maxRetries).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
        requestTimeoutMs: 90_000,
        maxRetries: 4,
      },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.requestTimeoutMs).toBe(90_000);
    expect(cfg?.maxRetries).toBe(4);
  });

  it('writeConfig omits both keys when unset', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
      },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('requestTimeoutMs:');
    expect(raw).not.toContain('maxRetries:');
  });
});
