// The `idleWatcher.<field>` operator block — the scale-to-zero watcher that
// aggregates every subsystem's busy state so a microVM host can be told it is
// safe to pause this process. An operator/deployment concern, not personality
// identity.
//
// Two parse hazards are pinned here:
//   * `Number('') === 0`, so a blank `*Ms` value would silently become a
//     zero-length threshold/cooldown — i.e. exit on the first sample. Blank
//     must fall through to the manager default instead.
//   * A typo must never arm the watcher, so both booleans are strict: only a
//     literal `true` is true.

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

describe('idleWatcher config block', () => {
  it('parses the full block', async () => {
    const cfg = await load(
      [
        ...base,
        'idleWatcher.enabled: true',
        'idleWatcher.idleThresholdMs: 120000',
        'idleWatcher.startupCooldownMs: 30000',
        'idleWatcher.checkIntervalMs: 15000',
        'idleWatcher.wakePathConfirmed: true',
      ].join('\n'),
    );
    expect(cfg?.idleWatcher).toEqual({
      enabled: true,
      idleThresholdMs: 120_000,
      startupCooldownMs: 30_000,
      checkIntervalMs: 15_000,
      wakePathConfirmed: true,
    });
  });

  it('is absent entirely when the block is not set', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.idleWatcher).toBeUndefined();
  });

  it('accepts a partial block and leaves the rest to defaults', async () => {
    const cfg = await load([...base, 'idleWatcher.enabled: true'].join('\n'));
    expect(cfg?.idleWatcher).toEqual({ enabled: true });
  });

  it('enabled with a junk value is false, never true', async () => {
    for (const raw of ['yes', 'TRUE', '1', 'on', 'flase']) {
      const cfg = await load([...base, `idleWatcher.enabled: ${raw}`].join('\n'));
      expect(cfg?.idleWatcher?.enabled).toBe(false);
    }
  });

  it('enabled with an empty quoted value is false, never true', async () => {
    const cfg = await load([...base, 'idleWatcher.enabled: ""'].join('\n'));
    expect(cfg?.idleWatcher?.enabled).toBe(false);
  });

  it('wakePathConfirmed is strict too — attestation is not guessed', async () => {
    const cfg = await load([...base, 'idleWatcher.wakePathConfirmed: maybe'].join('\n'));
    expect(cfg?.idleWatcher?.wakePathConfirmed).toBe(false);
  });

  it('treats an empty quoted *Ms value as absent, not as 0', async () => {
    const cfg = await load(
      [
        ...base,
        'idleWatcher.enabled: true',
        'idleWatcher.idleThresholdMs: ""',
        'idleWatcher.startupCooldownMs: ""',
        'idleWatcher.checkIntervalMs: ""',
      ].join('\n'),
    );
    expect(cfg?.idleWatcher).toEqual({ enabled: true });
  });

  it('treats a whitespace-only *Ms value as absent, not as 0', async () => {
    const cfg = await load(
      [...base, 'idleWatcher.enabled: true', 'idleWatcher.idleThresholdMs:   '].join('\n'),
    );
    expect(cfg?.idleWatcher?.idleThresholdMs).toBeUndefined();
  });

  it('drops zero, negative, fractional and non-numeric *Ms values', async () => {
    for (const raw of ['0', '-1', '1.5', 'soon']) {
      const cfg = await load(
        [...base, 'idleWatcher.enabled: true', `idleWatcher.checkIntervalMs: ${raw}`].join('\n'),
      );
      expect(cfg?.idleWatcher?.checkIntervalMs).toBeUndefined();
    }
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
        idleWatcher: {
          enabled: true,
          idleThresholdMs: 120_000,
          startupCooldownMs: 30_000,
          checkIntervalMs: 15_000,
          wakePathConfirmed: true,
        },
      },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.idleWatcher).toEqual({
      enabled: true,
      idleThresholdMs: 120_000,
      startupCooldownMs: 30_000,
      checkIntervalMs: 15_000,
      wakePathConfirmed: true,
    });
  });

  it('round-trips an explicit enabled: false without dropping it', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      {
        provider: 'ollama',
        model: 'llama3.2',
        apiKey: 'sk',
        personality: 'p',
        idleWatcher: { enabled: false },
      },
      new InMemorySecretsResolver(),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.idleWatcher).toEqual({ enabled: false });
  });

  it('writeConfig omits the block when unset', async () => {
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      { provider: 'ollama', model: 'llama3.2', apiKey: 'sk', personality: 'p' },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('idleWatcher.');
  });
});
