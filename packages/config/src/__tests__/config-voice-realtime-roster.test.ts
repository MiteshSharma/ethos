import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readConfig, readRawConfig, writeConfig } from '../index';

// `voice.realtime.providers.<name>.*` — the THIRD named roster, plus the three
// scalars that decide which entry a deployment uses (`voice.realtime.default`),
// which engine it prefers (`voice.tier`), and where one session stops
// (`voice.realtime.sessionBudgetUsd`).
//
// The roster assertions deliberately echo config-voice-tts-roster.test.ts and
// config-voice-stt-roster.test.ts case for case: the three rosters run through
// ONE builder and ONE serializer, so if they ever diverge in what they accept,
// drop, or round-trip, one of these three files fails.

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('voice.realtime.providers roster parsing', () => {
  it('parses several entries, each with the full realtime field set', async () => {
    const cfg = await load([
      'voice.realtime.providers.live.provider: openai-realtime',
      'voice.realtime.providers.live.model: gpt-realtime',
      'voice.realtime.providers.live.apiKey: sk-live',
      'voice.realtime.providers.live.voice: cedar',
      'voice.realtime.providers.live.costPerMinuteUsd: 0.06',
      'voice.realtime.providers.gemini.provider: gemini-live',
      'voice.realtime.providers.gemini.baseUrl: https://example.invalid/v1',
    ]);

    expect(cfg.voice?.realtime?.providers).toEqual({
      live: {
        provider: 'openai-realtime',
        model: 'gpt-realtime',
        apiKey: 'sk-live',
        voice: 'cedar',
        costPerMinuteUsd: 0.06,
      },
      gemini: {
        provider: 'gemini-live',
        baseUrl: 'https://example.invalid/v1',
      },
    });
  });

  it('is absent — with no voice section at all — when no realtime key is present', async () => {
    const cfg = await load(['auxiliary.asr.provider: openai-stt']);
    expect(cfg.voice).toBeUndefined();
  });

  it('drops an entry that names no provider rather than half-building it', async () => {
    const cfg = await load([
      'voice.realtime.providers.broken.model: gpt-realtime',
      'voice.realtime.providers.live.provider: openai-realtime',
    ]);
    expect(Object.keys(cfg.voice?.realtime?.providers ?? {})).toEqual(['live']);
  });

  it('drops a nonsense rate, exactly as the other rosters drop a nonsense timeout', async () => {
    const cfg = await load([
      'voice.realtime.providers.live.provider: openai-realtime',
      'voice.realtime.providers.live.costPerMinuteUsd: cheap',
    ]);
    expect(cfg.voice?.realtime?.providers?.live).toEqual({ provider: 'openai-realtime' });
  });

  it('carries no pipeline-only field, even if the operator writes one', async () => {
    const cfg = await load([
      'voice.realtime.providers.live.provider: openai-realtime',
      'voice.realtime.providers.live.command: say -o {output_path}',
      'voice.realtime.providers.live.timeout: 45',
      'voice.realtime.providers.live.outputFormat: wav',
    ]);
    expect(cfg.voice?.realtime?.providers?.live).toEqual({ provider: 'openai-realtime' });
  });

  it('coexists with the TTS and STT rosters under the same voice section', async () => {
    const cfg = await load([
      'voice.tts.providers.studio.provider: openai-tts',
      'voice.stt.providers.spanish.provider: local-stt',
      'voice.realtime.providers.live.provider: openai-realtime',
    ]);
    expect(cfg.voice?.tts?.providers?.studio?.provider).toBe('openai-tts');
    expect(cfg.voice?.stt?.providers?.spanish?.provider).toBe('local-stt');
    expect(cfg.voice?.realtime?.providers?.live?.provider).toBe('openai-realtime');
  });
});

describe('voice.realtime scalars and voice.tier', () => {
  it('parses default, session budget and tier', async () => {
    const cfg = await load([
      'voice.tier: realtime',
      'voice.realtime.default: live',
      'voice.realtime.sessionBudgetUsd: 1.5',
      'voice.realtime.providers.live.provider: openai-realtime',
    ]);
    expect(cfg.voice?.tier).toBe('realtime');
    expect(cfg.voice?.realtime?.default).toBe('live');
    expect(cfg.voice?.realtime?.sessionBudgetUsd).toBe(1.5);
  });

  it('keeps the default and the budget even with no roster typed in yet', async () => {
    const cfg = await load(['voice.realtime.default: live', 'voice.realtime.sessionBudgetUsd: 2']);
    expect(cfg.voice?.realtime).toEqual({ default: 'live', sessionBudgetUsd: 2 });
    expect(cfg.voice?.realtime?.providers).toBeUndefined();
  });

  it('ignores an unknown tier instead of failing the load', async () => {
    const cfg = await load(['voice.tier: telepathy', 'voice.defaultMode: all']);
    expect(cfg.voice?.tier).toBeUndefined();
    expect(cfg.voice?.defaultMode).toBe('all');
  });

  it('ignores a nonsense session budget', async () => {
    const cfg = await load(['voice.realtime.sessionBudgetUsd: lots', 'voice.tier: pipeline']);
    expect(cfg.voice?.realtime).toBeUndefined();
    expect(cfg.voice?.tier).toBe('pipeline');
  });

  it('does not let voice.realtime.default swallow a roster line, or vice versa', async () => {
    const cfg = await load([
      'voice.realtime.providers.default.provider: openai-realtime',
      'voice.realtime.default: default',
    ]);
    expect(cfg.voice?.realtime?.default).toBe('default');
    expect(cfg.voice?.realtime?.providers?.default).toEqual({ provider: 'openai-realtime' });
  });
});

describe('voice.realtime round-trip', () => {
  it('survives write -> read with every key a hand-written config can carry', async () => {
    const cfg = await load([
      'voice.tier: realtime',
      'voice.realtime.default: live',
      'voice.realtime.sessionBudgetUsd: 0.75',
      'voice.realtime.providers.live.provider: openai-realtime',
      'voice.realtime.providers.live.model: gpt-realtime',
      'voice.realtime.providers.live.voice: cedar',
      'voice.realtime.providers.live.costPerMinuteUsd: 0.06',
      'voice.realtime.providers.gemini.provider: gemini-live',
      'voice.realtime.providers.gemini.baseUrl: https://example.invalid/v1',
    ]);

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const reread = await readRawConfig(storage);

    expect(reread?.voice?.realtime).toEqual(cfg.voice?.realtime);
    expect(reread?.voice?.tier).toBe('realtime');
  });

  it('externalizes each entry’s apiKey under its OWN ref, and resolves it back', async () => {
    const cfg = await load([
      'voice.realtime.providers.live.provider: openai-realtime',
      'voice.realtime.providers.live.apiKey: sk-live-secret',
      'voice.realtime.providers.gemini.provider: gemini-live',
      'voice.realtime.providers.gemini.apiKey: gemini-secret',
    ]);

    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, secrets);

    const onDisk = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(onDisk).not.toContain('sk-live-secret');
    expect(onDisk).not.toContain('gemini-secret');
    expect(onDisk).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal match, not a template
      'voice.realtime.providers.live.apiKey: ${secrets:voice/realtime/providers/live/apiKey}',
    );

    expect(await secrets.get('voice/realtime/providers/live/apiKey')).toBe('sk-live-secret');
    expect(await secrets.get('voice/realtime/providers/gemini/apiKey')).toBe('gemini-secret');

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.voice?.realtime?.providers?.live?.apiKey).toBe('sk-live-secret');
    expect(resolved?.voice?.realtime?.providers?.gemini?.apiKey).toBe('gemini-secret');
  });

  it('keeps same-named TTS, STT and realtime entries on separate vault refs', async () => {
    const cfg = await load([
      'voice.tts.providers.house.provider: openai-tts',
      'voice.tts.providers.house.apiKey: tts-secret',
      'voice.stt.providers.house.provider: openai-stt',
      'voice.stt.providers.house.apiKey: stt-secret',
      'voice.realtime.providers.house.provider: openai-realtime',
      'voice.realtime.providers.house.apiKey: realtime-secret',
    ]);

    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, secrets);

    expect(await secrets.get('voice/tts/providers/house/apiKey')).toBe('tts-secret');
    expect(await secrets.get('voice/stt/providers/house/apiKey')).toBe('stt-secret');
    expect(await secrets.get('voice/realtime/providers/house/apiKey')).toBe('realtime-secret');
  });

  it('keeps the scalars when the roster is empty', async () => {
    const cfg = await load(['voice.realtime.default: live', 'voice.realtime.sessionBudgetUsd: 3']);

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const reread = await readRawConfig(storage);

    expect(reread?.voice?.realtime).toEqual({ default: 'live', sessionBudgetUsd: 3 });
  });
});
