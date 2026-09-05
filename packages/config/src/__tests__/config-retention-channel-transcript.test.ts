// R4 — `retention.channelTranscript`, the TTL on observe-mode transcripts.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('retention.channelTranscript', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses the key alongside the other TTLs', async () => {
    const cfg = await load(
      [...base, 'retention.messages: 90d', 'retention.channelTranscript: 7d'].join('\n'),
    );
    expect(cfg?.retention).toEqual({ messages: '90d', channelTranscript: '7d' });
  });

  it('is absent when unset, so the 30d default applies', async () => {
    const cfg = await load([...base, 'retention.messages: 90d'].join('\n'));
    expect(cfg?.retention?.channelTranscript).toBeUndefined();
    expect(RETENTION_DEFAULTS.channelTranscript).toBe('30d');
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      retention: { channelTranscript: 'forever' },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.retention).toEqual(original.retention);
  });
});
