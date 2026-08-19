import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import {
  ConfigService,
  type ConfigUpdateInput,
  readLegacyBrowserBargeInTuning,
  redactKey,
} from '../../services/config.service';

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

describe('readLegacyBrowserBargeInTuning', () => {
  it('returns nothing when no display.voice_* key is set', () => {
    expect(readLegacyBrowserBargeInTuning({})).toEqual({});
  });

  it('maps the three barge-relevant display.voice_* keys onto VoiceBargeInTuning', () => {
    expect(
      readLegacyBrowserBargeInTuning({
        'display.voice_barge_threshold': '0.08',
        'display.voice_barge_sustain_ms': '300',
        'display.voice_endpoint_silence_ms': '900',
      }),
    ).toEqual({ energyThreshold: 0.08, minSpeechMs: 300, silenceMs: 900 });
  });

  // These tuned the browser's own local endpointer, which the streaming
  // pipeline lane no longer has — there is nothing for them to map onto.
  it('ignores display.voice_speech_threshold / display.voice_speech_min_ms', () => {
    expect(
      readLegacyBrowserBargeInTuning({
        'display.voice_speech_threshold': '0.05',
        'display.voice_speech_min_ms': '250',
      }),
    ).toEqual({});
  });

  it('clamps an out-of-range value to the VOICE_TUNING bounds', () => {
    expect(readLegacyBrowserBargeInTuning({ 'display.voice_barge_threshold': '5' })).toEqual({
      energyThreshold: 0.2,
    });
  });

  it('ignores an unparseable value', () => {
    expect(
      readLegacyBrowserBargeInTuning({ 'display.voice_endpoint_silence_ms': 'not-a-number' }),
    ).toEqual({});
  });
});

const DATA = '/data';

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('ConfigService', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let repo: ConfigRepository;
  let service: ConfigService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    service = new ConfigService({ config: repo, secrets });
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
    // Credentials are preserved as vault references, never as literals.
    expect(written).toContain(`telegramToken: "${secretRef('telegram/token')}"`);
    expect(written).toContain(`slackBotToken: "${secretRef('slack/botToken')}"`);
    expect(await secrets.get('telegram/token')).toBe('tg-1234567890');
    expect(await secrets.get('slack/botToken')).toBe('xoxb-abc');
    // The apiKey wasn't part of the patch — must remain.
    expect(written).toContain(`apiKey: "${secretRef('providers/anthropic/apiKey')}"`);
    expect(await secrets.get('providers/anthropic/apiKey')).toBe('sk-anthropic-1234567890abcdef');
    expect(written).not.toContain('sk-anthropic-1234567890abcdef');
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
    expect(written).toContain(`apiKey: "${secretRef('providers/anthropic/apiKey')}"`);
    expect(await secrets.get('providers/anthropic/apiKey')).toBe('sk-keep-this');
  });

  it('get returns providers with redacted keys', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-anthropic-1234567890abcdef',
        'personality: researcher',
        'providers.0.provider: anthropic',
        'providers.0.apiKey: sk-anthropic-1234567890abcdef',
        'providers.0.model: claude-opus-4-7',
        'providers.1.provider: openrouter',
        'providers.1.apiKey: sk-or-testkey-abcdef1234',
        'providers.1.model: gpt-4',
      ].join('\n'),
    );

    const result = await service.get();
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]?.apiKeyPreview).toBe('sk-…cdef');
    expect(result.providers[0]?.provider).toBe('anthropic');
    expect(result.providers[0]?.model).toBe('claude-opus-4-7');
    expect(result.providers[1]?.apiKeyPreview).toBe('sk-…1234');
    expect(result.providers[1]?.provider).toBe('openrouter');
    // Raw keys must never appear
    expect(JSON.stringify(result)).not.toContain('1234567890abcdef');
    expect(JSON.stringify(result)).not.toContain('testkey-abcdef1234');
  });

  it('get returns empty providers array when none are configured', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: claude-opus-4-7', 'personality: researcher'].join('\n'),
    );

    const result = await service.get();
    expect(result.providers).toEqual([]);
  });

  it('update can replace the apiKey when a non-empty value is supplied', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-old', 'personality: researcher'].join('\n'),
    );
    await service.update({ apiKey: 'sk-new-key-12345' });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain(`apiKey: "${secretRef('providers/anthropic/apiKey')}"`);
    expect(written).not.toContain('sk-new-key-12345');
    expect(written).not.toContain('sk-old');
    expect(await secrets.get('providers/anthropic/apiKey')).toBe('sk-new-key-12345');
  });

  it('update translates adminEnabled into the admin.enabled passthrough key', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep', 'personality: researcher'].join('\n'),
    );

    await service.update({ adminEnabled: true });
    let written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('admin.enabled: true');

    await service.update({ adminEnabled: false });
    written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('admin.enabled: false');
  });

  it('get returns behavior-flag defaults when the keys are absent', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep', 'personality: researcher'].join('\n'),
    );

    const result = await service.get();
    expect(result.streamingEdits).toBe('dms');
    // Context-economy Phase 2 — autoCompact defaults ON when the key is absent.
    expect(result.autoCompact).toBe(true);
    expect(result.memoryConsolidationEnabled).toBe(false);
    expect(result.memoryCaptureEnabled).toBe(false);
    expect(result.memoryCaptureModel).toBeNull();
    expect(result.memoryNotices).toBe(false);
    // Call Stage: shape and colour both follow the personality by default.
    expect(result.callStyle).toBe('personality');
    expect(result.callAccent).toBe('personality');
  });

  it('persists the call-overlay keys and refuses a color that is not a color', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep', 'personality: researcher'].join('\n'),
    );

    await service.update({ callStyle: 'orb', callAccent: '#E879F9' });
    let written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('display.call_style: orb');
    expect(written).toContain('display.call_accent: "#E879F9"');
    let result = await service.get();
    expect(result.callStyle).toBe('orb');
    expect(result.callAccent).toBe('#E879F9');

    // A hand-typed non-color resolves to the personality accent rather than
    // reaching a canvas fillStyle.
    await service.update({ callAccent: 'chartreuse' });
    written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('display.call_accent: personality');
    result = await service.get();
    expect(result.callAccent).toBe('personality');
  });

  it('get reads the behavior flags from their flat config keys', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk-keep',
        'personality: researcher',
        'display.streaming_edits: all',
        'compaction.autoCompact: true',
        'memoryConsolidation.enabled: true',
        'memoryCapture.enabled: true',
        'memoryCapture.model: claude-haiku-4-5-20251001',
        'display.memory_notices: true',
      ].join('\n'),
    );

    const result = await service.get();
    expect(result.streamingEdits).toBe('all');
    expect(result.autoCompact).toBe(true);
    expect(result.memoryConsolidationEnabled).toBe(true);
    expect(result.memoryCaptureEnabled).toBe(true);
    expect(result.memoryCaptureModel).toBe('claude-haiku-4-5-20251001');
    expect(result.memoryNotices).toBe(true);
  });

  it('update persists each behavior flag to its flat config key', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep', 'personality: researcher'].join('\n'),
    );

    await service.update({
      streamingEdits: 'off',
      autoCompact: true,
      memoryConsolidationEnabled: true,
      memoryCaptureEnabled: true,
      memoryCaptureModel: 'claude-haiku-4-5-20251001',
      memoryNotices: true,
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('display.streaming_edits: off');
    expect(written).toContain('compaction.autoCompact: true');
    expect(written).toContain('memoryConsolidation.enabled: true');
    expect(written).toContain('memoryCapture.enabled: true');
    expect(written).toContain('memoryCapture.model: claude-haiku-4-5-20251001');
    expect(written).toContain('display.memory_notices: true');

    // Round-trips back through get.
    const result = await service.get();
    expect(result.streamingEdits).toBe('off');
    expect(result.autoCompact).toBe(true);
    expect(result.memoryCaptureModel).toBe('claude-haiku-4-5-20251001');
  });

  it('get returns voice-tuning defaults when the keys are absent', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep', 'personality: researcher'].join('\n'),
    );

    const result = await service.get();
    expect(result.voiceEndpointSilenceMs).toBe(700);
    expect(result.voiceBargeThreshold).toBe(0.06);
    expect(result.voiceBargeSustainMs).toBe(250);
    expect(result.voiceSpeechThreshold).toBe(0.02);
    expect(result.voiceSpeechMinMs).toBe(150);
  });

  it('get reads voice-tuning values from their flat config keys', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk-keep',
        'personality: researcher',
        'display.voice_endpoint_silence_ms: 900',
        'display.voice_barge_threshold: 0.08',
        'display.voice_speech_min_ms: 200',
      ].join('\n'),
    );

    const result = await service.get();
    expect(result.voiceEndpointSilenceMs).toBe(900);
    expect(result.voiceBargeThreshold).toBe(0.08);
    expect(result.voiceSpeechMinMs).toBe(200);
    // Untouched keys still resolve to their defaults.
    expect(result.voiceBargeSustainMs).toBe(250);
    expect(result.voiceSpeechThreshold).toBe(0.02);
  });

  it('update writes voice-tuning values to their flat config keys and round-trips', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep', 'personality: researcher'].join('\n'),
    );

    await service.update({ voiceEndpointSilenceMs: 1000, voiceSpeechMinMs: 300 });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('display.voice_endpoint_silence_ms: 1000');
    expect(written).toContain('display.voice_speech_min_ms: 300');

    const result = await service.get();
    expect(result.voiceEndpointSilenceMs).toBe(1000);
    expect(result.voiceSpeechMinMs).toBe(300);
  });

  it('update clamps out-of-range voice-tuning values to the allowed bounds', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep', 'personality: researcher'].join('\n'),
    );

    // Below min (300) and above max (0.2) respectively.
    await service.update({ voiceEndpointSilenceMs: 50, voiceBargeThreshold: 5 });

    const result = await service.get();
    expect(result.voiceEndpointSilenceMs).toBe(300);
    expect(result.voiceBargeThreshold).toBe(0.2);
  });

  it('accepts memory: vault and round-trips it', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      ['provider: anthropic', 'model: m', 'apiKey: sk-keep-this1', 'personality: researcher'].join(
        '\n',
      ),
    );
    await service.update({ memory: 'vault' });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('memory: vault');
    expect((await service.get()).memory).toBe('vault');
  });

  it('update memoryConsolidationEnabled preserves sibling memoryConsolidation.* keys', async () => {
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk-keep',
        'personality: researcher',
        'memoryConsolidation.halfLifeDays: 45',
        'memoryConsolidation.threshold: 0.1',
        'memoryConsolidation.exemptUser: false',
        'memoryConsolidation.flushThreshold: 0.6',
      ].join('\n'),
    );

    await service.update({ memoryConsolidationEnabled: true });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('memoryConsolidation.enabled: true');
    // The decay-tuning + flush siblings must survive the round-trip untouched.
    expect(written).toContain('memoryConsolidation.halfLifeDays: 45');
    expect(written).toContain('memoryConsolidation.threshold: 0.1');
    expect(written).toContain('memoryConsolidation.exemptUser: false');
    expect(written).toContain('memoryConsolidation.flushThreshold: 0.6');
  });
});

describe('ConfigService — settings passthrough groups', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let repo: ConfigRepository;
  let service: ConfigService;

  const writeBase = async (extra: string[] = []) => {
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk-keep-this1',
        'personality: researcher',
        ...extra,
      ].join('\n'),
    );
  };

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    service = new ConfigService({ config: repo, secrets });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('get returns settings defaults when the keys are absent', async () => {
    await writeBase();
    const r = await service.get();
    expect(r.compaction).toEqual({
      pressure: null,
      target: null,
      gateDelta: null,
      retryOnOverflow: true,
      smallWindow: 'auto',
    });
    expect(r.memoryApproval).toEqual({ mode: 'off', cap: 200, ttlDays: 30 });
    expect(r.memoryConsolidation.halfLifeDays).toBe(30);
    expect(r.memoryConsolidation.exemptUser).toBe(true);
    expect(r.memoryCapture.maxPerHour).toBe(6);
    expect(r.background.maxConcurrentJobs).toBe(2);
    expect(r.background.enabled).toBe(false);
    expect(r.displayVerbosity).toBe('default');
    expect(r.displayResumeHint).toBe(true);
    expect(r.displayResumeRecapTurns).toBe(3);
    expect(r.verbose).toBe(false);
    expect(r.nightlyPass).toEqual({ enabled: false, cron: '0 3 * * *' });
    expect(r.weeklyDigest).toEqual({ enabled: false, cron: '0 9 * * 1', recipients: [] });
    expect(r.modelCatalog).toEqual({ enabled: true, url: null, ttlHours: 24 });
    expect(r.logsRotation).toEqual({ enabled: true, maxBytes: null, maxFiles: null });
    expect(r.retention).toEqual({});
    expect(r.personalityRetention).toEqual({});
    expect(r.webhooks).toEqual({});
    expect(r.quickCommands).toEqual({});
    expect(r.channelToolsets).toEqual({});
    expect(r.webSearchBackend).toBeNull();
    expect(r.auxCompression).toEqual({
      model: null,
      provider: null,
      apiKeyPreview: null,
      baseUrl: null,
    });
    expect(r.a2aEnabled).toBe(false);
    expect(r.pluginsAutoInstall).toBeNull();
    expect(r.webBaseUrl).toBeNull();
    expect(r.apiVersion).toBeNull();
  });

  it('round-trips compaction, display, and misc scalars', async () => {
    await writeBase();
    await service.update({
      compaction: {
        pressure: 0.85,
        target: 0.7,
        gateDelta: 2000,
        retryOnOverflow: false,
        smallWindow: 'on',
      },
      displayVerbosity: 'quiet',
      displayBusyInputMode: 'queue',
      displayResumeRecapTurns: 5,
      displayBellOnComplete: true,
      verbose: true,
      apiVersion: '2024-10-21',
      a2aEnabled: true,
      pluginsAutoInstall: false,
      webSearchBackend: 'exa',
      webBaseUrl: 'https://ethos.example.com',
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('compaction.pressure: 0.85');
    expect(written).toContain('compaction.gateDelta: 2000');
    expect(written).toContain('compaction.retryOnOverflow: false');
    expect(written).toContain('compaction.smallWindow: on');
    expect(written).toContain('display.verbosity: quiet');
    expect(written).toContain('display.busy_input_mode: queue');
    expect(written).toContain('display.resume_recap_turns: 5');
    expect(written).toContain('display.bell_on_complete: true');
    expect(written).toContain('verbose: true');
    expect(written).toContain('a2a.enabled: true');
    expect(written).toContain('plugins.auto_install: false');
    expect(written).toContain('web.search_backend: exa');

    const r = await service.get();
    expect(r.compaction).toEqual({
      pressure: 0.85,
      target: 0.7,
      gateDelta: 2000,
      retryOnOverflow: false,
      smallWindow: 'on',
    });
    expect(r.displayVerbosity).toBe('quiet');
    expect(r.displayBusyInputMode).toBe('queue');
    expect(r.displayResumeRecapTurns).toBe(5);
    expect(r.displayBellOnComplete).toBe(true);
    expect(r.verbose).toBe(true);
    expect(r.apiVersion).toBe('2024-10-21');
    expect(r.a2aEnabled).toBe(true);
    expect(r.pluginsAutoInstall).toBe(false);
    expect(r.webSearchBackend).toBe('exa');
    expect(r.webBaseUrl).toBe('https://ethos.example.com');
  });

  it('null clears a scalar key back to its default', async () => {
    await writeBase(['compaction.pressure: 0.9', 'display.verbosity: quiet']);
    await service.update({ compaction: { pressure: null }, displayVerbosity: null });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('compaction.pressure');
    expect(written).not.toContain('display.verbosity');
    const r = await service.get();
    expect(r.compaction.pressure).toBeNull();
    expect(r.displayVerbosity).toBe('default');
  });

  it('round-trips the memory groups and masks the capture key', async () => {
    await writeBase();
    await service.update({
      memory: 'vault',
      memoryVault: {
        path: '/vaults/obsidian',
        agentDir: 'Ethos',
        prefetch: ['MEMORY.md', 'USER.md'],
        exclude: ['Archive'],
      },
      memoryApproval: { mode: 'automated', cap: 100, ttlDays: 14 },
      memoryConsolidation: { halfLifeDays: 45, flushThreshold: 0.6 },
      memoryCapture: { provider: 'openrouter', apiKey: 'sk-or-capturekey-1234', maxPerHour: 10 },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('memoryVault.path: /vaults/obsidian');
    expect(written).toContain('memoryVault.prefetch: MEMORY.md, USER.md');
    expect(written).toContain('memoryApproval.mode: automated');
    expect(written).toContain('memoryConsolidation.halfLifeDays: 45');
    expect(written).toContain('memoryCapture.maxPerHour: 10');

    const r = await service.get();
    expect(r.memory).toBe('vault');
    expect(r.memoryVault).toEqual({
      path: '/vaults/obsidian',
      agentDir: 'Ethos',
      prefetch: ['MEMORY.md', 'USER.md'],
      exclude: ['Archive'],
    });
    expect(r.memoryApproval).toEqual({ mode: 'automated', cap: 100, ttlDays: 14 });
    expect(r.memoryConsolidation.halfLifeDays).toBe(45);
    expect(r.memoryConsolidation.flushThreshold).toBe(0.6);
    expect(r.memoryCapture.provider).toBe('openrouter');
    expect(r.memoryCapture.maxPerHour).toBe(10);
    expect(r.memoryCapture.apiKeyPreview).toBe('sk-…1234');
    expect(JSON.stringify(r)).not.toContain('capturekey');
  });

  it('round-trips background job-pool caps under their snake_case keys', async () => {
    await writeBase();
    await service.update({
      background: { enabled: true, maxConcurrentJobs: 4, defaultMaxCostUsd: 2.5 },
    });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('background.enabled: true');
    expect(written).toContain('background.max_concurrent_jobs: 4');
    expect(written).toContain('background.default_max_cost_usd: 2.5');
    const r = await service.get();
    expect(r.background.enabled).toBe(true);
    expect(r.background.maxConcurrentJobs).toBe(4);
    expect(r.background.defaultMaxCostUsd).toBe(2.5);
    // Untouched caps resolve to their defaults.
    expect(r.background.maxJobsPerRoot).toBe(3);
  });

  it('webhooks: generates a secret when absent, masks it in get, preserves it across updates', async () => {
    await writeBase();
    await service.update({
      webhooks: {
        alerts: {
          personalityId: 'researcher',
          prefilter: 'filter.sh',
          prefilterTimeoutSeconds: 45,
          mode: 'ack',
        },
      },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    const secretMatch = written?.match(/webhooks\.alerts\.secret: (\S+)/);
    const secret = secretMatch?.[1] ?? '';
    expect(secret.length).toBeGreaterThanOrEqual(8);
    expect(written).toContain('webhooks.alerts.personalityId: researcher');
    expect(written).toContain('webhooks.alerts.prefilterTimeoutSeconds: 45');
    expect(written).toContain('webhooks.alerts.mode: ack');

    const r = await service.get();
    expect(r.webhooks.alerts?.personalityId).toBe('researcher');
    expect(r.webhooks.alerts?.prefilter).toBe('filter.sh');
    expect(r.webhooks.alerts?.prefilterTimeoutSeconds).toBe(45);
    expect(r.webhooks.alerts?.mode).toBe('ack');
    // The raw secret never leaves the service.
    expect(JSON.stringify(r)).not.toContain(secret);

    // Second update omits `secret` → the stored one survives; omitted fields
    // are removed (records are full replacements).
    await service.update({ webhooks: { alerts: { personalityId: 'engineer' } } });
    const written2 = await storage.read(join(DATA, 'config.yaml'));
    expect(written2).toContain(`webhooks.alerts.secret: ${secret}`);
    expect(written2).toContain('webhooks.alerts.personalityId: engineer');
    expect(written2).not.toContain('webhooks.alerts.prefilter');

    // Empty record removes every hook.
    await service.update({ webhooks: {} });
    const written3 = await storage.read(join(DATA, 'config.yaml'));
    expect(written3).not.toContain('webhooks.');
  });

  it('webhooks: removing a hook deletes the vault entry its config key referenced', async () => {
    await writeBase();
    await service.update({
      webhooks: {
        alerts: { personalityId: 'researcher' },
        builds: { personalityId: 'researcher' },
      },
    });
    expect(await secrets.list()).toEqual(
      expect.arrayContaining(['webhooks/alerts/secret', 'webhooks/builds/secret']),
    );

    await service.update({ webhooks: { builds: { personalityId: 'researcher' } } });

    const listed = await secrets.list();
    expect(listed).not.toContain('webhooks/alerts/secret');
    // The survivor's material is untouched.
    expect(listed).toContain('webhooks/builds/secret');
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('webhooks.alerts.');
    expect(written).toContain(`webhooks.builds.secret: "${secretRef('webhooks/builds/secret')}"`);
  });

  it('webhooks: keeps a ref a surviving hook still points at', async () => {
    // Only reachable via a hand-edited config.yaml — minted refs embed the
    // webhook id — but a shared ref must never be deleted out from under
    // the hook that still reads it.
    const shared = 'webhooks/alerts/secret';
    await secrets.set(shared, 'shhh');
    await writeBase([
      'webhooks.alerts.personalityId: researcher',
      `webhooks.alerts.secret: ${secretRef(shared)}`,
      'webhooks.builds.personalityId: researcher',
      `webhooks.builds.secret: ${secretRef(shared)}`,
    ]);

    await service.update({ webhooks: { builds: { personalityId: 'researcher' } } });

    expect(await secrets.list()).toContain(shared);
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('webhooks.alerts.');
    expect(written).toContain(`webhooks.builds.secret: "${secretRef(shared)}"`);
  });

  it('webhooks: a failing vault delete surfaces, and the config change still stands', async () => {
    await writeBase();
    await service.update({ webhooks: { alerts: { personalityId: 'researcher' } } });
    vi.spyOn(secrets, 'delete').mockRejectedValue(new Error('vault is read-only'));

    await expect(service.update({ webhooks: {} })).rejects.toThrow('vault is read-only');

    // config.yaml is the source of truth and was written first: the hook is gone.
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('webhooks.');
  });

  it('round-trips quick commands, channel toolsets, and retention with replace semantics', async () => {
    await writeBase();
    await service.update({
      quickCommands: {
        status: { type: 'exec', command: 'git status', gateway: true, channels: ['telegram'] },
        hi: { type: 'reply', reply: 'hello' },
      },
      channelToolsets: { whatsapp: ['read_file', 'memory_read'] },
      retention: { messages: '180d', 'events.error': '30d' },
      personalityRetention: { researcher: { messages: '30d' } },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('quick_commands.status.type: exec');
    expect(written).toContain('quick_commands.status.gateway: true');
    expect(written).toContain('quick_commands.status.channels: telegram');
    expect(written).toContain('quick_commands.hi.reply: hello');
    expect(written).toContain('channel_toolsets.whatsapp: read_file,memory_read');
    expect(written).toContain('retention.messages: 180d');
    expect(written).toContain('retention.events.error: 30d');
    expect(written).toContain('personalities.researcher.retention.messages: 30d');

    const r = await service.get();
    expect(r.quickCommands.status).toEqual({
      type: 'exec',
      command: 'git status',
      gateway: true,
      channels: ['telegram'],
    });
    expect(r.quickCommands.hi).toEqual({
      type: 'reply',
      reply: 'hello',
      gateway: false,
      channels: [],
    });
    expect(r.channelToolsets).toEqual({ whatsapp: ['read_file', 'memory_read'] });
    expect(r.retention).toEqual({ messages: '180d', 'events.error': '30d' });
    expect(r.personalityRetention).toEqual({ researcher: { messages: '30d' } });

    // Replacement drops entries absent from the new record.
    await service.update({ retention: { traces: '7d' } });
    const written2 = await storage.read(join(DATA, 'config.yaml'));
    expect(written2).not.toContain('retention.messages: 180d');
    expect(written2).toContain('retention.traces: 7d');
    // Per-personality retention was NOT part of the patch — untouched.
    expect(written2).toContain('personalities.researcher.retention.messages: 30d');
    expect((await service.get()).retention).toEqual({ traces: '7d' });
  });

  it('round-trips hyphenated record keys (kebab-case webhook and personality ids)', async () => {
    await writeBase();
    await service.update({
      webhooks: {
        'github-prs': { personalityId: 'my-agent', secret: 'hook-secret-1234', mode: 'sync' },
      },
      personalityRetention: { 'my-agent': { messages: '14d' } },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('webhooks.github-prs.personalityId: my-agent');
    expect(written).toContain('personalities.my-agent.retention.messages: 14d');

    const r = await service.get();
    expect(r.webhooks['github-prs']?.personalityId).toBe('my-agent');
    expect(r.webhooks['github-prs']?.mode).toBe('sync');
    expect(r.personalityRetention).toEqual({ 'my-agent': { messages: '14d' } });
  });

  it('round-trips nightlyPass, weeklyDigest, modelCatalog, logsRotation, and aux slots', async () => {
    await writeBase();
    await service.update({
      nightlyPass: { enabled: true, cron: '0 4 * * *' },
      weeklyDigest: { enabled: true, recipients: ['a@x.com', 'b@y.com'] },
      modelCatalog: { enabled: false, ttlHours: 12 },
      logsRotation: { maxBytes: 1048576, maxFiles: 3 },
      auxCompression: { model: 'claude-haiku-4-5', apiKey: 'sk-aux-compkey-9999' },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('nightlyPass.enabled: true');
    // Values with YAML-special chars are emitted quoted; reads strip quotes.
    expect(written).toContain('nightlyPass.cron: "0 4 * * *"');
    expect(written).toContain('modelCatalog.enabled: false');
    expect(written).toContain('logs.rotation.maxBytes: 1048576');
    expect(written).toContain('auxiliary.compression.model: claude-haiku-4-5');

    const r = await service.get();
    expect(r.nightlyPass).toEqual({ enabled: true, cron: '0 4 * * *' });
    expect(r.weeklyDigest).toEqual({
      enabled: true,
      cron: '0 9 * * 1',
      recipients: ['a@x.com', 'b@y.com'],
    });
    expect(r.modelCatalog).toEqual({ enabled: false, url: null, ttlHours: 12 });
    expect(r.logsRotation).toEqual({ enabled: true, maxBytes: 1048576, maxFiles: 3 });
    expect(r.auxCompression.model).toBe('claude-haiku-4-5');
    expect(r.auxCompression.apiKeyPreview).toBe('sk-…9999');
    expect(JSON.stringify(r)).not.toContain('compkey');
  });

  it('rejects invalid values with CONFIG_INVALID', async () => {
    await writeBase();
    // Bad approval mode (simulating an untyped direct caller).
    await expect(
      service.update({ memoryApproval: { mode: 'sometimes' as 'off' } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    // Webhook timeout out of range (max 600).
    await expect(
      service.update({
        webhooks: { h: { personalityId: 'r', prefilter: 'f.sh', prefilterTimeoutSeconds: 601 } },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    // Webhook timeout without a prefilter.
    await expect(
      service.update({ webhooks: { h: { personalityId: 'r', prefilterTimeoutSeconds: 30 } } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    // Compaction pressure outside (0,1].
    await expect(service.update({ compaction: { pressure: 1.5 } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    // Resume recap turns above 10.
    await expect(service.update({ displayResumeRecapTurns: 11 })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    // Bad retention duration grammar.
    await expect(service.update({ retention: { messages: 'yearly' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    // Record key that can't survive the line-based config format.
    await expect(
      service.update({ webhooks: { 'bad id': { personalityId: 'r' } } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    // Nothing was persisted by the rejected updates.
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('memoryApproval');
    expect(written).not.toContain('webhooks.');
  });

  // -- Voice-notes-everywhere operator keys (voice V2 settings parity) --------

  it('get returns the voice channel/transcode/artifact keys as unset', async () => {
    await writeBase();
    const r = await service.get();
    expect(r.voiceChannelTtsOut).toEqual({});
    expect(r.voiceTranscodeFfmpegPath).toBeNull();
    expect(r.voiceTranscodeBitrateKbps).toBeNull();
    expect(r.voiceTranscodeTimeoutSec).toBeNull();
    expect(r.voiceArtifactAbandonAfterDays).toBeNull();
    expect(r.voiceArtifactMaxTotalMb).toBeNull();
  });

  it('get parses the voice channel/transcode/artifact keys from config.yaml', async () => {
    await writeBase([
      'voice.channels.telegram.ttsOut: true',
      'voice.channels.slack.ttsOut: false',
      // Neither an adapter nor the CLI parser knows this platform; the read
      // path drops it exactly as packages/config does on load.
      'voice.channels.carrier-pigeon.ttsOut: true',
      'voice.transcode.ffmpegPath: /opt/homebrew/bin/ffmpeg',
      'voice.transcode.bitrateKbps: 48',
      'voice.transcode.timeout: 45',
      'voice.artifacts.abandonAfterDays: 14',
      'voice.artifacts.maxTotalMb: 1024',
    ]);
    const r = await service.get();
    expect(r.voiceChannelTtsOut).toEqual({ telegram: true, slack: false });
    expect(r.voiceTranscodeFfmpegPath).toBe('/opt/homebrew/bin/ffmpeg');
    expect(r.voiceTranscodeBitrateKbps).toBe(48);
    expect(r.voiceTranscodeTimeoutSec).toBe(45);
    expect(r.voiceArtifactAbandonAfterDays).toBe(14);
    expect(r.voiceArtifactMaxTotalMb).toBe(1024);
  });

  it('update writes each voice operator key to its yaml key and round-trips', async () => {
    await writeBase();
    await service.update({
      voiceChannelTtsOut: { telegram: true, whatsapp: false },
      voiceTranscodeFfmpegPath: '/usr/bin/ffmpeg',
      voiceTranscodeBitrateKbps: 64,
      voiceTranscodeTimeoutSec: 90,
      voiceArtifactAbandonAfterDays: 30,
      voiceArtifactMaxTotalMb: 2048,
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('voice.channels.telegram.ttsOut: true');
    expect(written).toContain('voice.channels.whatsapp.ttsOut: false');
    expect(written).toContain('voice.transcode.ffmpegPath: /usr/bin/ffmpeg');
    expect(written).toContain('voice.transcode.bitrateKbps: 64');
    // The RPC field says `Sec`; the yaml key is the bare `timeout`.
    expect(written).toContain('voice.transcode.timeout: 90');
    expect(written).toContain('voice.artifacts.abandonAfterDays: 30');
    expect(written).toContain('voice.artifacts.maxTotalMb: 2048');

    const r = await service.get();
    expect(r.voiceChannelTtsOut).toEqual({ telegram: true, whatsapp: false });
    expect(r.voiceTranscodeFfmpegPath).toBe('/usr/bin/ffmpeg');
    expect(r.voiceTranscodeBitrateKbps).toBe(64);
    expect(r.voiceTranscodeTimeoutSec).toBe(90);
    expect(r.voiceArtifactAbandonAfterDays).toBe(30);
    expect(r.voiceArtifactMaxTotalMb).toBe(2048);
  });

  it('voiceChannelTtsOut replaces the whole map — an omitted platform disappears', async () => {
    await writeBase();
    await service.update({ voiceChannelTtsOut: { telegram: true, slack: false, discord: true } });
    expect((await service.get()).voiceChannelTtsOut).toEqual({
      telegram: true,
      slack: false,
      discord: true,
    });

    await service.update({ voiceChannelTtsOut: { slack: true } });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('voice.channels.telegram');
    expect(written).not.toContain('voice.channels.discord');
    expect(written).toContain('voice.channels.slack.ttsOut: true');
    // An omitted platform is "no override", which is not the same as `false`.
    expect((await service.get()).voiceChannelTtsOut).toEqual({ slack: true });
  });

  it('null clears each voice operator scalar back to its built-in default', async () => {
    await writeBase([
      'voice.transcode.ffmpegPath: /usr/bin/ffmpeg',
      'voice.transcode.bitrateKbps: 64',
      'voice.transcode.timeout: 90',
      'voice.artifacts.abandonAfterDays: 30',
      'voice.artifacts.maxTotalMb: 2048',
    ]);
    await service.update({
      voiceTranscodeFfmpegPath: null,
      voiceTranscodeBitrateKbps: null,
      voiceTranscodeTimeoutSec: null,
      voiceArtifactAbandonAfterDays: null,
      voiceArtifactMaxTotalMb: null,
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('voice.transcode.');
    expect(written).not.toContain('voice.artifacts.');
    const r = await service.get();
    expect(r.voiceTranscodeFfmpegPath).toBeNull();
    expect(r.voiceTranscodeBitrateKbps).toBeNull();
    expect(r.voiceTranscodeTimeoutSec).toBeNull();
    expect(r.voiceArtifactAbandonAfterDays).toBeNull();
    expect(r.voiceArtifactMaxTotalMb).toBeNull();
  });

  it('rejects out-of-range voice operator values and unknown channel platforms', async () => {
    await writeBase();
    const cases: ConfigUpdateInput[] = [
      { voiceTranscodeBitrateKbps: 7 },
      { voiceTranscodeBitrateKbps: 321 },
      { voiceTranscodeTimeoutSec: 0 },
      { voiceTranscodeTimeoutSec: 601 },
      { voiceArtifactAbandonAfterDays: 0 },
      { voiceArtifactAbandonAfterDays: 366 },
      { voiceArtifactMaxTotalMb: 0 },
      { voiceArtifactMaxTotalMb: 102_401 },
      // A typo'd platform is REFUSED at the RPC boundary, not dropped the way
      // the yaml parser drops it on load.
      { voiceChannelTtsOut: { telegran: true } },
    ];
    for (const patch of cases) {
      await expect(service.update(patch)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('voice.transcode.');
    expect(written).not.toContain('voice.artifacts.');
    expect(written).not.toContain('voice.channels.');
  });
});
