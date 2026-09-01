// Item 10 — `discord.missedMessageBackfill`: gate + bounds on the channel
// history the Discord adapter reads the first time it sees a lane.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('discord missed-message-backfill config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses all three fields', async () => {
    const cfg = await load(
      [
        ...base,
        'discord.missedMessageBackfill.enabled: true',
        'discord.missedMessageBackfill.windowSeconds: 3600',
        'discord.missedMessageBackfill.limit: 25',
      ].join('\n'),
    );
    expect(cfg?.discord).toEqual({
      missedMessageBackfill: { enabled: true, windowSeconds: 3600, limit: 25 },
    });
  });

  it('keeps an explicit false — the off switch is the point', async () => {
    const cfg = await load([...base, 'discord.missedMessageBackfill.enabled: false'].join('\n'));
    expect(cfg?.discord).toEqual({ missedMessageBackfill: { enabled: false } });
  });

  it('drops a limit past Discord own fetch ceiling and keeps the rest', async () => {
    const cfg = await load(
      [
        ...base,
        'discord.missedMessageBackfill.limit: 101',
        'discord.missedMessageBackfill.windowSeconds: 60',
      ].join('\n'),
    );
    expect(cfg?.discord).toEqual({ missedMessageBackfill: { windowSeconds: 60 } });

    const bad = await load([...base, 'discord.missedMessageBackfill.limit: some'].join('\n'));
    expect(bad?.discord).toBeUndefined();
  });

  it('does not collide with the legacy discordToken scalar', async () => {
    const cfg = await load(
      [...base, 'discordToken: abc123', 'discord.missedMessageBackfill.limit: 10'].join('\n'),
    );
    expect(cfg?.discordToken).toBe('abc123');
    expect(cfg?.discord).toEqual({ missedMessageBackfill: { limit: 10 } });
  });

  it('leaves discord undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.discord).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      discord: { missedMessageBackfill: { enabled: false, windowSeconds: 900, limit: 40 } },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.discord).toEqual(original.discord);
  });
});
