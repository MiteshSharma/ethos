import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

// Context-economy Phase 1 — channel_toolsets.<platform>: <tool,list> (static
// per-channel toolset narrowing for the gateway).

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(
    join(ethosDir(), 'config.yaml'),
    [
      'provider: anthropic',
      'model: claude-opus-4-7',
      'apiKey: sk',
      'personality: researcher',
      ...lines,
    ].join('\n'),
  );
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — channel_toolsets', () => {
  it('parses a comma-separated tool list per platform (whitespace tolerated)', async () => {
    const cfg = await load([
      'channel_toolsets.whatsapp: read_file, memory_read',
      'channel_toolsets.telegram: web_search',
    ]);
    expect(cfg.channelToolsets).toEqual({
      whatsapp: ['read_file', 'memory_read'],
      telegram: ['web_search'],
    });
  });

  it('is undefined when no channel_toolsets keys are present', async () => {
    const cfg = await load([]);
    expect(cfg.channelToolsets).toBeUndefined();
  });
});

describe('writeConfig — channel_toolsets round-trip', () => {
  it('serializes one line per platform and round-trips', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      channelToolsets: { whatsapp: ['read_file', 'memory_read'] },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('channel_toolsets.whatsapp: read_file,memory_read');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.channelToolsets).toEqual(original.channelToolsets);
  });
});
