import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// `voice.filler.*` — the tool-call filler/tick keep-alive `VoiceSession` plays
// during a long tool call. A global operator setting (plan/phases/voice-live-personality.md
// §9), not a per-surface tuner like `voice.bargeIn` — these tests pin the four
// keys end to end: parsed, range-checked, and round-trippable.

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

describe('voice.filler', () => {
  it('is absent when no key is declared — the built-in defaults apply', async () => {
    const cfg = await load([]);
    expect(cfg.voice?.filler).toBeUndefined();
  });

  it('parses enabled/afterMs/text/tickIntervalMs', async () => {
    const cfg = await load([
      'voice.filler.enabled: false',
      'voice.filler.afterMs: 800',
      'voice.filler.text: One sec.',
      'voice.filler.tickIntervalMs: 5000',
    ]);
    expect(cfg.voice?.filler).toEqual({
      enabled: false,
      afterMs: 800,
      text: 'One sec.',
      tickIntervalMs: 5000,
    });
  });

  it('ignores an out-of-range afterMs rather than clamping it', async () => {
    const cfg = await load(['voice.filler.afterMs: -5']);
    expect(cfg.voice?.filler?.afterMs).toBeUndefined();
  });

  it('ignores an out-of-range tickIntervalMs rather than clamping it', async () => {
    const cfg = await load(['voice.filler.tickIntervalMs: 999999']);
    expect(cfg.voice?.filler?.tickIntervalMs).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [],
        filler: { enabled: true, afterMs: 600, text: 'Let me check that.', tickIntervalMs: 4000 },
      },
    };
    await writeConfig(storage, config, new InMemorySecretsResolver());
    const reread = await readRawConfig(storage);
    expect(reread?.voice?.filler).toEqual({
      enabled: true,
      afterMs: 600,
      text: 'Let me check that.',
      tickIntervalMs: 4000,
    });
  });
});
