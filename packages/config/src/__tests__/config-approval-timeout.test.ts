// The `approvalTimeoutMs` operator key — how long a dangerous tool call may
// sit waiting for a human Allow/Deny before it is auto-denied. Absent → each
// approval store's own 10-minute default.
//
// The one asymmetry with `requestTimeoutMs`: `0` is MEANINGFUL here ("no
// timeout, wait forever", the same convention `ApprovalCoordinator` already
// uses internally), so the parser accepts `n >= 0` rather than `n > 0`.

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

describe('approvalTimeoutMs config key', () => {
  it('parses a positive millisecond count', async () => {
    const cfg = await load([...base, 'approvalTimeoutMs: 1800000'].join('\n'));
    expect(cfg?.approvalTimeoutMs).toBe(1_800_000);
  });

  it('keeps 0 — it means "no timeout", not a typo', async () => {
    const cfg = await load([...base, 'approvalTimeoutMs: 0'].join('\n'));
    expect(cfg?.approvalTimeoutMs).toBe(0);
  });

  it('is absent when not set (each store keeps its own default)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.approvalTimeoutMs).toBeUndefined();
  });

  it('drops negative and non-numeric values', async () => {
    expect(
      (await load([...base, 'approvalTimeoutMs: -5'].join('\n')))?.approvalTimeoutMs,
    ).toBeUndefined();
    expect(
      (await load([...base, 'approvalTimeoutMs: forever'].join('\n')))?.approvalTimeoutMs,
    ).toBeUndefined();
  });

  it('treats an empty quoted value as absent, not as 0', async () => {
    const cfg = await load([...base, 'approvalTimeoutMs: ""'].join('\n'));
    expect(cfg?.approvalTimeoutMs).toBeUndefined();
  });

  it('treats a whitespace-only value as absent, not as 0', async () => {
    const cfg = await load([...base, 'approvalTimeoutMs:   '].join('\n'));
    expect(cfg?.approvalTimeoutMs).toBeUndefined();
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
        approvalTimeoutMs: 0,
      },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.approvalTimeoutMs).toBe(0);
  });

  it('writeConfig omits the key when unset', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      { provider: 'ollama', model: 'llama3.2', apiKey: 'sk', personality: 'p' },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('approvalTimeoutMs:');
  });
});
