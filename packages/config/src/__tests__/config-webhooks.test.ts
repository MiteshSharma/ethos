import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readConfig,
  readRawConfig,
  writeConfig,
} from '../index';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

async function loadStrict(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return loadConfigStrict(storage);
}

const base = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

describe('parseConfigYaml — webhooks', () => {
  it('parses a webhooks block with personalityId, secret, and sessionKey', async () => {
    const cfg = await load(
      [
        ...base,
        'webhooks.hook1.personalityId: researcher',
        'webhooks.hook1.secret: s3cret',
        'webhooks.hook1.sessionKey: stable-key',
      ].join('\n'),
    );
    expect(cfg.webhooks).toEqual({
      hook1: { personalityId: 'researcher', secret: 's3cret', sessionKey: 'stable-key' },
    });
  });

  it('omits sessionKey when not supplied', async () => {
    const cfg = await load(
      [...base, 'webhooks.h.personalityId: researcher', 'webhooks.h.secret: x'].join('\n'),
    );
    expect(cfg.webhooks?.h).toEqual({ personalityId: 'researcher', secret: 'x' });
  });

  it('leaves webhooks undefined when no block is present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg.webhooks).toBeUndefined();
  });

  it('reports a missing secret as a parseError', async () => {
    const result = await loadStrict(
      [...base, 'webhooks.broken.personalityId: researcher'].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'secret'"))).toBe(
      true,
    );
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('parses prefilter, prefilterTimeoutSeconds, and mode', async () => {
    const cfg = await load(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.prefilter: gate.sh',
        'webhooks.h.prefilterTimeoutSeconds: 15',
        'webhooks.h.mode: ack',
      ].join('\n'),
    );
    expect(cfg.webhooks?.h).toEqual({
      personalityId: 'researcher',
      secret: 'x',
      prefilter: 'gate.sh',
      prefilterTimeoutSeconds: 15,
      mode: 'ack',
    });
  });

  it('rejects an unknown mode as a parseError', async () => {
    const result = await loadStrict(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.mode: async',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("mode must be 'sync' or 'ack'"))).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('rejects an out-of-range prefilterTimeoutSeconds as a parseError', async () => {
    const result = await loadStrict(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.prefilter: gate.sh',
        'webhooks.h.prefilterTimeoutSeconds: 601',
      ].join('\n'),
    );
    expect(
      result?.parseErrors.some((e) =>
        e.includes('prefilterTimeoutSeconds must be an integer between 1 and 600'),
      ),
    ).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('rejects prefilterTimeoutSeconds without prefilter as a parseError', async () => {
    const result = await loadStrict(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.prefilterTimeoutSeconds: 30',
      ].join('\n'),
    );
    expect(
      result?.parseErrors.some((e) => e.includes("prefilterTimeoutSeconds requires 'prefilter'")),
    ).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('round-trips through writeConfig → readConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      webhooks: {
        hook1: { personalityId: 'researcher', secret: 's3cret', sessionKey: 'stable-key' },
        hook2: { personalityId: 'coder', secret: 'abc' },
        hook3: {
          personalityId: 'ops',
          secret: 'def',
          prefilter: 'gate.sh',
          prefilterTimeoutSeconds: 45,
          mode: 'ack',
        },
      },
    };
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    // Bearer secrets are externalized — the file holds refs, the vault the values.
    const onDisk = await readRawConfig(storage);
    expect(onDisk?.webhooks?.hook1?.secret).toBe(secretRef('webhooks/hook1/secret'));
    expect(onDisk?.webhooks?.hook3?.secret).toBe(secretRef('webhooks/hook3/secret'));
    const reloaded = await readConfig(storage, secrets);
    expect(reloaded?.webhooks).toEqual(original.webhooks);
  });
});
