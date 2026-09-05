// R4 — `retention.channelTranscript`, the TTL on observe-mode transcripts.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { configParseNotices, ethosDir, readRawConfig, writeConfig } from '../index';

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

// F4 — a malformed duration used to survive the load untouched and then throw
// inside the nightly `observability-prune` handler, which silently disabled
// pruning for EVERY category. It is now dropped at load with a parse warning.
describe('retention duration validation', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('drops a malformed duration and warns, keeping the well-formed siblings', async () => {
    const cfg = await load(
      [...base, 'retention.messages: 90d', 'retention.channelTranscript: 30days'].join('\n'),
    );
    expect(cfg?.retention).toEqual({ messages: '90d' });
    const warnings = cfg ? configParseNotices(cfg).warnings : [];
    expect(warnings.join('\n')).toContain('retention.channelTranscript: "30days"');
    // Dropped, never fatal: the config still loads.
    expect(cfg ? configParseNotices(cfg).errors : ['unreachable']).toEqual([]);
  });

  it('rejects `12h` — the value the config.yaml reference used to advertise', async () => {
    const cfg = await load([...base, 'retention.blobs: 12h'].join('\n'));
    expect(cfg?.retention?.blobs).toBeUndefined();
    expect((cfg ? configParseNotices(cfg).warnings : []).join('\n')).toContain('retention.blobs');
  });

  it('names the personality override key it dropped', async () => {
    const cfg = await load(
      [...base, 'personalities.researcher.retention.messages: soon'].join('\n'),
    );
    // The override is gone, so the personality inherits the global window.
    // (The empty `retention` object survives — that is the pre-existing shape
    // for a `retention.*` block whose keys were all unrecognised, unchanged.)
    expect(cfg?.personalitiesConfig?.researcher?.retention?.messages).toBeUndefined();
    expect((cfg ? configParseNotices(cfg).warnings : []).join('\n')).toContain(
      'personalities.researcher.retention.messages: "soon"',
    );
  });

  it('warns for an events subkey too', async () => {
    const cfg = await load([...base, 'retention.events.audit: 1 year'].join('\n'));
    expect(cfg?.retention?.events).toBeUndefined();
    expect((cfg ? configParseNotices(cfg).warnings : []).join('\n')).toContain(
      'retention.events.audit',
    );
  });

  it('leaves every valid value alone and warns about nothing', async () => {
    const cfg = await load(
      [
        ...base,
        'retention.messages: forever',
        'retention.traces: 12w',
        'retention.events.install: 2y',
      ].join('\n'),
    );
    expect(cfg?.retention).toEqual({
      messages: 'forever',
      traces: '12w',
      events: { install: '2y' },
    });
    expect(cfg ? configParseNotices(cfg).warnings : ['unreachable']).toEqual([]);
  });
});
