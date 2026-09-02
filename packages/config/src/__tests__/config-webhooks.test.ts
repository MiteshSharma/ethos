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

  it('parses events, eventHeader, and eventField', async () => {
    const cfg = await load(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.events: push, issue.opened',
        'webhooks.h.eventHeader: x-github-event',
        'webhooks.h.eventField: meta.event',
      ].join('\n'),
    );
    expect(cfg.webhooks?.h).toEqual({
      personalityId: 'researcher',
      secret: 'x',
      events: ['push', 'issue.opened'],
      eventHeader: 'x-github-event',
      eventField: 'meta.event',
    });
  });

  it('omits events, eventHeader, and eventField when not supplied', async () => {
    const cfg = await load(
      [...base, 'webhooks.h.personalityId: researcher', 'webhooks.h.secret: x'].join('\n'),
    );
    expect(cfg.webhooks?.h).toEqual({ personalityId: 'researcher', secret: 'x' });
  });

  it('rejects eventHeader without events as a parseError', async () => {
    const result = await loadStrict(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.eventHeader: x-github-event',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("eventHeader requires 'events'"))).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('rejects eventField without events as a parseError', async () => {
    const result = await loadStrict(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.eventField: meta.event',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("eventField requires 'events'"))).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('rejects an events value that parses to an empty list as a parseError', async () => {
    const result = await loadStrict(
      [
        ...base,
        'webhooks.h.personalityId: researcher',
        'webhooks.h.secret: x',
        'webhooks.h.events: ,',
      ].join('\n'),
    );
    expect(
      result?.parseErrors.some((e) => e.includes('events must list at least one event name')),
    ).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('round-trips events, eventHeader, and eventField through writeConfig → readConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      webhooks: {
        hook1: {
          personalityId: 'researcher',
          secret: 's3cret',
          events: ['push', 'issue.opened'],
          eventHeader: 'x-github-event',
          eventField: 'meta.event',
        },
        hook2: { personalityId: 'coder', secret: 'abc' },
      },
    };
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const reloaded = await readConfig(storage, secrets);
    expect(reloaded?.webhooks).toEqual(original.webhooks);
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

// ---------------------------------------------------------------------------
// Phase 2 — delivery targets + deliver-only mode.
// ---------------------------------------------------------------------------

describe('parseConfigYaml — webhooks deliver targets', () => {
  const hook = ['webhooks.h.personalityId: researcher', 'webhooks.h.secret: x'];

  it('parses a numbered platform target with an optional threadId', async () => {
    const cfg = await load(
      [
        ...base,
        ...hook,
        'webhooks.h.deliver.0.type: platform',
        'webhooks.h.deliver.0.adapterId: telegram:tg-a',
        'webhooks.h.deliver.0.chatId: 12345',
        'webhooks.h.deliver.0.threadId: t-7',
      ].join('\n'),
    );
    expect(cfg.webhooks?.h?.deliver).toEqual([
      { type: 'platform', adapterId: 'telegram:tg-a', chatId: '12345', threadId: 't-7' },
    ]);
  });

  it('orders targets numerically, not lexicographically', async () => {
    const lines = [...base, ...hook];
    for (const i of [0, 2, 10, 1]) {
      lines.push(`webhooks.h.deliver.${i}.type: platform`);
      lines.push(`webhooks.h.deliver.${i}.adapterId: a${i}`);
      lines.push(`webhooks.h.deliver.${i}.chatId: c${i}`);
    }
    // A gapless 0..10 run so only the ORDER is under test.
    for (const i of [3, 4, 5, 6, 7, 8, 9]) {
      lines.push(`webhooks.h.deliver.${i}.type: log`);
    }
    const cfg = await load(lines.join('\n'));
    const adapterIds = (cfg.webhooks?.h?.deliver ?? []).map((t) =>
      t.type === 'platform' ? t.adapterId : 'log',
    );
    expect(adapterIds).toEqual([
      'a0',
      'a1',
      'a2',
      'log',
      'log',
      'log',
      'log',
      'log',
      'log',
      'log',
      'a10',
    ]);
  });

  it('parses deliverOnly: true alongside a log target', async () => {
    const cfg = await load(
      [...base, ...hook, 'webhooks.h.deliverOnly: true', 'webhooks.h.deliver.0.type: log'].join(
        '\n',
      ),
    );
    expect(cfg.webhooks?.h?.deliverOnly).toBe(true);
    expect(cfg.webhooks?.h?.deliver).toEqual([{ type: 'log' }]);
  });

  it('treats deliverOnly: false as absent — same meaning, so the writer stays lossless', async () => {
    const cfg = await load([...base, ...hook, 'webhooks.h.deliverOnly: false'].join('\n'));
    expect(cfg.webhooks?.h).not.toHaveProperty('deliverOnly');
  });

  it('leaves deliver/deliverOnly undefined when no keys are present', async () => {
    const cfg = await load([...base, ...hook].join('\n'));
    expect(cfg.webhooks?.h).toEqual({ personalityId: 'researcher', secret: 'x' });
  });
});

describe('parseConfigYaml — webhooks deliver validation', () => {
  const hook = ['webhooks.h.personalityId: researcher', 'webhooks.h.secret: x'];

  const errorFor = async (lines: string[]): Promise<string[]> => {
    const result = await loadStrict([...base, ...hook, ...lines].join('\n'));
    return result?.parseErrors ?? [];
  };

  it('rejects an unknown target type', async () => {
    const errors = await errorFor(['webhooks.h.deliver.0.type: carrier-pigeon']);
    expect(errors.some((e) => e.includes("deliver.0.type must be 'log' or 'platform'"))).toBe(true);
  });

  it('rejects a target with no type at all', async () => {
    const errors = await errorFor(['webhooks.h.deliver.0.chatId: 12345']);
    expect(errors.some((e) => e.includes('deliver.0.type must be'))).toBe(true);
  });

  it('rejects a platform target missing adapterId or chatId', async () => {
    const errors = await errorFor([
      'webhooks.h.deliver.0.type: platform',
      'webhooks.h.deliver.0.chatId: 12345',
    ]);
    expect(errors.some((e) => e.includes('requires adapterId'))).toBe(true);

    const both = await errorFor(['webhooks.h.deliver.0.type: platform']);
    expect(both.some((e) => e.includes('requires adapterId, chatId'))).toBe(true);
  });

  it('rejects a log target given adapterId/chatId/threadId', async () => {
    const errors = await errorFor([
      'webhooks.h.deliver.0.type: log',
      'webhooks.h.deliver.0.chatId: 12345',
    ]);
    expect(errors.some((e) => e.includes("is a 'log' target and must not set chatId"))).toBe(true);
  });

  it('rejects deliverOnly with zero targets', async () => {
    const errors = await errorFor(['webhooks.h.deliverOnly: true']);
    expect(
      errors.some((e) => e.includes("deliverOnly requires at least one 'deliver' target")),
    ).toBe(true);
  });

  it('rejects a deliverOnly value that is neither true nor false', async () => {
    const errors = await errorFor(['webhooks.h.deliverOnly: yes']);
    expect(errors.some((e) => e.includes("deliverOnly must be 'true' or 'false'"))).toBe(true);
  });

  it('rejects a non-integer deliver index', async () => {
    const errors = await errorFor(['webhooks.h.deliver.first.type: log']);
    expect(errors.some((e) => e.includes("deliver index 'first' must be"))).toBe(true);
  });

  it('rejects a gapped index sequence', async () => {
    const errors = await errorFor([
      'webhooks.h.deliver.0.type: log',
      'webhooks.h.deliver.2.type: log',
    ]);
    expect(errors.some((e) => e.includes('deliver indexes must run 0..1 with no gaps'))).toBe(true);
  });

  it('drops the whole hook on a deliver error rather than half-configuring it', async () => {
    const result = await loadStrict(
      [...base, ...hook, 'webhooks.h.deliver.0.type: nope'].join('\n'),
    );
    expect(result?.config.webhooks).toBeUndefined();
  });
});

describe('writeConfig — webhooks deliver targets', () => {
  it('round-trips deliverOnly and every target field losslessly', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      webhooks: {
        relayOnly: {
          personalityId: 'researcher',
          secret: 's3cret',
          deliverOnly: true,
          deliver: [
            { type: 'log' },
            { type: 'platform', adapterId: 'telegram:tg-a', chatId: '12345', threadId: 't-7' },
            { type: 'platform', adapterId: 'email', chatId: 'ops@example.com' },
          ],
        },
        fanout: {
          personalityId: 'coder',
          secret: 'abc',
          mode: 'ack',
          deliver: [{ type: 'platform', adapterId: 'slack:sl-a', chatId: 'C123' }],
        },
      },
    };
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const reloaded = await readConfig(storage, secrets);
    expect(reloaded?.webhooks).toEqual(original.webhooks);
  });

  it('emits the numbered keys in index order', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        webhooks: {
          h: {
            personalityId: 'researcher',
            secret: 's',
            deliver: [{ type: 'platform', adapterId: 'a0', chatId: 'c0' }, { type: 'log' }],
          },
        },
      },
      secrets,
    );
    const yaml = await storage.read(join(ethosDir(), 'config.yaml'));
    const emitted = (yaml ?? '').split('\n').filter((l) => l.startsWith('webhooks.h.deliver'));
    expect(emitted).toEqual([
      'webhooks.h.deliver.0.type: platform',
      'webhooks.h.deliver.0.adapterId: a0',
      'webhooks.h.deliver.0.chatId: c0',
      'webhooks.h.deliver.1.type: log',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — HMAC payload signing.
// ---------------------------------------------------------------------------

describe('parseConfigYaml — webhooks hmac', () => {
  const hook = ['webhooks.h.personalityId: researcher', 'webhooks.h.secret: bearer'];

  it('parses the full nested hmac block', async () => {
    const cfg = await load(
      [
        ...base,
        ...hook,
        'webhooks.h.hmac.secret: signing',
        'webhooks.h.hmac.header: x-hub-signature-256',
        'webhooks.h.hmac.algorithm: sha512',
        'webhooks.h.hmac.previousSecret: old-signing',
      ].join('\n'),
    );
    expect(cfg.webhooks?.h?.hmac).toEqual({
      secret: 'signing',
      header: 'x-hub-signature-256',
      algorithm: 'sha512',
      previousSecret: 'old-signing',
    });
  });

  it('parses hmac.secret alone, leaving the optional keys off', async () => {
    const cfg = await load([...base, ...hook, 'webhooks.h.hmac.secret: signing'].join('\n'));
    expect(cfg.webhooks?.h?.hmac).toEqual({ secret: 'signing' });
  });

  it('leaves hmac undefined when no hmac keys are present', async () => {
    const cfg = await load([...base, ...hook].join('\n'));
    expect(cfg.webhooks?.h?.hmac).toBeUndefined();
  });

  it('does not disturb the mandatory bearer secret', async () => {
    const cfg = await load([...base, ...hook, 'webhooks.h.hmac.secret: signing'].join('\n'));
    expect(cfg.webhooks?.h?.secret).toBe('bearer');
  });
});

describe('parseConfigYaml — webhooks hmac validation', () => {
  const hook = ['webhooks.h.personalityId: researcher', 'webhooks.h.secret: bearer'];

  it.each([
    ['header', 'webhooks.h.hmac.header: x-sig'],
    ['algorithm', 'webhooks.h.hmac.algorithm: sha256'],
    ['previousSecret', 'webhooks.h.hmac.previousSecret: old'],
  ])('rejects hmac.%s without hmac.secret', async (_field, line) => {
    const result = await loadStrict([...base, ...hook, line].join('\n'));
    expect(
      (result?.parseErrors ?? []).some((e) => e.includes("missing required field 'hmac.secret'")),
    ).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('rejects an algorithm outside the allowlist and names the accepted values', async () => {
    const result = await loadStrict(
      [...base, ...hook, 'webhooks.h.hmac.secret: signing', 'webhooks.h.hmac.algorithm: md5'].join(
        '\n',
      ),
    );
    const message = (result?.parseErrors ?? []).find((e) => e.includes('hmac.algorithm'));
    expect(message).toContain('sha256, sha1, sha512');
    expect(result?.config.webhooks).toBeUndefined();
  });

  it.each(['sha256', 'sha1', 'sha512'])('accepts the allowlisted algorithm %s', async (algo) => {
    const result = await loadStrict(
      [
        ...base,
        ...hook,
        'webhooks.h.hmac.secret: signing',
        `webhooks.h.hmac.algorithm: ${algo}`,
      ].join('\n'),
    );
    expect(result?.parseErrors ?? []).toEqual([]);
    expect(result?.config.webhooks?.h?.hmac?.algorithm).toBe(algo);
  });
});

describe('writeConfig — webhooks hmac', () => {
  const original: EthosConfig = {
    provider: 'anthropic',
    model: 'm',
    apiKey: 'sk',
    personality: 'researcher',
    webhooks: {
      signed: {
        personalityId: 'researcher',
        secret: 'bearer',
        hmac: {
          secret: 'signing',
          header: 'x-hub-signature-256',
          algorithm: 'sha512',
          previousSecret: 'old-signing',
        },
      },
      plain: { personalityId: 'coder', secret: 'abc' },
    },
  };

  it('round-trips every hmac field losslessly', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const reloaded = await readConfig(storage, secrets);
    expect(reloaded?.webhooks).toEqual(original.webhooks);
  });

  it('externalizes hmac.secret and hmac.previousSecret to vault refs', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    // Neither signing secret may reach disk in plaintext — a `previousSecret`
    // in a rotation window is exactly as usable as the current one.
    const onDisk = await readRawConfig(storage);
    expect(onDisk?.webhooks?.signed?.hmac?.secret).toBe(secretRef('webhooks/signed/hmac/secret'));
    expect(onDisk?.webhooks?.signed?.hmac?.previousSecret).toBe(
      secretRef('webhooks/signed/hmac/previousSecret'),
    );
    const yaml = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(yaml).not.toContain('signing');
    expect(yaml).not.toContain('old-signing');
  });

  it('emits no hmac keys for a hook without an hmac block', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const yaml = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(yaml.split('\n').filter((l) => l.startsWith('webhooks.plain.hmac'))).toEqual([]);
  });
});

describe('parseConfigYaml — webhooks rateLimit', () => {
  const hook = ['webhooks.h.personalityId: researcher', 'webhooks.h.secret: bearer'];

  it('parses the full nested rateLimit block', async () => {
    const cfg = await load(
      [
        ...base,
        ...hook,
        'webhooks.h.rateLimit.maxPerMinute: 60',
        'webhooks.h.rateLimit.lockoutSeconds: 900',
      ].join('\n'),
    );
    expect(cfg.webhooks?.h?.rateLimit).toEqual({ maxPerMinute: 60, lockoutSeconds: 900 });
  });

  it('parses maxPerMinute alone, leaving lockoutSeconds off', async () => {
    const cfg = await load([...base, ...hook, 'webhooks.h.rateLimit.maxPerMinute: 5'].join('\n'));
    expect(cfg.webhooks?.h?.rateLimit).toEqual({ maxPerMinute: 5 });
  });

  it('leaves rateLimit undefined when no rateLimit keys are present', async () => {
    const cfg = await load([...base, ...hook].join('\n'));
    expect(cfg.webhooks?.h?.rateLimit).toBeUndefined();
  });
});

describe('parseConfigYaml — webhooks rateLimit validation', () => {
  const hook = ['webhooks.h.personalityId: researcher', 'webhooks.h.secret: bearer'];

  it('rejects lockoutSeconds without maxPerMinute', async () => {
    const result = await loadStrict(
      [...base, ...hook, 'webhooks.h.rateLimit.lockoutSeconds: 60'].join('\n'),
    );
    expect(
      (result?.parseErrors ?? []).some((e) =>
        e.includes("rateLimit.lockoutSeconds requires 'rateLimit.maxPerMinute'"),
      ),
    ).toBe(true);
    expect(result?.config.webhooks).toBeUndefined();
  });

  it.each(['0', '-1', '1.5', 'many', '100001'])('rejects maxPerMinute %s', async (value) => {
    const result = await loadStrict(
      [...base, ...hook, `webhooks.h.rateLimit.maxPerMinute: ${value}`].join('\n'),
    );
    const message = (result?.parseErrors ?? []).find((e) => e.includes('rateLimit.maxPerMinute'));
    expect(message).toContain('an integer between 1 and 100000');
    expect(result?.config.webhooks).toBeUndefined();
  });

  it.each(['0', '-1', '1.5', 'forever', '86401'])('rejects lockoutSeconds %s', async (value) => {
    const result = await loadStrict(
      [
        ...base,
        ...hook,
        'webhooks.h.rateLimit.maxPerMinute: 10',
        `webhooks.h.rateLimit.lockoutSeconds: ${value}`,
      ].join('\n'),
    );
    const message = (result?.parseErrors ?? []).find((e) => e.includes('rateLimit.lockoutSeconds'));
    expect(message).toContain('an integer between 1 and 86400');
    expect(result?.config.webhooks).toBeUndefined();
  });

  it('accepts the boundary values', async () => {
    const result = await loadStrict(
      [
        ...base,
        ...hook,
        'webhooks.h.rateLimit.maxPerMinute: 1',
        'webhooks.h.rateLimit.lockoutSeconds: 1',
      ].join('\n'),
    );
    expect(result?.parseErrors ?? []).toEqual([]);
    expect(result?.config.webhooks?.h?.rateLimit).toEqual({ maxPerMinute: 1, lockoutSeconds: 1 });
  });
});

describe('writeConfig — webhooks rateLimit', () => {
  const original: EthosConfig = {
    provider: 'anthropic',
    model: 'm',
    apiKey: 'sk',
    personality: 'researcher',
    webhooks: {
      limited: {
        personalityId: 'researcher',
        secret: 'bearer',
        rateLimit: { maxPerMinute: 60, lockoutSeconds: 900 },
      },
      capped: {
        personalityId: 'researcher',
        secret: 'bearer2',
        rateLimit: { maxPerMinute: 5 },
      },
      plain: { personalityId: 'coder', secret: 'abc' },
    },
  };

  it('round-trips every rateLimit field losslessly', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const reloaded = await readConfig(storage, secrets);
    expect(reloaded?.webhooks).toEqual(original.webhooks);
  });

  it('emits no rateLimit keys for a hook without a rateLimit block', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const yaml = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(yaml.split('\n').filter((l) => l.startsWith('webhooks.plain.rateLimit'))).toEqual([]);
  });
});
