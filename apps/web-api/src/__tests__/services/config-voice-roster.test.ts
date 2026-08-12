// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the asserted string
// is a literal `${secrets:…}` config reference, not template interpolation.

import { join } from 'node:path';
import { readRawConfig } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

// Settings → Voice, "Additional providers": the named TTS roster
// (`voice.providers.<name>.*`) must survive a full round trip through the same
// service the Settings page calls — and the credentials in it must land in the
// vault, never in config.yaml.

const DATA = '/data';

const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk-anthropic-1234567890abcdef',
  'personality: researcher',
];

describe('Settings → Voice provider roster', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
  // `readRawConfig` (the CLI's own loader) reads `<ethosDir()>/config.yaml`;
  // point it at the same in-memory dir the repository writes to.
  const previousStateDir = process.env.ETHOS_STATE_DIR;

  beforeAll(() => {
    process.env.ETHOS_STATE_DIR = DATA;
  });
  afterAll(() => {
    if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = previousStateDir;
  });

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    service = new ConfigService({ config: repo, secrets });
  });

  async function seed(lines: string[]): Promise<void> {
    await storage.write(join(DATA, 'config.yaml'), [...BASE, ...lines].join('\n'));
  }

  async function yaml(): Promise<string> {
    return (await storage.read(join(DATA, 'config.yaml'))) ?? '';
  }

  it('round-trips an entry through write, read, and the CLI loader', async () => {
    await seed([]);
    await service.update({
      voiceProviders: {
        'mac-say': {
          provider: 'command-tts',
          command: 'say -o {output_path} -f {input_path}',
          outputFormat: 'wav',
          voice: 'Samantha',
          timeout: 60,
          maxTextLength: 2048,
        },
      },
    });

    // 1. The service reads back what the form sent.
    const read = await service.get();
    expect(read.voiceProviders['mac-say']).toEqual({
      provider: 'command-tts',
      model: null,
      apiKeyPreview: null,
      voice: 'Samantha',
      baseUrl: null,
      command: 'say -o {output_path} -f {input_path}',
      outputFormat: 'wav',
      timeout: 60,
      maxTextLength: 2048,
    });

    // 2. And so does the CLI's own loader — a roster the web writes but the
    //    agent cannot load would be a roster that does not exist.
    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.providers?.['mac-say']).toEqual({
      provider: 'command-tts',
      voice: 'Samantha',
      command: 'say -o {output_path} -f {input_path}',
      outputFormat: 'wav',
      timeout: 60,
      maxTextLength: 2048,
    });
  });

  it('keeps several entries side by side and drops one that is omitted', async () => {
    await seed([]);
    await service.update({
      voiceProviders: {
        studio: { provider: 'openai-tts', voice: 'nova' },
        kokoro: { provider: 'local-tts', baseUrl: 'http://localhost:8880/v1' },
      },
    });
    expect(Object.keys((await service.get()).voiceProviders).sort()).toEqual(['kokoro', 'studio']);

    // A save carries the whole roster, so leaving `kokoro` out removes it.
    await service.update({ voiceProviders: { studio: { provider: 'openai-tts', voice: 'nova' } } });
    const after = await service.get();
    expect(Object.keys(after.voiceProviders)).toEqual(['studio']);
    expect(await yaml()).not.toContain('kokoro');
  });

  it('moves an entry API key into the vault and only ever previews it', async () => {
    await seed([]);
    await service.update({
      voiceProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
    });

    const file = await yaml();
    expect(file).not.toContain('sk-studio-abcdefghijkl');
    // Quoted by the serializer — `${…}` is not a bare YAML scalar. The ref name
    // is the point: it is the one the CLI's writer mints for the same key.
    expect(file).toContain(
      'voice.providers.studio.apiKey: "${secrets:voice/providers/studio/apiKey}"',
    );
    expect(await secrets.get('voice/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');

    const preview = (await service.get()).voiceProviders.studio?.apiKeyPreview;
    expect(preview).not.toBeNull();
    expect(preview).not.toContain('abcdefghijkl');
  });

  it('a save that omits apiKey keeps the stored key instead of erasing it', async () => {
    await seed([]);
    await service.update({
      voiceProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
    });
    // What the form sends after an edit that never touched the key field.
    await service.update({
      voiceProviders: { studio: { provider: 'openai-tts', voice: 'shimmer' } },
    });

    expect(await yaml()).toContain('voice.providers.studio.apiKey:');
    expect(await secrets.get('voice/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');
    expect((await service.get()).voiceProviders.studio?.voice).toBe('shimmer');
  });

  it('removing an entry deletes its vault key too', async () => {
    await seed([]);
    await service.update({
      voiceProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
    });
    expect(await secrets.get('voice/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');

    await service.update({ voiceProviders: {} });
    expect((await service.get()).voiceProviders).toEqual({});
    expect(await secrets.get('voice/providers/studio/apiKey')).toBeNull();
  });

  it('refuses a name the config format cannot carry', async () => {
    await seed([]);
    await expect(
      service.update({ voiceProviders: { 'my studio': { provider: 'openai-tts' } } }),
    ).rejects.toThrow(/identifier/);
    // …and nothing was written, so a rejected name cannot half-land.
    expect(await yaml()).not.toContain('voice.providers');
  });

  it('an entry with no provider is refused rather than half-written', async () => {
    await seed([]);
    await expect(
      // The wire schema requires `provider`; this is the direct (non-RPC) caller.
      service.update({ voiceProviders: { studio: { provider: '' } } }),
    ).rejects.toThrow(/provider is required/);
  });

  it('leaves the roster alone when the patch does not mention it', async () => {
    await seed(['voice.providers.studio.provider: openai-tts']);
    await service.update({ voiceDefaultMode: 'all' });
    expect((await service.get()).voiceProviders.studio?.provider).toBe('openai-tts');
  });

  it('a stored entry with no provider is not surfaced as half an entry', async () => {
    await seed(['voice.providers.broken.voice: nova']);
    expect((await service.get()).voiceProviders).toEqual({});
  });
});
