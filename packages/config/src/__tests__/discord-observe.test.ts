// Discord channel-mode parity: a `discord.defaultChannelMode` key an operator
// can actually write, so observe mode is reachable on Discord at all
// (plan/phases/ambient-group-monitoring.md §3).
//
// Discord is single-bot — its credential is the top-level `discordToken`, not
// an indexed `discord.bots.<n>.*` roster — so the key is top-level too,
// alongside the `discord.missedMessageBackfill.*` knobs it must not disturb.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  observeModePlatforms,
  readRawConfig,
  writeConfig,
} from '../index';

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];

async function storageWith(lines: string[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  return storage;
}

/**
 * Exactly `ChannelModeSchema` in `extensions/platform-discord/src/config.ts`.
 * Discord, unlike Telegram, has no `regex_match` — giving it one here would
 * validate a mode its adapter cannot honour.
 */
const DISCORD_MODES = ['mention_only', 'thread_follow', 'all', 'observe'] as const;

describe('discord.defaultChannelMode', () => {
  it('parses observe', async () => {
    const storage = await storageWith(['discord.defaultChannelMode: observe']);
    const cfg = await readRawConfig(storage);
    expect(cfg?.discord?.defaultChannelMode).toBe('observe');
  });

  it.each(DISCORD_MODES)("accepts %s, the adapter's own mode set", async (mode) => {
    const storage = await storageWith([`discord.defaultChannelMode: ${mode}`]);
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toEqual([]);
    expect(loaded?.config.discord?.defaultChannelMode).toBe(mode);
  });

  // Telegram's enum has it; Discord's does not. Accepting it would hand the
  // adapter a mode it would silently fall through on.
  it('rejects regex_match, which is Telegram-only', async () => {
    const storage = await storageWith(['discord.defaultChannelMode: regex_match']);
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.config.discord?.defaultChannelMode).toBeUndefined();
    expect(loaded?.parseErrors.join('\n')).toContain(
      "discord: invalid defaultChannelMode 'regex_match'",
    );
  });

  it('rejects an unknown mode and names every accepted one', async () => {
    const storage = await storageWith(['discord.defaultChannelMode: lurk']);
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toContain(
      "discord: invalid defaultChannelMode 'lurk' (expected 'mention_only', 'thread_follow', 'all' or 'observe').",
    );
    for (const mode of DISCORD_MODES) {
      expect(loaded?.parseErrors.join('\n')).toContain(`'${mode}'`);
    }
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'p',
      discord: { defaultChannelMode: 'observe' },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('discord.defaultChannelMode: observe');
    expect((await readRawConfig(storage))?.discord).toEqual(original.discord);
  });

  // The two live under the same `discord:` block and are parsed by different
  // patterns; neither may swallow the other.
  it('coexists with discord.missedMessageBackfill.* keys', async () => {
    const storage = await storageWith([
      'discord.defaultChannelMode: observe',
      'discord.missedMessageBackfill.enabled: false',
      'discord.missedMessageBackfill.limit: 25',
    ]);
    const cfg = await readRawConfig(storage);
    expect(cfg?.discord).toEqual({
      defaultChannelMode: 'observe',
      missedMessageBackfill: { enabled: false, limit: 25 },
    });
  });
});

describe('observeModePlatforms — discord', () => {
  it('reports discord when the configured default is observe', async () => {
    const storage = await storageWith(['discord.defaultChannelMode: observe']);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not load');
    expect(observeModePlatforms(cfg)).toContain('discord');
  });

  it('does not report discord on any answering mode', async () => {
    for (const mode of ['mention_only', 'thread_follow', 'all'] as const) {
      const storage = await storageWith([`discord.defaultChannelMode: ${mode}`]);
      const cfg = await readRawConfig(storage);
      if (!cfg) throw new Error('config did not load');
      expect(observeModePlatforms(cfg)).not.toContain('discord');
    }
  });

  it('reports discord alongside the other observed platforms', async () => {
    const storage = await storageWith([
      'discord.defaultChannelMode: observe',
      'whatsapp.0.id: wa1',
      'whatsapp.0.default_mode: observe',
    ]);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not load');
    expect(observeModePlatforms(cfg).sort()).toEqual(['discord', 'whatsapp']);
  });
});
