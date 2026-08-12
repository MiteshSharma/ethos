import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readConfig, readRawConfig, writeConfig } from '../index';

// `voice.stt.providers.<name>.*` — the named STT roster, the exact mirror of
// the TTS one. Each entry carries the `auxiliary.asr` field set, because it IS
// one — `auxiliary.asr` stays the default entry and is untouched by any of this.
//
// The assertions here deliberately echo config-voice-tts-roster.test.ts case
// for case: if the two rosters ever diverge in what they accept, drop, or
// round-trip, one of these two files fails.

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('voice.stt.providers roster parsing', () => {
  it('parses several entries, each with the full auxiliary.asr field set', async () => {
    const cfg = await load([
      'voice.stt.providers.whisper-cli.provider: command-stt',
      'voice.stt.providers.whisper-cli.command: whisper-cli -f {input_path} -o {output_path}',
      'voice.stt.providers.whisper-cli.timeout: 45',
      'voice.stt.providers.spanish.provider: local-stt',
      'voice.stt.providers.spanish.apiKey: sk-es',
      'voice.stt.providers.spanish.model: Systran/faster-whisper-large-v3',
      'voice.stt.providers.spanish.baseUrl: http://localhost:8000/v1',
    ]);

    expect(cfg.voice?.stt?.providers).toEqual({
      'whisper-cli': {
        provider: 'command-stt',
        command: 'whisper-cli -f {input_path} -o {output_path}',
        timeout: 45,
      },
      spanish: {
        provider: 'local-stt',
        apiKey: 'sk-es',
        model: 'Systran/faster-whisper-large-v3',
        baseUrl: 'http://localhost:8000/v1',
      },
    });
  });

  it('leaves auxiliary.asr alone — it stays the default entry', async () => {
    const cfg = await load([
      'auxiliary.asr.provider: openai-stt',
      'auxiliary.asr.model: whisper-1',
      'voice.stt.providers.spanish.provider: local-stt',
    ]);
    expect(cfg.auxiliary?.asr).toEqual({ provider: 'openai-stt', model: 'whisper-1' });
    expect(cfg.voice?.stt?.providers?.spanish).toEqual({ provider: 'local-stt' });
  });

  it('is absent — with no voice section at all — when no roster key is present', async () => {
    const cfg = await load(['auxiliary.asr.provider: openai-stt']);
    expect(cfg.voice).toBeUndefined();
  });

  it('drops an entry that names no provider rather than half-building it', async () => {
    const cfg = await load([
      'voice.stt.providers.broken.model: whisper-1',
      'voice.stt.providers.spanish.provider: local-stt',
    ]);
    expect(Object.keys(cfg.voice?.stt?.providers ?? {})).toEqual(['spanish']);
  });

  it('drops a nonsense number on a roster entry, exactly as auxiliary.asr does', async () => {
    const cfg = await load([
      'voice.stt.providers.spanish.provider: local-stt',
      'voice.stt.providers.spanish.timeout: soon',
    ]);
    expect(cfg.voice?.stt?.providers?.spanish).toEqual({ provider: 'local-stt' });
  });

  it('carries no TTS-only field, even if the operator writes one', async () => {
    const cfg = await load([
      'voice.stt.providers.spanish.provider: local-stt',
      'voice.stt.providers.spanish.voice: alloy',
      'voice.stt.providers.spanish.outputFormat: wav',
      'voice.stt.providers.spanish.maxTextLength: 2000',
    ]);
    expect(cfg.voice?.stt?.providers?.spanish).toEqual({ provider: 'local-stt' });
  });

  it('coexists with the TTS roster under the same voice section', async () => {
    const cfg = await load([
      'voice.tts.providers.studio.provider: openai-tts',
      'voice.stt.providers.spanish.provider: local-stt',
      'voice.trustedPlugins: openai-tts',
    ]);
    expect(cfg.voice?.tts?.providers?.studio?.provider).toBe('openai-tts');
    expect(cfg.voice?.stt?.providers?.spanish?.provider).toBe('local-stt');
    expect(cfg.voice?.trustedPlugins).toEqual(['openai-tts']);
  });
});

describe('voice.stt.providers round-trip', () => {
  it('survives write -> read with several entries and every field', async () => {
    const cfg = await load([
      'auxiliary.asr.provider: openai-stt',
      'auxiliary.asr.model: whisper-1',
      'voice.stt.providers.whisper-cli.provider: command-stt',
      'voice.stt.providers.whisper-cli.command: whisper-cli -f {input_path} -o {output_path}',
      'voice.stt.providers.whisper-cli.timeout: 45',
      'voice.stt.providers.spanish.provider: local-stt',
      'voice.stt.providers.spanish.model: faster-whisper',
      'voice.stt.providers.spanish.baseUrl: http://localhost:8000/v1',
    ]);

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const reread = await readRawConfig(storage);

    expect(reread?.voice?.stt?.providers).toEqual(cfg.voice?.stt?.providers);
    expect(reread?.auxiliary?.asr).toEqual(cfg.auxiliary?.asr);
  });

  it('externalizes each entry’s apiKey under its OWN ref, and resolves it back', async () => {
    const cfg = await load([
      'voice.stt.providers.spanish.provider: local-stt',
      'voice.stt.providers.spanish.apiKey: sk-spanish-secret',
      'voice.stt.providers.groq.provider: groq-stt',
      'voice.stt.providers.groq.apiKey: gsk-secret',
      'voice.stt.providers.whisper-cli.provider: command-stt',
    ]);

    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, secrets);

    // On disk: refs only. A roster key cannot route a credential past the vault.
    const onDisk = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(onDisk).not.toContain('sk-spanish-secret');
    expect(onDisk).not.toContain('gsk-secret');
    expect(onDisk).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal match, not a template
      'voice.stt.providers.spanish.apiKey: ${secrets:voice/stt/providers/spanish/apiKey}',
    );
    expect(onDisk).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal match, not a template
      'voice.stt.providers.groq.apiKey: ${secrets:voice/stt/providers/groq/apiKey}',
    );

    // In the vault: one ref per entry, no sharing — and no collision with a TTS
    // entry that happens to share a name.
    expect(await secrets.get('voice/stt/providers/spanish/apiKey')).toBe('sk-spanish-secret');
    expect(await secrets.get('voice/stt/providers/groq/apiKey')).toBe('gsk-secret');

    // And the read path hands the provider factory a usable key again.
    const resolved = await readConfig(storage, secrets);
    expect(resolved?.voice?.stt?.providers?.spanish?.apiKey).toBe('sk-spanish-secret');
    expect(resolved?.voice?.stt?.providers?.groq?.apiKey).toBe('gsk-secret');
    expect(resolved?.voice?.stt?.providers?.['whisper-cli']).toEqual({ provider: 'command-stt' });
  });

  it('keeps same-named TTS and STT entries on separate vault refs', async () => {
    const cfg = await load([
      'voice.tts.providers.house.provider: openai-tts',
      'voice.tts.providers.house.apiKey: tts-secret',
      'voice.stt.providers.house.provider: openai-stt',
      'voice.stt.providers.house.apiKey: stt-secret',
    ]);

    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, secrets);

    expect(await secrets.get('voice/tts/providers/house/apiKey')).toBe('tts-secret');
    expect(await secrets.get('voice/stt/providers/house/apiKey')).toBe('stt-secret');
  });
});
