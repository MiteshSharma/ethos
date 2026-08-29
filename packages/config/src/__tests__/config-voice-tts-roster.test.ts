import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readConfig, readRawConfig, writeConfig } from '../index';

// `voice.tts.providers.<name>.*` — the named TTS roster.
//
// Three dotted levels (kind, name, then field), the same split
// `telegram.bots.<n>.<f>` and `memory.options.<k>` already use. Each entry carries exactly the fields an
// `auxiliary.tts` entry carries, because it IS one — `auxiliary.tts` stays the
// default entry and is untouched by any of this.

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('voice.tts.providers roster parsing', () => {
  it('parses several entries, each with the full auxiliary.tts field set', async () => {
    const cfg = await load([
      'voice.tts.providers.mac-say.provider: command-tts',
      'voice.tts.providers.mac-say.command: say --file-format=WAVE -o {output_path} -f {input_path}',
      'voice.tts.providers.mac-say.outputFormat: wav',
      'voice.tts.providers.mac-say.timeout: 45',
      'voice.tts.providers.mac-say.maxTextLength: 2000',
      'voice.tts.providers.studio.provider: openai-tts',
      'voice.tts.providers.studio.apiKey: sk-studio',
      'voice.tts.providers.studio.model: gpt-4o-mini-tts',
      'voice.tts.providers.studio.voice: alloy',
      'voice.tts.providers.studio.baseUrl: https://api.openai.com/v1',
    ]);

    expect(cfg.voice?.tts?.providers).toEqual({
      'mac-say': {
        provider: 'command-tts',
        command: 'say --file-format=WAVE -o {output_path} -f {input_path}',
        outputFormat: 'wav',
        timeout: 45,
        maxTextLength: 2000,
      },
      studio: {
        provider: 'openai-tts',
        apiKey: 'sk-studio',
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        baseUrl: 'https://api.openai.com/v1',
      },
    });
  });

  it('leaves auxiliary.tts alone — it stays the default entry', async () => {
    const cfg = await load([
      'auxiliary.tts.provider: kokoro-tts',
      'auxiliary.tts.voice: af_bella',
      'voice.tts.providers.studio.provider: openai-tts',
    ]);
    expect(cfg.auxiliary?.tts).toEqual({ provider: 'kokoro-tts', voice: 'af_bella' });
    expect(cfg.voice?.tts?.providers?.studio).toEqual({ provider: 'openai-tts' });
  });

  it('is absent — with no voice section at all — when no roster key is present', async () => {
    const cfg = await load(['auxiliary.tts.provider: kokoro-tts']);
    expect(cfg.voice).toBeUndefined();
  });

  it('drops an entry that names no provider rather than half-building it', async () => {
    const cfg = await load([
      'voice.tts.providers.broken.voice: alloy',
      'voice.tts.providers.studio.provider: openai-tts',
    ]);
    expect(Object.keys(cfg.voice?.tts?.providers ?? {})).toEqual(['studio']);
  });

  it('drops a nonsense format or number on a roster entry, exactly as auxiliary.tts does', async () => {
    const cfg = await load([
      'voice.tts.providers.studio.provider: openai-tts',
      'voice.tts.providers.studio.outputFormat: flac',
      'voice.tts.providers.studio.timeout: soon',
      'voice.tts.providers.studio.maxTextLength: -5',
    ]);
    expect(cfg.voice?.tts?.providers?.studio).toEqual({ provider: 'openai-tts' });
  });

  it('coexists with voice.bots, the trust gate and the LiveKit block', async () => {
    const cfg = await load([
      'voice.bots.0.match: +15551234567',
      'voice.bots.0.bind.type: personality',
      'voice.bots.0.bind.name: receptionist',
      'voice.trustedPlugins: openai-tts',
      'voice.tts.providers.studio.provider: openai-tts',
    ]);
    expect(cfg.voice?.bots).toHaveLength(1);
    expect(cfg.voice?.trustedPlugins).toEqual(['openai-tts']);
    expect(cfg.voice?.tts?.providers?.studio?.provider).toBe('openai-tts');
  });
});

describe('voice.tts.providers round-trip', () => {
  it('survives write -> read with several entries and every field', async () => {
    const cfg = await load([
      'auxiliary.tts.provider: kokoro-tts',
      'auxiliary.tts.voice: af_bella',
      'voice.tts.providers.mac-say.provider: command-tts',
      'voice.tts.providers.mac-say.command: say -o {output_path} -f {input_path}',
      'voice.tts.providers.mac-say.outputFormat: wav',
      'voice.tts.providers.mac-say.timeout: 45',
      'voice.tts.providers.mac-say.maxTextLength: 2000',
      'voice.tts.providers.studio.provider: openai-tts',
      'voice.tts.providers.studio.model: gpt-4o-mini-tts',
      'voice.tts.providers.studio.voice: alloy',
      'voice.tts.providers.studio.baseUrl: https://api.openai.com/v1',
    ]);

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const reread = await readRawConfig(storage);

    expect(reread?.voice?.tts?.providers).toEqual(cfg.voice?.tts?.providers);
    expect(reread?.auxiliary?.tts).toEqual(cfg.auxiliary?.tts);
  });

  it('externalizes each entry’s apiKey under its OWN ref, and resolves it back', async () => {
    const cfg = await load([
      'voice.tts.providers.studio.provider: openai-tts',
      'voice.tts.providers.studio.apiKey: sk-studio-secret',
      'voice.tts.providers.eleven.provider: elevenlabs',
      'voice.tts.providers.eleven.apiKey: el-secret',
      'voice.tts.providers.mac-say.provider: command-tts',
    ]);

    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, secrets);

    // On disk: refs only. A roster key cannot route a credential past the vault.
    const onDisk = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(onDisk).not.toContain('sk-studio-secret');
    expect(onDisk).not.toContain('el-secret');
    expect(onDisk).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal match, not a template
      'voice.tts.providers.studio.apiKey: ${secrets:voice/tts/providers/studio/apiKey}',
    );
    expect(onDisk).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal match, not a template
      'voice.tts.providers.eleven.apiKey: ${secrets:voice/tts/providers/eleven/apiKey}',
    );

    // In the vault: one ref per entry, no sharing.
    expect(await secrets.get('voice/tts/providers/studio/apiKey')).toBe('sk-studio-secret');
    expect(await secrets.get('voice/tts/providers/eleven/apiKey')).toBe('el-secret');

    // And the read path hands the provider factory a usable key again.
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.voice?.tts?.providers?.studio?.apiKey).toBe('sk-studio-secret');
    expect(resolved?.voice?.tts?.providers?.eleven?.apiKey).toBe('el-secret');
    expect(resolved?.voice?.tts?.providers?.['mac-say']).toEqual({ provider: 'command-tts' });
  });
});

// The older `voice.providers.<name>.*` spelling shipped before STT had a roster
// and may already sit in a hand-written config. It must still load, and a
// re-serialize must produce ONLY the new spelling — never both, or the next
// reader has two sources of truth for one entry.
describe('voice.providers — the older spelling', () => {
  it('loads as the TTS roster', async () => {
    const cfg = await load([
      'voice.providers.studio.provider: openai-tts',
      'voice.providers.studio.voice: alloy',
      'voice.providers.studio.timeout: 45',
    ]);
    expect(cfg.voice?.tts?.providers).toEqual({
      studio: { provider: 'openai-tts', voice: 'alloy', timeout: 45 },
    });
  });

  it('re-serializes to voice.tts.providers, and never emits both', async () => {
    const cfg = await load([
      'voice.providers.studio.provider: openai-tts',
      'voice.providers.studio.voice: alloy',
    ]);

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const onDisk = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';

    expect(onDisk).toContain('voice.tts.providers.studio.provider: openai-tts');
    expect(onDisk).not.toMatch(/^voice\.providers\./m);

    const reread = await readRawConfig(storage);
    expect(reread?.voice?.tts?.providers).toEqual(cfg.voice?.tts?.providers);
  });

  it('loses to the new spelling per field, whichever order they appear in', async () => {
    const newFirst = await load([
      'voice.tts.providers.studio.provider: local-tts',
      'voice.providers.studio.provider: openai-tts',
      'voice.providers.studio.voice: alloy',
    ]);
    const legacyFirst = await load([
      'voice.providers.studio.provider: openai-tts',
      'voice.providers.studio.voice: alloy',
      'voice.tts.providers.studio.provider: local-tts',
    ]);
    // The new key wins on `provider`; the legacy-only `voice` field still rides
    // along, so a half-migrated config is not silently truncated.
    const expected = { studio: { provider: 'local-tts', voice: 'alloy' } };
    expect(newFirst.voice?.tts?.providers).toEqual(expected);
    expect(legacyFirst.voice?.tts?.providers).toEqual(expected);
  });

  it('does not feed the STT roster', async () => {
    const cfg = await load(['voice.providers.studio.provider: openai-tts']);
    expect(cfg.voice?.stt).toBeUndefined();
  });
});
