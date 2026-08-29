import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// `voice.trustedPlugins` — the local-only voice-egress allowlist.
//
// The key's PRESENCE arms the gate, so "declared but empty" and "absent" are
// two different states and the parser/serializer must keep them apart.

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

describe('voice.trustedPlugins', () => {
  it('is undefined when the key is absent — the gate stays off', async () => {
    const cfg = await load([]);
    expect(cfg.voice).toBeUndefined();
  });

  it('parses a comma-separated allowlist', async () => {
    const cfg = await load(['voice.trustedPlugins: openai-tts, elevenlabs']);
    expect(cfg.voice?.trustedPlugins).toEqual(['openai-tts', 'elevenlabs']);
  });

  it('keeps a declared-but-empty list distinct from an absent key', async () => {
    const cfg = await load(['voice.trustedPlugins:']);
    expect(cfg.voice?.trustedPlugins).toEqual([]);
  });

  it('coexists with voice.bots and the LiveKit block', async () => {
    const cfg = await load([
      'voice.bots.0.match: +15551234567',
      'voice.bots.0.bind.type: personality',
      'voice.bots.0.bind.name: receptionist',
      'voice.trustedPlugins: openai-stt',
    ]);
    expect(cfg.voice?.bots).toHaveLength(1);
    expect(cfg.voice?.trustedPlugins).toEqual(['openai-stt']);
  });

  it('round-trips through writeConfig -> readRawConfig, including the empty list', async () => {
    for (const trustedPlugins of [['openai-tts'], []]) {
      const original: EthosConfig = {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        voice: { bots: [], trustedPlugins },
      };
      const storage = new InMemoryStorage();
      await storage.mkdir(ethosDir());
      await writeConfig(storage, original, new InMemorySecretsResolver());
      const reloaded = await readRawConfig(storage);
      expect(reloaded?.voice?.trustedPlugins).toEqual(trustedPlugins);
    }
  });
});

describe('auxiliary.asr/tts command templates', () => {
  it('parses and round-trips the command recipe for command-stt / command-tts', async () => {
    const cfg = await load([
      'auxiliary.asr.provider: command-stt',
      'auxiliary.asr.command: whisper-cli -f {input_path} -otxt -of {output_path}',
      'auxiliary.tts.provider: command-tts',
      'auxiliary.tts.command: say -o {output_path} -f {input_path}',
    ]);
    expect(cfg.auxiliary?.asr).toMatchObject({
      provider: 'command-stt',
      command: 'whisper-cli -f {input_path} -otxt -of {output_path}',
    });
    expect(cfg.auxiliary?.tts).toMatchObject({
      provider: 'command-tts',
      command: 'say -o {output_path} -f {input_path}',
    });

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.auxiliary?.asr?.command).toBe(cfg.auxiliary?.asr?.command);
    expect(reloaded?.auxiliary?.tts?.command).toBe(cfg.auxiliary?.tts?.command);
  });
});
