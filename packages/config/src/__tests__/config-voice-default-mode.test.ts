import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// `voice.defaultMode` — the voice-reply mode a NEW channel lane starts in.
//
// The gateway has always had a `defaultVoiceMode`, but nothing could set it
// from config.yaml, so the only reachable value was the built-in. These tests
// pin the key end to end: parsed, serialized, and round-trippable.

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(
    join(ethosDir(), 'config.yaml'),
    ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher', ...lines].join(
      '\n',
    ),
  );
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('voice.defaultMode', () => {
  it('is absent when the key is not declared — the built-in default applies', async () => {
    const cfg = await load([]);
    expect(cfg.voice?.defaultMode).toBeUndefined();
  });

  it.each(['off', 'mirror_inbound', 'all'] as const)('parses %s', async (mode) => {
    const cfg = await load([`voice.defaultMode: ${mode}`]);
    expect(cfg.voice?.defaultMode).toBe(mode);
  });

  it('ignores an unrecognized mode rather than inventing one', async () => {
    const cfg = await load(['voice.defaultMode: shout']);
    expect(cfg.voice?.defaultMode).toBeUndefined();
  });

  it('creates the voice section on its own, without any bots configured', async () => {
    const cfg = await load(['voice.defaultMode: all']);
    expect(cfg.voice?.bots).toEqual([]);
  });

  it('round-trips through writeConfig alongside the egress allowlist', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: { bots: [], trustedPlugins: ['openai-tts'], defaultMode: 'all' },
    };
    await writeConfig(storage, config, new InMemorySecretsResolver());
    const reread = await readRawConfig(storage);
    expect(reread?.voice?.defaultMode).toBe('all');
    expect(reread?.voice?.trustedPlugins).toEqual(['openai-tts']);
  });
});
