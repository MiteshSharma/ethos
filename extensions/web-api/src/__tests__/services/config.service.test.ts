import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService, redactKey } from '../../services/config.service';

describe('redactKey', () => {
  it('returns <unset> for missing keys', () => {
    expect(redactKey(undefined)).toBe('<unset>');
    expect(redactKey('')).toBe('<unset>');
  });

  it('keeps the prefix and suffix for typical-length keys', () => {
    expect(redactKey('sk-anthropic-1234567890abcdef')).toBe('sk-…cdef');
  });

  it('redacts to last 4 for short-but-plausible keys', () => {
    expect(redactKey('123456')).toBe('…3456');
  });

  it('refuses to render keys under 6 chars', () => {
    expect(redactKey('abc')).toBe('<short>');
  });
});

const DATA = '/data';

describe('ConfigService', () => {
  let storage: InMemoryStorage;
  let repo: ConfigRepository;
  let service: ConfigService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir(DATA);
    repo = new ConfigRepository({ dataDir: DATA, storage });
    service = new ConfigService({ config: repo });
  });

  it('get throws CONFIG_MISSING when no file exists', async () => {
    try {
      await service.get();
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
      if (isEthosError(err)) expect(err.code).toBe('CONFIG_MISSING');
    }
  });

  it('get returns redacted apiKey preview, never the raw key', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-anthropic-1234567890abcdef',
        'personality: researcher',
      ].join('\n'),
    );

    const result = await service.get();
    expect(result.provider).toBe('anthropic');
    expect(result.apiKeyPreview).toBe('sk-…cdef');
    // Belt and braces — make sure the raw key didn't leak under any other
    // field name.
    expect(JSON.stringify(result)).not.toContain('1234567890abcdef');
  });

  it('update preserves passthrough keys (CLI-only fields)', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-anthropic-1234567890abcdef',
        'personality: researcher',
        'telegramToken: tg-1234567890',
        'slackBotToken: xoxb-abc',
      ].join('\n'),
    );

    await service.update({ personality: 'engineer' });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('personality: engineer');
    expect(written).toContain('telegramToken: tg-1234567890');
    expect(written).toContain('slackBotToken: xoxb-abc');
    // The apiKey wasn't part of the patch — must remain.
    expect(written).toContain('apiKey: sk-anthropic-1234567890abcdef');
  });

  it('update with empty apiKey is a no-op (does not erase the existing key)', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep-this', 'personality: researcher'].join(
        '\n',
      ),
    );
    await service.update({ apiKey: '' });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('apiKey: sk-keep-this');
  });

  it('update can replace the apiKey when a non-empty value is supplied', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-old', 'personality: researcher'].join('\n'),
    );
    await service.update({ apiKey: 'sk-new-key-12345' });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('apiKey: sk-new-key-12345');
    expect(written).not.toContain('sk-old');
  });
});
