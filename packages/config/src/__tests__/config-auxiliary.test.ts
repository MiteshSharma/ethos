import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readConfig, readRawConfig, writeConfig } from '../index';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

// context_compression F1 — auxiliary.compression config block.
describe('auxiliary.compression config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('parses a model-only auxiliary.compression block', async () => {
    const cfg = await load(
      [...base, 'auxiliary.compression.model: claude-haiku-4-5-20251001'].join('\n'),
    );
    expect(cfg?.auxiliary?.compression).toEqual({ model: 'claude-haiku-4-5-20251001' });
  });

  it('parses provider / apiKey / baseUrl overrides', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.compression.model: gpt-5-mini',
        'auxiliary.compression.provider: openrouter',
        'auxiliary.compression.apiKey: sk-or-aux',
        'auxiliary.compression.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.compression).toEqual({
      model: 'gpt-5-mini',
      provider: 'openrouter',
      apiKey: 'sk-or-aux',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('leaves auxiliary undefined when no model is configured', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.auxiliary).toBeUndefined();
  });

  it('round-trips auxiliary.compression through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      auxiliary: {
        compression: {
          model: 'claude-haiku-4-5-20251001',
          provider: 'anthropic',
          apiKey: 'sk-aux',
        },
      },
    };
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    // The key is externalized: the file carries a ref, the vault carries the value.
    const raw = await readRawConfig(storage);
    expect(raw?.auxiliary?.compression?.apiKey).toBe(secretRef('auxiliary/compression/apiKey'));
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.auxiliary?.compression).toEqual(original.auxiliary.compression);
  });
});

// tools-vision P2 — auxiliary.vision config block. Mirrors the compression
// shape exactly: a cheap model/provider override the vision_analyze tool
// routes its LLM call through (so a non-vision-capable primary personality
// can still use vision).
describe('auxiliary.vision config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('parses a model-only auxiliary.vision block', async () => {
    const cfg = await load([...base, 'auxiliary.vision.model: claude-sonnet-4-6'].join('\n'));
    expect(cfg?.auxiliary?.vision).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('parses provider / apiKey / baseUrl overrides', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.vision.model: gpt-5-mini',
        'auxiliary.vision.provider: openrouter',
        'auxiliary.vision.apiKey: sk-or-vision',
        'auxiliary.vision.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.vision).toEqual({
      model: 'gpt-5-mini',
      provider: 'openrouter',
      apiKey: 'sk-or-vision',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('leaves auxiliary.vision undefined when no model is configured', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.auxiliary?.vision).toBeUndefined();
  });

  it('round-trips auxiliary.vision through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      auxiliary: {
        vision: {
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          apiKey: 'sk-vision',
        },
      },
    };
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    // The key is externalized: the file carries a ref, the vault carries the value.
    const raw = await readRawConfig(storage);
    expect(raw?.auxiliary?.vision?.apiKey).toBe(secretRef('auxiliary/vision/apiKey'));
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.auxiliary?.vision).toEqual(original.auxiliary.vision);
  });

  it('parses both auxiliary.compression and auxiliary.vision together', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.compression.model: claude-haiku-4-5-20251001',
        'auxiliary.vision.model: claude-sonnet-4-6',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.compression).toEqual({ model: 'claude-haiku-4-5-20251001' });
    expect(cfg?.auxiliary?.vision).toEqual({ model: 'claude-sonnet-4-6' });
  });
});

describe('writeConfig round-trip — previously dropped fields', () => {
  it('round-trips email, display, evolver, background, and providers fields', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-test',
      personality: 'researcher',
      emailImapHost: 'imap.example.com',
      emailImapPort: 993,
      emailUser: 'user@example.com',
      emailPassword: 'secret',
      emailSmtpHost: 'smtp.example.com',
      emailSmtpPort: 587,
      displayResumeHint: false,
      displayResumeRecapTurns: 5,
      displayBellOnComplete: true,
      evolverCronEnabled: true,
      evolverSchedule: '0 3 * * *',
      backgroundMaxConcurrent: 8,
      providers: [
        { provider: 'anthropic', apiKey: 'sk-ant-1', model: 'claude-opus-4-7' },
        { provider: 'openrouter', apiKey: 'sk-or-2', baseUrl: 'https://openrouter.ai/api/v1' },
      ],
    };
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const roundTripped = await readConfig(storage, secrets);
    // Credentials survive the round-trip through the vault, not the file.
    const onDisk = await readRawConfig(storage);
    expect(onDisk?.emailPassword).toBe(secretRef('email/password'));
    expect(onDisk?.providers?.[0]?.apiKey).toBe(secretRef('providers/0/anthropic/apiKey'));
    expect(onDisk?.providers?.[1]?.apiKey).toBe(secretRef('providers/1/openrouter/apiKey'));
    expect(roundTripped?.emailImapHost).toBe('imap.example.com');
    expect(roundTripped?.emailImapPort).toBe(993);
    expect(roundTripped?.emailUser).toBe('user@example.com');
    expect(roundTripped?.emailPassword).toBe('secret');
    expect(roundTripped?.emailSmtpHost).toBe('smtp.example.com');
    expect(roundTripped?.emailSmtpPort).toBe(587);
    expect(roundTripped?.displayResumeHint).toBe(false);
    expect(roundTripped?.displayResumeRecapTurns).toBe(5);
    expect(roundTripped?.displayBellOnComplete).toBe(true);
    expect(roundTripped?.evolverCronEnabled).toBe(true);
    expect(roundTripped?.evolverSchedule).toBe('0 3 * * *');
    expect(roundTripped?.backgroundMaxConcurrent).toBe(8);
    expect(roundTripped?.providers).toHaveLength(2);
    expect(roundTripped?.providers?.[0]).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-ant-1',
      model: 'claude-opus-4-7',
    });
    expect(roundTripped?.providers?.[1]).toEqual({
      provider: 'openrouter',
      apiKey: 'sk-or-2',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });
});

// local-voice-providers Stage 1 — auxiliary.asr / auxiliary.tts voice config.
describe('auxiliary.asr / auxiliary.tts config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('leaves asr/tts undefined when absent', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.auxiliary?.asr).toBeUndefined();
    expect(cfg?.auxiliary?.tts).toBeUndefined();
  });

  it('parses a local-stt asr block with baseUrl (no api key)', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.asr.provider: local-stt',
        'auxiliary.asr.model: whisper-large-v3',
        'auxiliary.asr.baseUrl: http://localhost:8000/v1',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.asr).toEqual({
      provider: 'local-stt',
      model: 'whisper-large-v3',
      baseUrl: 'http://localhost:8000/v1',
    });
  });

  it('parses a local-tts block with baseUrl + free-form voice (no api key)', async () => {
    const cfg = await load(
      [
        ...base,
        'auxiliary.tts.provider: local-tts',
        'auxiliary.tts.model: kokoro',
        'auxiliary.tts.voice: af_bella',
        'auxiliary.tts.baseUrl: http://localhost:8880/v1',
      ].join('\n'),
    );
    expect(cfg?.auxiliary?.tts).toEqual({
      provider: 'local-tts',
      model: 'kokoro',
      voice: 'af_bella',
      baseUrl: 'http://localhost:8880/v1',
    });
  });

  it('round-trips asr.baseUrl and tts.baseUrl through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      auxiliary: {
        asr: {
          provider: 'local-stt',
          model: 'whisper-large-v3',
          baseUrl: 'http://localhost:8000/v1',
        },
        tts: {
          provider: 'local-tts',
          model: 'kokoro',
          voice: 'af_bella',
          baseUrl: 'http://localhost:8880/v1',
        },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.auxiliary?.asr).toEqual(original.auxiliary.asr);
    expect(roundTripped?.auxiliary?.tts).toEqual(original.auxiliary.tts);
  });
});

// Phase 3c E — nightlyPass scheduler config block.
describe('nightlyPass config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('is undefined when absent (default-off)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.nightlyPass).toBeUndefined();
  });

  it('parses enabled and cron', async () => {
    const cfg = await load(
      [...base, 'nightlyPass.enabled: true', 'nightlyPass.cron: 0 4 * * *'].join('\n'),
    );
    expect(cfg?.nightlyPass).toEqual({ enabled: true, cron: '0 4 * * *' });
  });

  it('parses enabled: false', async () => {
    const cfg = await load([...base, 'nightlyPass.enabled: false'].join('\n'));
    expect(cfg?.nightlyPass).toEqual({ enabled: false });
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-test',
        personality: 'researcher',
        nightlyPass: { enabled: true, cron: '0 3 * * *' },
      },
      new InMemorySecretsResolver(),
    );
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.nightlyPass).toEqual({ enabled: true, cron: '0 3 * * *' });
  });
});

// Phase 3e — weeklyDigest scheduler config block.
describe('weeklyDigest config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'];

  it('is undefined when absent (default-off)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.weeklyDigest).toBeUndefined();
  });

  it('parses enabled, cron, and recipients', async () => {
    const cfg = await load(
      [
        ...base,
        'weeklyDigest.enabled: true',
        'weeklyDigest.cron: 0 8 * * 1',
        'weeklyDigest.recipients: alice@example.com, bob@example.com',
      ].join('\n'),
    );
    expect(cfg?.weeklyDigest).toEqual({
      enabled: true,
      cron: '0 8 * * 1',
      recipients: ['alice@example.com', 'bob@example.com'],
    });
  });

  it('parses enabled: false', async () => {
    const cfg = await load([...base, 'weeklyDigest.enabled: false'].join('\n'));
    expect(cfg?.weeklyDigest).toEqual({ enabled: false });
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-test',
        personality: 'researcher',
        weeklyDigest: { enabled: true, cron: '0 9 * * 1', recipients: ['a@example.com'] },
      },
      new InMemorySecretsResolver(),
    );
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.weeklyDigest).toEqual({
      enabled: true,
      cron: '0 9 * * 1',
      recipients: ['a@example.com'],
    });
  });
});
