// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the asserted string
// is a literal `${secrets:…}` config reference, not template interpolation.

import { join } from 'node:path';
import { readRawConfig } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

// Settings → Voice, "Additional providers": the named TTS roster
// (`voice.tts.providers.<name>.*`) must survive a full round trip through the same
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
      voiceTtsProviders: {
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
    expect(read.voiceTtsProviders['mac-say']).toEqual({
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
    expect(loaded?.voice?.tts?.providers?.['mac-say']).toEqual({
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
      voiceTtsProviders: {
        studio: { provider: 'openai-tts', voice: 'nova' },
        kokoro: { provider: 'local-tts', baseUrl: 'http://localhost:8880/v1' },
      },
    });
    expect(Object.keys((await service.get()).voiceTtsProviders).sort()).toEqual([
      'kokoro',
      'studio',
    ]);

    // A save carries the whole roster, so leaving `kokoro` out removes it.
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', voice: 'nova' } },
    });
    const after = await service.get();
    expect(Object.keys(after.voiceTtsProviders)).toEqual(['studio']);
    expect(await yaml()).not.toContain('kokoro');
  });

  it('moves an entry API key into the vault and only ever previews it', async () => {
    await seed([]);
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
    });

    const file = await yaml();
    expect(file).not.toContain('sk-studio-abcdefghijkl');
    // Quoted by the serializer — `${…}` is not a bare YAML scalar. The ref name
    // is the point: it is the one the CLI's writer mints for the same key.
    expect(file).toContain(
      'voice.tts.providers.studio.apiKey: "${secrets:voice/tts/providers/studio/apiKey}"',
    );
    expect(await secrets.get('voice/tts/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');

    const preview = (await service.get()).voiceTtsProviders.studio?.apiKeyPreview;
    expect(preview).not.toBeNull();
    expect(preview).not.toContain('abcdefghijkl');
  });

  it('a save that omits apiKey keeps the stored key instead of erasing it', async () => {
    await seed([]);
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
    });
    // What the form sends after an edit that never touched the key field.
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', voice: 'shimmer' } },
    });

    expect(await yaml()).toContain('voice.tts.providers.studio.apiKey:');
    expect(await secrets.get('voice/tts/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');
    expect((await service.get()).voiceTtsProviders.studio?.voice).toBe('shimmer');
  });

  it('removing an entry deletes its vault key too', async () => {
    await seed([]);
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
    });
    expect(await secrets.get('voice/tts/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');

    await service.update({ voiceTtsProviders: {} });
    expect((await service.get()).voiceTtsProviders).toEqual({});
    expect(await secrets.get('voice/tts/providers/studio/apiKey')).toBeNull();
  });

  it('refuses a name the config format cannot carry', async () => {
    await seed([]);
    await expect(
      service.update({ voiceTtsProviders: { 'my studio': { provider: 'openai-tts' } } }),
    ).rejects.toThrow(/identifier/);
    // …and nothing was written, so a rejected name cannot half-land.
    expect(await yaml()).not.toContain('voice.tts.providers');
  });

  it('an entry with no provider is refused rather than half-written', async () => {
    await seed([]);
    await expect(
      // The wire schema requires `provider`; this is the direct (non-RPC) caller.
      service.update({ voiceTtsProviders: { studio: { provider: '' } } }),
    ).rejects.toThrow(/provider is required/);
  });

  it('leaves the roster alone when the patch does not mention it', async () => {
    await seed(['voice.tts.providers.studio.provider: openai-tts']);
    await service.update({ voiceDefaultMode: 'all' });
    expect((await service.get()).voiceTtsProviders.studio?.provider).toBe('openai-tts');
  });

  it('a stored entry with no provider is not surfaced as half an entry', async () => {
    await seed(['voice.tts.providers.broken.voice: nova']);
    expect((await service.get()).voiceTtsProviders).toEqual({});
  });

  // The older `voice.providers.*` spelling was published before STT had a
  // roster. It has to keep working from this surface too — reading it, and
  // migrating it on the next save WITHOUT losing the credential it points at.
  it('reads a legacy voice.providers entry as a TTS roster entry', async () => {
    await seed([
      'voice.providers.studio.provider: openai-tts',
      'voice.providers.studio.voice: nova',
    ]);
    expect((await service.get()).voiceTtsProviders.studio).toMatchObject({
      provider: 'openai-tts',
      voice: 'nova',
    });
  });

  it('migrates a legacy entry to the new key on save, keeping its vault key', async () => {
    await seed([]);
    // Write it the new way, then rewrite the key to the legacy spelling so the
    // fixture is exactly what an older Ethos would have left on disk.
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
    });
    const legacy = (await yaml()).replace(/^voice\.tts\.providers\./gm, 'voice.providers.');
    await storage.write(join(DATA, 'config.yaml'), legacy);
    expect(await yaml()).toContain('voice.providers.studio.apiKey:');

    // A save from Settings that never touched the key field.
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', voice: 'shimmer' } },
    });

    const file = await yaml();
    expect(file).toContain('voice.tts.providers.studio.provider: openai-tts');
    expect(file).not.toMatch(/^voice\.providers\./m);
    // The credential survived the rename — the ref moved, the vault entry did not.
    expect(await secrets.get('voice/tts/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');
    expect((await service.get()).voiceTtsProviders.studio?.apiKeyPreview).not.toBeNull();
  });
});

// The STT roster is the mirror of the TTS one, so its coverage mirrors it: same
// round trip, same vault rules, same name validation.
describe('Settings → Voice STT provider roster', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
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
    await storage.write(join(DATA, 'config.yaml'), BASE.join('\n'));
  });

  async function yaml(): Promise<string> {
    return (await storage.read(join(DATA, 'config.yaml'))) ?? '';
  }

  it('round-trips an entry through write, read, and the CLI loader', async () => {
    await service.update({
      voiceSttProviders: {
        'whisper-cli': {
          provider: 'command-stt',
          command: 'whisper-cli -f {input_path} -o {output_path}',
          timeout: 60,
        },
      },
    });

    const read = await service.get();
    expect(read.voiceSttProviders['whisper-cli']).toEqual({
      provider: 'command-stt',
      model: null,
      apiKeyPreview: null,
      baseUrl: null,
      command: 'whisper-cli -f {input_path} -o {output_path}',
      timeout: 60,
    });

    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.stt?.providers?.['whisper-cli']).toEqual({
      provider: 'command-stt',
      command: 'whisper-cli -f {input_path} -o {output_path}',
      timeout: 60,
    });
  });

  it('moves an entry API key into the vault on its own STT ref', async () => {
    await service.update({
      voiceSttProviders: { spanish: { provider: 'local-stt', apiKey: 'sk-spanish-abcdefghijkl' } },
    });

    const file = await yaml();
    expect(file).not.toContain('sk-spanish-abcdefghijkl');
    expect(file).toContain(
      'voice.stt.providers.spanish.apiKey: "${secrets:voice/stt/providers/spanish/apiKey}"',
    );
    expect(await secrets.get('voice/stt/providers/spanish/apiKey')).toBe('sk-spanish-abcdefghijkl');

    const preview = (await service.get()).voiceSttProviders.spanish?.apiKeyPreview;
    expect(preview).not.toBeNull();
    expect(preview).not.toContain('abcdefghijkl');
  });

  it('a save that omits apiKey keeps the stored key; removing the row drops it', async () => {
    await service.update({
      voiceSttProviders: { spanish: { provider: 'local-stt', apiKey: 'sk-spanish-abcdefghijkl' } },
    });
    await service.update({
      voiceSttProviders: { spanish: { provider: 'local-stt', model: 'faster-whisper' } },
    });
    expect(await secrets.get('voice/stt/providers/spanish/apiKey')).toBe('sk-spanish-abcdefghijkl');
    expect((await service.get()).voiceSttProviders.spanish?.model).toBe('faster-whisper');

    await service.update({ voiceSttProviders: {} });
    expect((await service.get()).voiceSttProviders).toEqual({});
    expect(await secrets.get('voice/stt/providers/spanish/apiKey')).toBeNull();
  });

  it('refuses a name the config format cannot carry', async () => {
    await expect(
      service.update({ voiceSttProviders: { 'my ear': { provider: 'local-stt' } } }),
    ).rejects.toThrow(/identifier/);
    expect(await yaml()).not.toContain('voice.stt.providers');
  });

  it('an entry with no provider is refused rather than half-written', async () => {
    await expect(
      service.update({ voiceSttProviders: { spanish: { provider: '' } } }),
    ).rejects.toThrow(/provider is required/);
  });

  it('replacing one roster leaves the other alone', async () => {
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts' } },
      voiceSttProviders: { spanish: { provider: 'local-stt' } },
    });
    await service.update({ voiceSttProviders: { groq: { provider: 'groq-stt' } } });

    const read = await service.get();
    expect(Object.keys(read.voiceTtsProviders)).toEqual(['studio']);
    expect(Object.keys(read.voiceSttProviders)).toEqual(['groq']);
  });
});

// The realtime roster is the third sibling: same round trip, same vault rules,
// same name validation — plus the three scalars that decide which entry a
// deployment uses, which engine it prefers, and where a session stops.
describe('Settings → Voice realtime provider roster', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
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
    await storage.write(join(DATA, 'config.yaml'), BASE.join('\n'));
  });

  async function yaml(): Promise<string> {
    return (await storage.read(join(DATA, 'config.yaml'))) ?? '';
  }

  it('round-trips an entry through write, read, and the CLI loader', async () => {
    await service.update({
      voiceRealtimeProviders: {
        live: {
          provider: 'openai-realtime',
          model: 'gpt-realtime',
          voice: 'cedar',
          costPerMinuteUsd: 0.06,
        },
      },
    });

    const read = await service.get();
    expect(read.voiceRealtimeProviders.live).toEqual({
      provider: 'openai-realtime',
      model: 'gpt-realtime',
      apiKeyPreview: null,
      baseUrl: null,
      voice: 'cedar',
      costPerMinuteUsd: 0.06,
    });

    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.realtime?.providers?.live).toEqual({
      provider: 'openai-realtime',
      model: 'gpt-realtime',
      voice: 'cedar',
      costPerMinuteUsd: 0.06,
    });
  });

  it('round-trips the tier, default entry and session budget to the CLI loader', async () => {
    await service.update({
      voiceTier: 'realtime',
      voiceRealtimeDefault: 'live',
      voiceRealtimeSessionBudgetUsd: 1.5,
      voiceRealtimeProviders: { live: { provider: 'openai-realtime' } },
    });

    const read = await service.get();
    expect(read.voiceTier).toBe('realtime');
    expect(read.voiceRealtimeDefault).toBe('live');
    expect(read.voiceRealtimeSessionBudgetUsd).toBe(1.5);

    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.tier).toBe('realtime');
    expect(loaded?.voice?.realtime?.default).toBe('live');
    expect(loaded?.voice?.realtime?.sessionBudgetUsd).toBe(1.5);
  });

  it('clears the tier, default and budget when the patch sends null', async () => {
    await service.update({
      voiceTier: 'realtime',
      voiceRealtimeDefault: 'live',
      voiceRealtimeSessionBudgetUsd: 1.5,
    });
    await service.update({
      voiceTier: null,
      voiceRealtimeDefault: null,
      voiceRealtimeSessionBudgetUsd: null,
    });

    const read = await service.get();
    expect(read.voiceTier).toBeNull();
    expect(read.voiceRealtimeDefault).toBeNull();
    expect(read.voiceRealtimeSessionBudgetUsd).toBeNull();
    expect(await yaml()).not.toContain('voice.tier');
  });

  it('moves an entry API key into the vault on its own realtime ref', async () => {
    await service.update({
      voiceRealtimeProviders: {
        live: { provider: 'openai-realtime', apiKey: 'sk-live-abcdefghijkl' },
      },
    });

    const file = await yaml();
    expect(file).not.toContain('sk-live-abcdefghijkl');
    expect(file).toContain(
      'voice.realtime.providers.live.apiKey: "${secrets:voice/realtime/providers/live/apiKey}"',
    );
    expect(await secrets.get('voice/realtime/providers/live/apiKey')).toBe('sk-live-abcdefghijkl');

    const preview = (await service.get()).voiceRealtimeProviders.live?.apiKeyPreview;
    expect(preview).not.toBeNull();
    expect(preview).not.toContain('abcdefghijkl');
  });

  // The vault-ref GC is the sharp edge: the config key is the ONLY pointer to
  // the vault entry, so a roster the cleanup regex does not recognise leaks its
  // credentials on every removal — and one that ignores `survivingRefs` blanks
  // a credential the operator never touched.
  it('a save that omits apiKey keeps the stored key; removing the row drops it', async () => {
    await service.update({
      voiceRealtimeProviders: {
        live: { provider: 'openai-realtime', apiKey: 'sk-live-abcdefghijkl' },
      },
    });
    await service.update({
      voiceRealtimeProviders: { live: { provider: 'openai-realtime', voice: 'cedar' } },
    });
    expect(await secrets.get('voice/realtime/providers/live/apiKey')).toBe('sk-live-abcdefghijkl');
    expect((await service.get()).voiceRealtimeProviders.live?.voice).toBe('cedar');

    await service.update({ voiceRealtimeProviders: {} });
    expect((await service.get()).voiceRealtimeProviders).toEqual({});
    expect(await secrets.get('voice/realtime/providers/live/apiKey')).toBeNull();
  });

  it('leaves a surviving ref alone while realtime keys are in the same delete batch', async () => {
    // A legacy `voice.providers.*` TTS entry (deleted key, ref re-written under
    // the new spelling) alongside a realtime roster replacement. The legacy
    // credential must survive the shared delete pass; the dropped realtime row
    // must still have its own vault entry collected.
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', apiKey: 'sk-studio-abcdefghijkl' } },
      voiceRealtimeProviders: {
        live: { provider: 'openai-realtime', apiKey: 'sk-live-abcdefghijkl' },
      },
    });
    const legacy = (await yaml()).replace(/^voice\.tts\.providers\./gm, 'voice.providers.');
    await storage.write(join(DATA, 'config.yaml'), legacy);

    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts', voice: 'shimmer' } },
      voiceRealtimeProviders: {},
    });

    expect(await secrets.get('voice/tts/providers/studio/apiKey')).toBe('sk-studio-abcdefghijkl');
    expect(await secrets.get('voice/realtime/providers/live/apiKey')).toBeNull();
    expect((await service.get()).voiceTtsProviders.studio?.apiKeyPreview).not.toBeNull();
  });

  it('keeps a same-named entry in each roster on its own vault ref', async () => {
    await service.update({
      voiceTtsProviders: { house: { provider: 'openai-tts', apiKey: 'sk-tts-abcdefghijkl' } },
      voiceRealtimeProviders: {
        house: { provider: 'openai-realtime', apiKey: 'sk-realtime-abcdefghijkl' },
      },
    });
    expect(await secrets.get('voice/tts/providers/house/apiKey')).toBe('sk-tts-abcdefghijkl');
    expect(await secrets.get('voice/realtime/providers/house/apiKey')).toBe(
      'sk-realtime-abcdefghijkl',
    );

    // Dropping only the realtime row must not touch the TTS credential.
    await service.update({ voiceRealtimeProviders: {} });
    expect(await secrets.get('voice/tts/providers/house/apiKey')).toBe('sk-tts-abcdefghijkl');
    expect(await secrets.get('voice/realtime/providers/house/apiKey')).toBeNull();
  });

  it('refuses a name the config format cannot carry', async () => {
    await expect(
      service.update({ voiceRealtimeProviders: { 'my live': { provider: 'openai-realtime' } } }),
    ).rejects.toThrow(/identifier/);
    expect(await yaml()).not.toContain('voice.realtime.providers');
  });

  it('an entry with no provider is refused rather than half-written', async () => {
    await expect(
      service.update({ voiceRealtimeProviders: { live: { provider: '' } } }),
    ).rejects.toThrow(/provider is required/);
  });

  it('refuses a non-positive rate instead of silently dropping it', async () => {
    await expect(
      service.update({
        voiceRealtimeProviders: { live: { provider: 'openai-realtime', costPerMinuteUsd: 0 } },
      }),
    ).rejects.toThrow(/positive number/);
  });

  it('replacing the realtime roster leaves the other two alone', async () => {
    await service.update({
      voiceTtsProviders: { studio: { provider: 'openai-tts' } },
      voiceSttProviders: { spanish: { provider: 'local-stt' } },
      voiceRealtimeProviders: { live: { provider: 'openai-realtime' } },
    });
    await service.update({ voiceRealtimeProviders: { gemini: { provider: 'gemini-live' } } });

    const read = await service.get();
    expect(Object.keys(read.voiceTtsProviders)).toEqual(['studio']);
    expect(Object.keys(read.voiceSttProviders)).toEqual(['spanish']);
    expect(Object.keys(read.voiceRealtimeProviders)).toEqual(['gemini']);
  });
});
