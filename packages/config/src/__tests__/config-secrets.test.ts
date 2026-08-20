import { join } from 'node:path';
import {
  EnvSecretsResolver,
  InMemorySecretsResolver,
  InMemoryStorage,
  MergedSecretsResolver,
} from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveBotKey,
  type EthosConfig,
  ethosDir,
  type KeyProfile,
  readConfig,
  readKeys,
  readRawConfig,
  rotationSecretRef,
  secretRefFromValue,
  writeConfig,
  writeKeys,
} from '../index';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('secrets ref substitution in config', () => {
  async function load(yaml: string, secrets: InMemorySecretsResolver) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readConfig(storage, secrets);
  }

  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    `apiKey: ${secretRef('providers/anthropic/apiKey')}`,
    'personality: researcher',
  ];

  it('resolves apiKey from secrets', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-real-key');
    const cfg = await load(base.join('\n'), secrets);
    expect(cfg?.apiKey).toBe('sk-ant-real-key');
  });

  it('throws when secret ref is missing', async () => {
    const secrets = new InMemorySecretsResolver();
    await expect(load(base.join('\n'), secrets)).rejects.toThrow('Secret not found');
  });

  it('resolves secrets in provider chain', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('providers/openrouter/apiKey', 'sk-or-123');
    const yaml = [
      ...base,
      'providers.0.provider: openrouter',
      `providers.0.apiKey: ${secretRef('providers/openrouter/apiKey')}`,
      'providers.0.model: gpt-5',
    ].join('\n');
    const cfg = await load(yaml, secrets);
    const first = cfg?.providers?.[0];
    expect(first?.apiKey).toBe('sk-or-123');
  });

  it('resolves secrets in telegram bot tokens', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('telegram/token', '123:ABC');
    const yaml = [
      ...base,
      `telegram.bots.0.token: ${secretRef('telegram/token')}`,
      'telegram.bots.0.bind.type: personality',
      'telegram.bots.0.bind.name: researcher',
    ].join('\n');
    const cfg = await load(yaml, secrets);
    expect(cfg?.telegram?.bots[0]?.token).toBe('123:ABC');
  });

  it('resolves secrets in slack app config', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('slack/botToken', 'xoxb-123');
    await secrets.set('slack/appToken', 'xapp-456');
    await secrets.set('slack/signingSecret', 'sec-789');
    const yaml = [
      ...base,
      `slack.apps.0.botToken: ${secretRef('slack/botToken')}`,
      `slack.apps.0.appToken: ${secretRef('slack/appToken')}`,
      `slack.apps.0.signingSecret: ${secretRef('slack/signingSecret')}`,
      'slack.apps.0.bind.type: personality',
      'slack.apps.0.bind.name: researcher',
    ].join('\n');
    const cfg = await load(yaml, secrets);
    const app = cfg?.slack?.apps[0];
    expect(app?.botToken).toBe('xoxb-123');
    expect(app?.appToken).toBe('xapp-456');
    expect(app?.signingSecret).toBe('sec-789');
  });

  it('resolves secrets in auxiliary compression apiKey', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-ant-main');
    await secrets.set('auxiliary/compression-key', 'sk-aux-comp');
    const yaml = [
      ...base,
      'auxiliary.compression.model: claude-haiku-4-5-20251001',
      `auxiliary.compression.apiKey: ${secretRef('auxiliary/compression-key')}`,
    ].join('\n');
    const cfg = await load(yaml, secrets);
    expect(cfg?.auxiliary?.compression?.apiKey).toBe('sk-aux-comp');
  });

  it('does not mutate original parsed config', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-resolved');
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      `provider: anthropic\nmodel: m\napiKey: ${secretRef('providers/anthropic/apiKey')}\npersonality: p\n`,
    );
    const raw = await readRawConfig(storage);
    const resolved = await readConfig(storage, secrets);
    expect(raw?.apiKey).toBe(secretRef('providers/anthropic/apiKey'));
    expect(resolved?.apiKey).toBe('sk-resolved');
  });

  it('readRawConfig returns unresolved refs', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      'provider: anthropic\nmodel: claude-opus-4-7\napiKey: sk-plain\npersonality: p\n',
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.apiKey).toBe('sk-plain');
  });
});

describe('readKeys with secrets resolution', () => {
  it('resolves secret refs in key apiKey fields', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('rotation/backup', 'sk-ant-rotated');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'keys.json'),
      JSON.stringify([{ apiKey: secretRef('rotation/backup'), priority: 50, label: 'backup' }]),
    );
    const keys = await readKeys(storage, secrets);
    expect(keys[0]?.apiKey).toBe('sk-ant-rotated');
  });

  it('works without secrets resolver', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'keys.json'),
      JSON.stringify([{ apiKey: 'sk-plain', priority: 50 }]),
    );
    const keys = await readKeys(storage);
    expect(keys[0]?.apiKey).toBe('sk-plain');
  });
});

// ---------------------------------------------------------------------------
// writeKeys externalization — the same G-SEC guarantee for ~/.ethos/keys.json
// that writeConfig gives config.yaml. The read path above already resolved
// refs; these cover the write path that used to serialize key VALUES.
// ---------------------------------------------------------------------------

describe('writeKeys externalizes rotation key material', () => {
  const pool: KeyProfile[] = [
    { apiKey: 'PLAIN-primary', priority: 100, label: 'primary' },
    { apiKey: 'PLAIN-backup', priority: 50, label: 'backup' },
    { apiKey: 'PLAIN-unlabelled', priority: 10 },
  ];

  async function fixture() {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    return { storage, secrets };
  }

  it('writes no plaintext key and round-trips every value through the vault', async () => {
    const { storage, secrets } = await fixture();

    await writeKeys(storage, pool, secrets);

    // Assert on the raw file text — not the parsed objects.
    const raw = (await storage.read(join(ethosDir(), 'keys.json'))) ?? '';
    expect(raw).not.toContain('PLAIN-');

    const readBack = await readKeys(storage, secrets);
    expect(readBack).toEqual(pool);
  });

  it('keys the ref on a stable identity, not the array index', async () => {
    const { storage, secrets } = await fixture();
    await writeKeys(storage, pool, secrets);
    const refs = (await secrets.list()).sort();
    expect(refs).toEqual(pool.map((k) => `rotation/${deriveBotKey({ token: k.apiKey })}`).sort());

    // Reordering the pool must reuse the same refs, not mint a second set.
    const reordered = [...pool].reverse();
    await writeKeys(storage, reordered, secrets);
    expect((await secrets.list()).sort()).toEqual(refs);
    expect(await readKeys(storage, secrets)).toEqual(reordered);
  });

  it('is idempotent — a second write neither re-wraps nor re-mints a ref', async () => {
    const { storage, secrets } = await fixture();
    await writeKeys(storage, pool, secrets);

    const firstRaw = await storage.read(join(ethosDir(), 'keys.json'));
    const firstRefs = (await secrets.list()).sort();

    // Round-trip the written file back through the writer, the way `ethos
    // keys add` / `remove` do (readKeys without a resolver → writeKeys).
    const roundTripped = await readKeys(storage);
    await writeKeys(storage, roundTripped, secrets);

    expect(await storage.read(join(ethosDir(), 'keys.json'))).toBe(firstRaw);
    expect((await secrets.list()).sort()).toEqual(firstRefs);
    // A re-wrapped ref would nest one inside another.
    expect(firstRaw).not.toContain('secrets:$');
  });

  it('fails loudly when the resolver cannot store the key', async () => {
    const { storage } = await fixture();
    const failing: SecretsResolver = {
      get: async () => null,
      set: async () => {
        throw new Error('vault is read-only');
      },
      delete: async () => {},
      list: async () => [],
    };

    await expect(writeKeys(storage, pool, failing)).rejects.toThrow('vault is read-only');

    // Nothing reached disk — a failed externalization must not fall back to
    // writing the plaintext value.
    expect(await storage.read(join(ethosDir(), 'keys.json'))).toBeNull();
  });
});

describe('rotationSecretRef', () => {
  it('reads back the ref the writer minted', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeKeys(storage, [{ apiKey: 'PLAIN-primary', priority: 100 }], secrets);

    const [written] = await readKeys(storage);
    expect(written && rotationSecretRef(written)).toBe(
      `rotation/${deriveBotKey({ token: 'PLAIN-primary' })}`,
    );
  });

  it('shares one ref between two profiles holding the same key value', () => {
    const ref = secretRef('rotation/shared');
    expect(rotationSecretRef({ apiKey: ref, priority: 100, label: 'a' })).toBe('rotation/shared');
    expect(rotationSecretRef({ apiKey: ref, priority: 10, label: 'b' })).toBe('rotation/shared');
  });

  it('returns null for a legacy plaintext profile', () => {
    expect(rotationSecretRef({ apiKey: 'sk-plain', priority: 50 })).toBeNull();
    expect(rotationSecretRef({ apiKey: '', priority: 50 })).toBeNull();
  });
});

describe('secretRefFromValue', () => {
  it('reads back a whole-value reference', () => {
    expect(secretRefFromValue(secretRef('webhooks/alerts/secret'))).toBe('webhooks/alerts/secret');
  });

  it('returns null for anything that is not exactly one reference', () => {
    expect(secretRefFromValue('sk-plain')).toBeNull();
    expect(secretRefFromValue('')).toBeNull();
    // Concatenated refs name no single secret.
    expect(secretRefFromValue(`${secretRef('a')}${secretRef('b')}`)).toBeNull();
    // A ref embedded in a longer string: the value carries literal material
    // too, so deleting the ref would break whatever still reads it.
    expect(secretRefFromValue(`Bearer ${secretRef('a')}`)).toBeNull();
  });

  it('keeps the strictest of the parsers it replaced: no surrounding whitespace', () => {
    // The three call sites disagreed here — the anchored CLI/web parsers
    // rejected padding, `rotationSecretRef`'s strip-and-count accepted it.
    // Strictest wins: a loose parse on the delete path drops live material.
    expect(secretRefFromValue(` ${secretRef('rotation/x')} `)).toBeNull();
    expect(rotationSecretRef({ apiKey: ` ${secretRef('rotation/x')} `, priority: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// New tests: env-based resolution via MergedSecretsResolver
// ---------------------------------------------------------------------------

describe('env-only resolution via MergedSecretsResolver', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  async function loadWithMerged(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    const file = new InMemorySecretsResolver();
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    return readConfig(storage, merged);
  }

  const baseYaml = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    `apiKey: ${['${', 'secrets:providers/anthropic/apiKey}'].join('')}`,
    'personality: researcher',
  ].join('\n');

  it('resolves apiKey from process.env via MergedSecretsResolver', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    const cfg = await loadWithMerged(baseYaml);
    expect(cfg?.apiKey).toBe('sk-ant-from-env');
  });

  it('env overrides on-disk file value', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-priority';
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), baseYaml);
    const file = new InMemorySecretsResolver();
    await file.set('providers/anthropic/apiKey', 'file-fallback');
    const merged = new MergedSecretsResolver({
      readers: [new EnvSecretsResolver(), file],
      writer: file,
    });
    const cfg = await readConfig(storage, merged);
    expect(cfg?.apiKey).toBe('env-priority');
  });

  it('boot failure message for known ref contains env var name', async () => {
    // No env var set, no file secret → should throw with env var hint
    await expect(loadWithMerged(baseYaml)).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('boot failure message for known ref contains all 3 resolution paths', async () => {
    let err: Error | undefined;
    try {
      await loadWithMerged(baseYaml);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('~/.ethos/.env');
    expect(err?.message).toContain('environment variable ANTHROPIC_API_KEY');
    expect(err?.message).toContain('ethos secrets set');
  });
});

// ---------------------------------------------------------------------------
// AWS secrets config round-trip
// ---------------------------------------------------------------------------

describe('aws.secrets config round-trip', () => {
  it('aws.secrets config round-trips through write/parse', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-test',
      personality: 'researcher',
      aws: {
        secrets: {
          enabled: true,
          region: 'us-west-2',
          prefix: 'ethos/prod',
          endpoint: 'http://localhost:4566',
        },
      },
    };

    await writeConfig(storage, config, new InMemorySecretsResolver());
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('aws.secrets.enabled: true');
    expect(raw).toContain('aws.secrets.region: us-west-2');
    expect(raw).toContain('aws.secrets.prefix: ethos/prod');
    expect(raw).toContain('aws.secrets.endpoint: http://localhost:4566');

    // Re-parse
    const reparsed = await readRawConfig(storage);
    expect(reparsed?.aws?.secrets?.enabled).toBe(true);
    expect(reparsed?.aws?.secrets?.region).toBe('us-west-2');
    expect(reparsed?.aws?.secrets?.prefix).toBe('ethos/prod');
    expect(reparsed?.aws?.secrets?.endpoint).toBe('http://localhost:4566');
  });
});

// ---------------------------------------------------------------------------
// Langfuse export config round-trip (analytics-observability plan, Part E)
// ---------------------------------------------------------------------------

describe('telemetry.export.langfuse config round-trip', () => {
  it('non-secret fields round-trip through write/parse; secretKey is vaulted', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-test',
      personality: 'researcher',
      telemetry: {
        export: {
          langfuse: {
            enabled: true,
            baseUrl: 'https://cloud.langfuse.com',
            publicKey: 'pk-lf-abc',
            secretKey: 'sk-lf-secret',
          },
        },
      },
    };

    await writeConfig(storage, config, secrets);
    const raw = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(raw).toContain('telemetry.export.langfuse.enabled: true');
    expect(raw).toContain('telemetry.export.langfuse.baseUrl: https://cloud.langfuse.com');
    expect(raw).toContain('telemetry.export.langfuse.publicKey: pk-lf-abc');
    expect(raw).not.toContain('sk-lf-secret');

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.telemetry?.export?.langfuse?.enabled).toBe(true);
    expect(resolved?.telemetry?.export?.langfuse?.baseUrl).toBe('https://cloud.langfuse.com');
    expect(resolved?.telemetry?.export?.langfuse?.publicKey).toBe('pk-lf-abc');
    expect(resolved?.telemetry?.export?.langfuse?.secretKey).toBe('sk-lf-secret');
  });
});

// ---------------------------------------------------------------------------
// writeConfig externalization (G-SEC — config references a secret by name,
// never by value). The read path already resolved refs; these cover the write
// path that used to serialize credential VALUES as plaintext literals.
// ---------------------------------------------------------------------------

/** A config carrying one of every credential-bearing field, all plaintext —
 *  i.e. what an install written before externalization looks like on disk. */
function configWithEveryCredential(): EthosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'PLAIN-primary-apiKey',
    personality: 'researcher',
    telegramToken: 'PLAIN-telegram',
    discordToken: 'PLAIN-discord',
    slackBotToken: 'PLAIN-slack-bot',
    slackAppToken: 'PLAIN-slack-app',
    slackSigningSecret: 'PLAIN-slack-sig',
    emailUser: 'user@example.com',
    emailPassword: 'PLAIN-email',
    providers: [
      { provider: 'anthropic', apiKey: 'PLAIN-chain-0' },
      { provider: 'openrouter', apiKey: 'PLAIN-chain-1', baseUrl: 'https://openrouter.ai/api/v1' },
    ],
    telegram: {
      bots: [
        { id: 'bot-a', token: 'PLAIN-bot-a', bind: { type: 'personality', name: 'researcher' } },
        { token: 'PLAIN-bot-b', bind: { type: 'personality', name: 'coder' } },
      ],
    },
    slack: {
      apps: [
        {
          id: 'app-a',
          botToken: 'PLAIN-app-bot',
          appToken: 'PLAIN-app-app',
          signingSecret: 'PLAIN-app-sig',
          bind: { type: 'personality', name: 'coder' },
        },
      ],
    },
    voice: {
      bots: [{ match: 'room-*', bind: { type: 'personality', name: 'researcher' } }],
      livekit: { url: 'wss://live.example.com', apiKey: 'PLAIN-lk-key', apiSecret: 'PLAIN-lk-sec' },
      trunk: {
        provider: 'twilio',
        trunkId: 'ST_1',
        password: 'PLAIN-sip',
        webhookSecret: 'PLAIN-sip-webhook',
      },
    },
    auxiliary: {
      compression: { model: 'm', apiKey: 'PLAIN-aux-compression' },
      vision: { model: 'm', apiKey: 'PLAIN-aux-vision' },
      web: { model: 'm', apiKey: 'PLAIN-aux-web' },
      asr: { provider: 'openai', apiKey: 'PLAIN-aux-asr' },
      tts: { provider: 'openai', apiKey: 'PLAIN-aux-tts' },
    },
    webhooks: {
      hook1: { personalityId: 'researcher', secret: 'PLAIN-hook' },
    },
    memoryCapture: { enabled: true, model: 'm', apiKey: 'PLAIN-capture' },
    telemetry: {
      export: {
        langfuse: {
          enabled: true,
          baseUrl: 'https://cloud.langfuse.com',
          publicKey: 'pk-lf-plain',
          secretKey: 'PLAIN-langfuse',
        },
      },
    },
  };
}

describe('writeConfig externalizes every credential field', () => {
  it('writes no plaintext credential and round-trips every value through the vault', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    const original = configWithEveryCredential();

    await writeConfig(storage, original, secrets);

    // Assert on the raw file text — not the parsed object.
    const yaml = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(yaml).not.toContain('PLAIN-');

    // Every value is retrievable, and the config round-trips intact.
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.apiKey).toBe('PLAIN-primary-apiKey');
    expect(resolved?.telegramToken).toBe('PLAIN-telegram');
    expect(resolved?.discordToken).toBe('PLAIN-discord');
    expect(resolved?.slackBotToken).toBe('PLAIN-slack-bot');
    expect(resolved?.slackAppToken).toBe('PLAIN-slack-app');
    expect(resolved?.slackSigningSecret).toBe('PLAIN-slack-sig');
    expect(resolved?.emailPassword).toBe('PLAIN-email');
    expect(resolved?.providers?.map((p) => p.apiKey)).toEqual(['PLAIN-chain-0', 'PLAIN-chain-1']);
    expect(resolved?.telegram?.bots.map((b) => b.token)).toEqual(['PLAIN-bot-a', 'PLAIN-bot-b']);
    expect(resolved?.slack?.apps[0]).toEqual(original.slack?.apps[0]);
    expect(resolved?.voice?.livekit).toEqual(original.voice?.livekit);
    expect(resolved?.voice?.trunk).toEqual(original.voice?.trunk);
    expect(resolved?.auxiliary).toEqual(original.auxiliary);
    expect(resolved?.webhooks).toEqual(original.webhooks);
    expect(resolved?.memoryCapture).toEqual(original.memoryCapture);
    expect(resolved?.telemetry).toEqual(original.telemetry);
  });

  it('uses the documented ref names', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, configWithEveryCredential(), secrets);

    expect((await secrets.list()).sort()).toEqual(
      [
        'auxiliary/asr/apiKey',
        'auxiliary/compression/apiKey',
        'auxiliary/tts/apiKey',
        'auxiliary/vision/apiKey',
        'auxiliary/web/apiKey',
        'discord/token',
        'email/password',
        'memoryCapture/apiKey',
        'providers/0/anthropic/apiKey',
        'providers/1/openrouter/apiKey',
        'providers/anthropic/apiKey',
        'slack/appToken',
        'slack/apps/app-a/appToken',
        'slack/apps/app-a/botToken',
        'slack/apps/app-a/signingSecret',
        'slack/botToken',
        'slack/signingSecret',
        'telegram/bots/bot-a/token',
        `telegram/bots/${deriveBotKey({ token: 'PLAIN-bot-b' })}/token`,
        'telegram/token',
        'telemetry/export/langfuse/secretKey',
        'voice/livekit/apiKey',
        'voice/livekit/apiSecret',
        'voice/trunk/password',
        'voice/trunk/webhookSecret',
        'webhooks/hook1/secret',
      ].sort(),
    );
  });

  it('is idempotent — a second write neither re-wraps nor re-mints a ref', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, configWithEveryCredential(), secrets);

    const firstYaml = await storage.read(join(ethosDir(), 'config.yaml'));
    const firstRefs = (await secrets.list()).sort();

    // Round-trip the written config back through the writer, the way every
    // CLI command that edits one field does (readRawConfig → writeConfig).
    const roundTripped = await readRawConfig(storage);
    if (!roundTripped) throw new Error('expected a config');
    await writeConfig(storage, roundTripped, secrets);

    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toBe(firstYaml);
    expect((await secrets.list()).sort()).toEqual(firstRefs);
    // A re-wrapped ref would nest one inside another.
    expect(firstYaml).not.toContain('secrets:$');
  });

  it('fails loudly when the resolver cannot store the secret', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const failing: SecretsResolver = {
      get: async () => null,
      set: async () => {
        throw new Error('vault is read-only');
      },
      delete: async () => {},
      list: async () => [],
    };

    await expect(
      writeConfig(
        storage,
        {
          provider: 'anthropic',
          model: 'm',
          apiKey: 'PLAIN-primary-apiKey',
          personality: 'researcher',
        },
        failing,
      ),
    ).rejects.toThrow('vault is read-only');

    // Nothing reached disk — a failed externalization must not fall back to
    // writing the plaintext value.
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toBeNull();
  });
});
