import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// channel_filter.<platform>.enable — per-platform explicit on/off switch.

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — channel_filter.<platform>.enable', () => {
  it('parses enable: false → channelFilter.telegram.enabled === false', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.enable: false',
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram).toEqual({ enabled: false });
  });

  it('parses enable: true → channelFilter.telegram.enabled === true', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.enable: true',
        'channel_filter.telegram.ownerUserId: owner-1',
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram.enabled).toBe(true);
    expect(cfg.channelFilter?.telegram.ownerUserId).toBe('owner-1');
  });

  it('leaves enabled unset when the enable key is absent', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'channel_filter.telegram.ownerUserId: owner-1',
      ].join('\n'),
    );
    expect(cfg.channelFilter?.telegram.enabled).toBeUndefined();
  });
});

describe('writeConfig — channel_filter.<platform>.enable round-trip', () => {
  it('serializes enable: false and round-trips', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      channelFilter: { telegram: { enabled: false, ownerUserId: 'owner-1' } },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('channel_filter.telegram.enable: false');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.channelFilter?.telegram.enabled).toBe(false);
  });

  it('does not emit the enable line when enabled is true', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk',
        personality: 'researcher',
        channelFilter: { telegram: { enabled: true, ownerUserId: 'owner-1' } },
      },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('channel_filter.telegram.enable');
  });

  it('does not emit the enable line when enabled is unset', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk',
        personality: 'researcher',
        channelFilter: { telegram: { ownerUserId: 'owner-1' } },
      },
      new InMemorySecretsResolver(),
    );
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('channel_filter.telegram.enable');
  });
});
