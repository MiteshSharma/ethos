import { join } from 'node:path';
import { deriveBotKey } from '@ethosagent/core';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';

const DATA = '/data';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('ConfigRepository', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let repo: ConfigRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
  });

  it('preserves dotted passthrough keys on read and write', async () => {
    await storage.mkdir(DATA);
    await storage.write(
      join(DATA, 'config.yaml'),
      `${[
        'provider: anthropic',
        'telegram.bots.0.token: 123:ABC',
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: researcher',
        'telegram.bots.1.token: 456:DEF',
        'telegram.bots.1.bind.type: team',
        'telegram.bots.1.bind.name: eng',
      ].join('\n')}\n`,
    );

    const config = await repo.read();
    expect(config?.passthrough['telegram.bots.0.token']).toBe('123:ABC');
    expect(config?.passthrough['telegram.bots.0.bind.type']).toBe('personality');
    expect(config?.passthrough['telegram.bots.0.bind.name']).toBe('researcher');
    expect(config?.passthrough['telegram.bots.1.token']).toBe('456:DEF');

    // Update an unrelated field — dotted keys must survive
    await repo.update({ model: 'claude-opus-4-7' });
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    // The token is preserved, but as a vault reference — never as a literal.
    // The ref is keyed by the bot's stable botKey (what PlatformsRepository
    // mints for the same token), not by array position.
    const botKey = deriveBotKey('123:ABC');
    expect(yaml).toContain(
      `telegram.bots.0.token: "${secretRef(`telegram/bots/${botKey}/token`)}"`,
    );
    expect(yaml).not.toContain('123:ABC');
    expect(await secrets.get(`telegram/bots/${botKey}/token`)).toBe('123:ABC');
    expect(yaml).toContain('telegram.bots.1.bind.name: eng');
  });

  it('reads providers.N.field lines into a providers array', async () => {
    await storage.mkdir(DATA);
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-primary',
        'providers.0.provider: anthropic',
        'providers.0.apiKey: sk-ant-primary',
        'providers.0.model: claude-opus-4-7',
        'providers.1.provider: openrouter',
        'providers.1.apiKey: sk-or-fallback',
        'providers.1.model: gpt-4',
        'providers.1.baseUrl: https://openrouter.ai/api/v1',
      ].join('\n'),
    );

    const config = await repo.read();
    expect(config?.providers).toHaveLength(2);
    expect(config?.providers[0]).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-ant-primary',
      model: 'claude-opus-4-7',
    });
    expect(config?.providers[1]).toEqual({
      provider: 'openrouter',
      apiKey: 'sk-or-fallback',
      model: 'gpt-4',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    // Verify they don't leak into passthrough
    expect(config?.passthrough['providers.0.provider']).toBeUndefined();
    expect(config?.passthrough['providers.1.apiKey']).toBeUndefined();
  });

  it('round-trips providers through write then read', async () => {
    await repo.update({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk-ant-primary',
      providers: [
        { provider: 'anthropic', apiKey: 'sk-ant-primary', model: 'claude-opus-4-7' },
        {
          provider: 'openrouter',
          apiKey: 'sk-or-fallback',
          model: 'gpt-4',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
      ],
    });

    const config = await repo.read();
    expect(config?.providers).toHaveLength(2);
    expect(config?.providers[0]?.provider).toBe('anthropic');
    expect(config?.providers[0]?.model).toBe('claude-opus-4-7');
    expect(config?.providers[1]?.provider).toBe('openrouter');
    expect(config?.providers[1]?.baseUrl).toBe('https://openrouter.ai/api/v1');

    // Verify the raw YAML has the indexed keys
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('providers.0.provider: anthropic');
    expect(yaml).toContain('providers.1.provider: openrouter');
    expect(yaml).toContain('providers.1.baseUrl: "https://openrouter.ai/api/v1"');
  });

  it('update with providers replaces the entire array', async () => {
    await repo.update({
      providers: [
        { provider: 'anthropic', apiKey: 'sk-ant-1' },
        { provider: 'openrouter', apiKey: 'sk-or-1' },
      ],
    });
    // Now replace with a single provider
    await repo.update({
      providers: [{ provider: 'ollama', model: 'llama3' }],
    });
    const config = await repo.read();
    expect(config?.providers).toHaveLength(1);
    expect(config?.providers[0]?.provider).toBe('ollama');
    // Old providers should be gone
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).not.toContain('openrouter');
  });

  it('writes config.yaml with 0o600 so plaintext apiKeys are not world-readable', async () => {
    const path = join(DATA, 'config.yaml');

    // update() (the common write path)
    await repo.update({ apiKey: 'sk-ant-secret' });
    expect(storage.getMode(path)).toBe(0o600);

    // deletePassthroughKeys() (the other write path)
    await repo.deletePassthroughKeys(['nonexistent']);
    expect(storage.getMode(path)).toBe(0o600);
  });

  it('round-trips voice base URL, model, and free-form voice id', async () => {
    await repo.update({
      voiceProvider: 'local-stt',
      voiceBaseUrl: 'http://localhost:8000/v1',
      voiceModel: 'whisper-large-v3',
      voiceTtsProvider: 'local-tts',
      voiceTtsBaseUrl: 'http://localhost:8880/v1',
      voiceTtsModel: 'kokoro',
      voiceTtsVoice: 'af_bella',
    });
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('auxiliary.asr.baseUrl: "http://localhost:8000/v1"');
    expect(yaml).toContain('auxiliary.asr.model: whisper-large-v3');
    expect(yaml).toContain('auxiliary.tts.baseUrl: "http://localhost:8880/v1"');
    expect(yaml).toContain('auxiliary.tts.model: kokoro');
    expect(yaml).toContain('auxiliary.tts.voice: af_bella');

    const config = await repo.read();
    expect(config?.voiceProvider).toBe('local-stt');
    expect(config?.voiceBaseUrl).toBe('http://localhost:8000/v1');
    expect(config?.voiceModel).toBe('whisper-large-v3');
    expect(config?.voiceTtsProvider).toBe('local-tts');
    expect(config?.voiceTtsBaseUrl).toBe('http://localhost:8880/v1');
    expect(config?.voiceTtsModel).toBe('kokoro');
    expect(config?.voiceTtsVoice).toBe('af_bella');
  });

  it('does not duplicate voice keys into passthrough on round-trip', async () => {
    await repo.update({
      voiceProvider: 'local-stt',
      voiceBaseUrl: 'http://localhost:8000/v1',
      voiceModel: 'whisper-large-v3',
    });
    const config = await repo.read();
    expect(config?.passthrough['auxiliary.asr.baseUrl']).toBeUndefined();
    expect(config?.passthrough['auxiliary.asr.model']).toBeUndefined();
  });

  it('deletePassthroughKeys removes dotted keys', async () => {
    await repo.update({
      passthrough: {
        'telegram.bots.0.token': 'tok',
        'telegram.bots.0.bind.type': 'personality',
        'telegram.bots.0.bind.name': 'researcher',
        telegramToken: 'old',
      },
    });
    await repo.deletePassthroughKeys([
      'telegram.bots.0.token',
      'telegram.bots.0.bind.type',
      'telegram.bots.0.bind.name',
    ]);
    const config = await repo.read();
    expect(config?.passthrough['telegram.bots.0.token']).toBeUndefined();
    expect(config?.passthrough.telegramToken).toBe(secretRef('telegram/token'));
    expect(await secrets.get('telegram/token')).toBe('old');
  });
});
