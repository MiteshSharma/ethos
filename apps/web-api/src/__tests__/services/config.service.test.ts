import { join } from 'node:path';
import { loadConfigStrict } from '@ethosagent/config';
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

/** Every `browser.*` leaf at its default — the shape `get` reports when no
 *  `browser.*` key is on disk. Spread and override for the non-default cases;
 *  asserted with `toEqual` (not `toMatchObject`) so a field that silently
 *  stops being reported fails here. */
const BROWSER_DEFAULTS = {
  navigationTimeoutMs: 30_000,
  commandTimeoutMs: 10_000,
  headed: 'auto',
  idleTimeoutMs: 600_000,
  stealthEnabled: false,
  profilesEnabled: false,
  proxyServer: null,
  proxyUsername: null,
  proxyPasswordPreview: null,
} as const;

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

  /** `loadConfigStrict` resolves `~/.ethos` through ETHOS_STATE_DIR — point it
   *  at the in-memory dir the repository writes to. `withSecrets: false` skips
   *  the plaintext-secret gate, for the hand-edited files `writeBase` leaves a
   *  literal apiKey in. */
  const loadFromDataDir = async (withSecrets = true) => {
    const prev = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = DATA;
    try {
      return await loadConfigStrict(storage, withSecrets ? secrets : undefined);
    } finally {
      if (prev === undefined) delete process.env.ETHOS_STATE_DIR;
      else process.env.ETHOS_STATE_DIR = prev;
    }
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
      abortOnSummaryFailure: false,
      smallWindow: 'auto',
    });
    expect(r.voiceFiller).toEqual({
      enabled: true,
      afterMs: null,
      text: null,
      tickIntervalMs: null,
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
    // Raw, not resolved: the built-in cron/keep/scopes/dir come from
    // `resolveBackupSettings` in `@ethosagent/wiring` and are reported by
    // `backup.status`. `enabled` is the exception — a Switch has no third
    // state, and an absent key means ON.
    expect(r.backup).toEqual({ enabled: true, cron: null, scope: [], keep: null, dir: null });
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
      abortOnSummaryFailure: false,
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

  it('round-trips voice.filler.*', async () => {
    await writeBase();
    await service.update({
      voiceFiller: { enabled: false, afterMs: 800, text: 'One sec.', tickIntervalMs: 5000 },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('voice.filler.enabled: false');
    expect(written).toContain('voice.filler.afterMs: 800');
    expect(written).toContain('voice.filler.text: One sec.');
    expect(written).toContain('voice.filler.tickIntervalMs: 5000');

    const r = await service.get();
    expect(r.voiceFiller).toEqual({
      enabled: false,
      afterMs: 800,
      text: 'One sec.',
      tickIntervalMs: 5000,
    });
  });

  it('null clears voice.filler fields back to their defaults', async () => {
    await writeBase(['voice.filler.afterMs: 800', 'voice.filler.enabled: false']);
    await service.update({ voiceFiller: { afterMs: null, enabled: null } });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('voice.filler.afterMs');
    expect(written).not.toContain('voice.filler.enabled');
    const r = await service.get();
    expect(r.voiceFiller.afterMs).toBeNull();
    expect(r.voiceFiller.enabled).toBe(true);
  });

  it('refuses an out-of-range voice.filler.afterMs', async () => {
    await writeBase();
    await expect(service.update({ voiceFiller: { afterMs: 999_999 } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
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

  // -- config.yaml keys added for Hermes parity ------------------------------
  // Each has a runtime bounds check in packages/config's `build*` helpers; the
  // service mirrors them so a direct (non-RPC) caller can't persist a value the
  // CLI loader would silently drop.

  it('get returns the parity defaults when the new keys are absent', async () => {
    await writeBase();
    const r = await service.get();
    expect(r.compaction.abortOnSummaryFailure).toBe(false);
    expect(r.retentionVacuumAfterPrune).toBe(false);
    expect(r.retentionMinVacuumIntervalDays).toBeNull();
    expect(r.logsLevel).toBe('debug');
    expect(r.memoryCharLimits).toEqual({ memory: 524_288, user: 524_288 });
    expect(r.executionDocker).toEqual({ cpu: 2, diskMb: null });
    expect(r.kanban).toEqual({ maxInProgress: null, maxInProgressPerProfile: null });
    expect(r.cronMaxParallelJobs).toBeNull();
    expect(r.toolLoop).toEqual({ maxToolCallsWarnAt: null, maxIdenticalToolCallsWarnAt: null });
    expect(r.browser).toEqual(BROWSER_DEFAULTS);
    expect(r.gatewayMaxInboundMediaBytes).toBeNull();
    expect(r.teamSupervisorRestartLoopGuard).toEqual({ maxRestarts: 5, windowSeconds: 60 });
    expect(r.discordMissedMessageBackfill).toEqual({
      enabled: true,
      windowSeconds: null,
      limit: 50,
    });
  });

  // `retention.channelTranscript` (RETENTION_DEFAULTS.channelTranscript = 30d,
  // packages/types/src/retention.ts) prunes observe-mode transcripts — real
  // message text from watched rooms. It parsed and pruned long before either
  // setter surface listed it, so the only way to shorten the window was to hand
  // edit config.yaml, and this service REJECTED a patch that named it.
  //
  // The read half matters as much as the write half: `update`'s retention patch
  // replaces every subkey in RETENTION_SUBKEYS, so a subkey the service writes
  // but does not report back would be swept out of config.yaml by the next
  // unrelated save — silently restoring the 30d default over a shorter window an
  // operator had chosen. Both halves are asserted here.
  it('reads and writes retention.channelTranscript like any other subkey', async () => {
    await writeBase(['retention.channelTranscript: 7d']);
    expect((await service.get()).retention).toMatchObject({ channelTranscript: '7d' });

    await service.update({ retention: { channelTranscript: '14d', messages: '90d' } });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('retention.channelTranscript: 14d');
    expect((await service.get()).retention).toMatchObject({
      channelTranscript: '14d',
      messages: '90d',
    });
  });

  it('round-trips every parity leaf under its dotted config key', async () => {
    await writeBase();
    await service.update({
      compaction: { abortOnSummaryFailure: true },
      retentionVacuumAfterPrune: true,
      retentionMinVacuumIntervalDays: 7,
      logsLevel: 'warn',
      memoryCharLimits: { memory: 200_000, user: 100_000 },
      executionDocker: { cpu: 1.5, diskMb: 4096 },
      kanban: { maxInProgress: 3, maxInProgressPerProfile: 1 },
      cronMaxParallelJobs: 2,
      toolLoop: { maxToolCallsWarnAt: 20, maxIdenticalToolCallsWarnAt: 4 },
      browser: { navigationTimeoutMs: 45_000, commandTimeoutMs: 15_000 },
      gatewayMaxInboundMediaBytes: 8_388_608,
      teamSupervisorRestartLoopGuard: { maxRestarts: 3, windowSeconds: 120 },
      discordMissedMessageBackfill: { enabled: false, windowSeconds: 3600, limit: 25 },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('compaction.abortOnSummaryFailure: true');
    expect(written).toContain('retention.vacuumAfterPrune: true');
    expect(written).toContain('retention.minVacuumIntervalDays: 7');
    expect(written).toContain('logs.level: warn');
    expect(written).toContain('memory.charLimits.memory: 200000');
    expect(written).toContain('memory.charLimits.user: 100000');
    expect(written).toContain('execution.docker.cpu: 1.5');
    expect(written).toContain('execution.docker.diskMb: 4096');
    expect(written).toContain('kanban.maxInProgress: 3');
    expect(written).toContain('kanban.maxInProgressPerProfile: 1');
    expect(written).toContain('cron.maxParallelJobs: 2');
    expect(written).toContain('toolLoop.maxToolCallsWarnAt: 20');
    expect(written).toContain('toolLoop.maxIdenticalToolCallsWarnAt: 4');
    expect(written).toContain('browser.navigationTimeoutMs: 45000');
    expect(written).toContain('browser.commandTimeoutMs: 15000');
    expect(written).toContain('gateway.maxInboundMediaBytes: 8388608');
    expect(written).toContain('teamSupervisor.restartLoopGuard.maxRestarts: 3');
    expect(written).toContain('teamSupervisor.restartLoopGuard.windowSeconds: 120');
    expect(written).toContain('discord.missedMessageBackfill.enabled: false');
    expect(written).toContain('discord.missedMessageBackfill.windowSeconds: 3600');
    expect(written).toContain('discord.missedMessageBackfill.limit: 25');

    const r = await service.get();
    expect(r.compaction.abortOnSummaryFailure).toBe(true);
    expect(r.retentionVacuumAfterPrune).toBe(true);
    expect(r.retentionMinVacuumIntervalDays).toBe(7);
    expect(r.logsLevel).toBe('warn');
    expect(r.memoryCharLimits).toEqual({ memory: 200_000, user: 100_000 });
    expect(r.executionDocker).toEqual({ cpu: 1.5, diskMb: 4096 });
    expect(r.kanban).toEqual({ maxInProgress: 3, maxInProgressPerProfile: 1 });
    expect(r.cronMaxParallelJobs).toBe(2);
    expect(r.toolLoop).toEqual({ maxToolCallsWarnAt: 20, maxIdenticalToolCallsWarnAt: 4 });
    expect(r.browser).toEqual({
      ...BROWSER_DEFAULTS,
      navigationTimeoutMs: 45_000,
      commandTimeoutMs: 15_000,
    });
    expect(r.gatewayMaxInboundMediaBytes).toBe(8_388_608);
    expect(r.teamSupervisorRestartLoopGuard).toEqual({ maxRestarts: 3, windowSeconds: 120 });
    expect(r.discordMissedMessageBackfill).toEqual({
      enabled: false,
      windowSeconds: 3600,
      limit: 25,
    });
  });

  it('null clears every parity leaf back to its default', async () => {
    await writeBase([
      'compaction.abortOnSummaryFailure: true',
      'retention.vacuumAfterPrune: true',
      'retention.minVacuumIntervalDays: 7',
      'logs.level: warn',
      'memory.charLimits.memory: 200000',
      'memory.charLimits.user: 100000',
      'execution.docker.cpu: 1.5',
      'execution.docker.diskMb: 4096',
      'kanban.maxInProgress: 3',
      'kanban.maxInProgressPerProfile: 1',
      'cron.maxParallelJobs: 2',
      'toolLoop.maxToolCallsWarnAt: 20',
      'toolLoop.maxIdenticalToolCallsWarnAt: 4',
      'browser.navigationTimeoutMs: 45000',
      'browser.commandTimeoutMs: 15000',
      'gateway.maxInboundMediaBytes: 8388608',
      'teamSupervisor.restartLoopGuard.maxRestarts: 3',
      'teamSupervisor.restartLoopGuard.windowSeconds: 120',
      'discord.missedMessageBackfill.enabled: false',
      'discord.missedMessageBackfill.windowSeconds: 3600',
      'discord.missedMessageBackfill.limit: 25',
    ]);
    await service.update({
      compaction: { abortOnSummaryFailure: null },
      retentionVacuumAfterPrune: null,
      retentionMinVacuumIntervalDays: null,
      logsLevel: null,
      memoryCharLimits: { memory: null, user: null },
      executionDocker: { cpu: null, diskMb: null },
      kanban: { maxInProgress: null, maxInProgressPerProfile: null },
      cronMaxParallelJobs: null,
      toolLoop: { maxToolCallsWarnAt: null, maxIdenticalToolCallsWarnAt: null },
      browser: { navigationTimeoutMs: null, commandTimeoutMs: null },
      gatewayMaxInboundMediaBytes: null,
      teamSupervisorRestartLoopGuard: { maxRestarts: null, windowSeconds: null },
      discordMissedMessageBackfill: { enabled: null, windowSeconds: null, limit: null },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    for (const key of [
      'compaction.abortOnSummaryFailure',
      'retention.vacuumAfterPrune',
      'retention.minVacuumIntervalDays',
      'logs.level',
      'memory.charLimits.memory',
      'memory.charLimits.user',
      'execution.docker.cpu',
      'execution.docker.diskMb',
      'kanban.maxInProgress',
      'cron.maxParallelJobs',
      'toolLoop.maxToolCallsWarnAt',
      'browser.navigationTimeoutMs',
      'gateway.maxInboundMediaBytes',
      'teamSupervisor.restartLoopGuard.maxRestarts',
      'discord.missedMessageBackfill.enabled',
    ]) {
      expect(written).not.toContain(key);
    }

    const r = await service.get();
    expect(r.compaction.abortOnSummaryFailure).toBe(false);
    expect(r.retentionVacuumAfterPrune).toBe(false);
    expect(r.retentionMinVacuumIntervalDays).toBeNull();
    expect(r.logsLevel).toBe('debug');
    expect(r.memoryCharLimits).toEqual({ memory: 524_288, user: 524_288 });
    expect(r.executionDocker).toEqual({ cpu: 2, diskMb: null });
    expect(r.kanban).toEqual({ maxInProgress: null, maxInProgressPerProfile: null });
    expect(r.cronMaxParallelJobs).toBeNull();
    expect(r.toolLoop).toEqual({ maxToolCallsWarnAt: null, maxIdenticalToolCallsWarnAt: null });
    expect(r.browser).toEqual(BROWSER_DEFAULTS);
    expect(r.gatewayMaxInboundMediaBytes).toBeNull();
    expect(r.teamSupervisorRestartLoopGuard).toEqual({ maxRestarts: 5, windowSeconds: 60 });
    expect(r.discordMissedMessageBackfill).toEqual({
      enabled: true,
      windowSeconds: null,
      limit: 50,
    });
  });

  it.each([
    ['retentionMinVacuumIntervalDays', { retentionMinVacuumIntervalDays: -1 }],
    ['logsLevel', { logsLevel: 'loud' as never }],
    ['cronMaxParallelJobs', { cronMaxParallelJobs: 0 }],
    ['gatewayMaxInboundMediaBytes below 1 KiB', { gatewayMaxInboundMediaBytes: 1023 }],
    ['gatewayMaxInboundMediaBytes above 128 MiB', { gatewayMaxInboundMediaBytes: 134_217_729 }],
    ['memoryCharLimits.memory', { memoryCharLimits: { memory: 0 } }],
    ['memoryCharLimits.user', { memoryCharLimits: { user: -1 } }],
    ['executionDocker.cpu', { executionDocker: { cpu: 0 } }],
    ['executionDocker.diskMb', { executionDocker: { diskMb: 0 } }],
    ['kanban.maxInProgress', { kanban: { maxInProgress: 0 } }],
    ['kanban.maxInProgressPerProfile', { kanban: { maxInProgressPerProfile: -2 } }],
    ['toolLoop.maxToolCallsWarnAt', { toolLoop: { maxToolCallsWarnAt: 0 } }],
    ['toolLoop.maxIdenticalToolCallsWarnAt', { toolLoop: { maxIdenticalToolCallsWarnAt: 0 } }],
    ['browser.navigationTimeoutMs below 1s', { browser: { navigationTimeoutMs: 999 } }],
    ['browser.commandTimeoutMs above 10min', { browser: { commandTimeoutMs: 600_001 } }],
    [
      'teamSupervisorRestartLoopGuard.maxRestarts',
      { teamSupervisorRestartLoopGuard: { maxRestarts: 0 } },
    ],
    [
      'teamSupervisorRestartLoopGuard.windowSeconds',
      { teamSupervisorRestartLoopGuard: { windowSeconds: 86_401 } },
    ],
    [
      'discordMissedMessageBackfill.windowSeconds',
      { discordMissedMessageBackfill: { windowSeconds: 604_801 } },
    ],
    ['discordMissedMessageBackfill.limit', { discordMissedMessageBackfill: { limit: 101 } }],
  ] satisfies Array<[string, ConfigUpdateInput]>)(
    'refuses an out-of-range %s',
    async (_label, patch) => {
      await writeBase();
      await expect(service.update(patch)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      // Nothing was persisted — the guard runs before the write.
      const written = await storage.read(join(DATA, 'config.yaml'));
      expect(written).not.toContain('retention.minVacuumIntervalDays');
      expect(written).not.toContain('kanban.');
    },
  );

  it('get reports an out-of-range on-disk value the way the runtime treats it', async () => {
    // A hand-edited or older config.yaml. `@ethosagent/config`'s `build*`
    // helpers drop every one of these on load and the runtime runs on the
    // default, so the read path must not surface them as live.
    await writeBase([
      'retention.minVacuumIntervalDays: -1',
      'logs.level: loud',
      'memory.charLimits.memory: 0',
      'memory.charLimits.user: -1',
      'execution.docker.cpu: 0',
      'execution.docker.diskMb: 0',
      'kanban.maxInProgress: 0',
      'kanban.maxInProgressPerProfile: -2',
      'cron.maxParallelJobs: 0',
      'toolLoop.maxToolCallsWarnAt: 0',
      'toolLoop.maxIdenticalToolCallsWarnAt: nonsense',
      'browser.navigationTimeoutMs: 999',
      'browser.commandTimeoutMs: 600001',
      'gateway.maxInboundMediaBytes: 1023',
      'teamSupervisor.restartLoopGuard.maxRestarts: 0',
      'teamSupervisor.restartLoopGuard.windowSeconds: 86401',
      'discord.missedMessageBackfill.windowSeconds: 604801',
      'discord.missedMessageBackfill.limit: 101',
    ]);

    const r = await service.get();
    expect(r.retentionMinVacuumIntervalDays).toBeNull();
    expect(r.logsLevel).toBe('debug');
    expect(r.memoryCharLimits).toEqual({ memory: 524_288, user: 524_288 });
    expect(r.executionDocker).toEqual({ cpu: 2, diskMb: null });
    expect(r.kanban).toEqual({ maxInProgress: null, maxInProgressPerProfile: null });
    expect(r.cronMaxParallelJobs).toBeNull();
    expect(r.toolLoop).toEqual({ maxToolCallsWarnAt: null, maxIdenticalToolCallsWarnAt: null });
    expect(r.browser).toEqual(BROWSER_DEFAULTS);
    expect(r.gatewayMaxInboundMediaBytes).toBeNull();
    expect(r.teamSupervisorRestartLoopGuard).toEqual({ maxRestarts: 5, windowSeconds: 60 });
    expect(r.discordMissedMessageBackfill).toEqual({
      enabled: true,
      windowSeconds: null,
      limit: 50,
    });
  });

  it('get keeps an on-disk value that sits exactly on a bound', async () => {
    await writeBase([
      'retention.minVacuumIntervalDays: 0',
      'browser.navigationTimeoutMs: 1000',
      'browser.commandTimeoutMs: 600000',
      'gateway.maxInboundMediaBytes: 1024',
      'discord.missedMessageBackfill.limit: 100',
    ]);

    const r = await service.get();
    expect(r.retentionMinVacuumIntervalDays).toBe(0);
    expect(r.browser).toEqual({
      ...BROWSER_DEFAULTS,
      navigationTimeoutMs: 1_000,
      commandTimeoutMs: 600_000,
    });
    expect(r.gatewayMaxInboundMediaBytes).toBe(1024);
    expect(r.discordMissedMessageBackfill.limit).toBe(100);
  });

  it('editing retention TTLs leaves the vacuum scalars alone', async () => {
    await writeBase([
      'retention.messages: 30d',
      'retention.vacuumAfterPrune: true',
      'retention.minVacuumIntervalDays: 7',
    ]);
    // The retention MAP is a full replacement of its duration subkeys — but the
    // two vacuum scalars only share the prefix and must survive.
    await service.update({ retention: { messages: '90d' } });

    const r = await service.get();
    expect(r.retention).toEqual({ messages: '90d' });
    expect(r.retentionVacuumAfterPrune).toBe(true);
    expect(r.retentionMinVacuumIntervalDays).toBe(7);
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

  // --- webhook fields the update contract does not model -------------------
  // `events`/`deliver`/`hmac`/`rateLimit` are config-file-only by design (no
  // GUI). The update path wipes the whole `webhooks.` prefix and rebuilds from
  // the patch, so without an explicit carry a save from the Triggers form
  // deletes them all — silently.
  const HMAC_REF = 'webhooks/alerts/hmac/secret';
  const FILE_ONLY_HOOK_KEYS = [
    'webhooks.alerts.events: push, pull_request',
    'webhooks.alerts.eventHeader: x-github-event',
    'webhooks.alerts.eventField: action',
    'webhooks.alerts.deliver.0.type: platform',
    'webhooks.alerts.deliver.0.adapterId: "telegram:tg-a"',
    'webhooks.alerts.deliver.0.chatId: "-100123"',
    'webhooks.alerts.deliver.0.threadId: "7"',
    'webhooks.alerts.hmac.secret: hmac-material-1',
    'webhooks.alerts.hmac.header: x-hub-signature-256',
    'webhooks.alerts.hmac.algorithm: sha256',
    'webhooks.alerts.rateLimit.maxPerMinute: 60',
    'webhooks.alerts.rateLimit.lockoutSeconds: 300',
  ];

  it('webhooks: a save carries through the keys the update contract does not model', async () => {
    await writeBase([
      'webhooks.alerts.personalityId: researcher',
      'webhooks.alerts.secret: hook-bearer-1',
      'webhooks.alerts.mode: sync',
      ...FILE_ONLY_HOOK_KEYS,
    ]);

    // What the Triggers form sends: the six modelled fields, nothing else.
    await service.update({ webhooks: { alerts: { personalityId: 'researcher', mode: 'ack' } } });

    const written = (await storage.read(join(DATA, 'config.yaml'))) ?? '';
    expect(written).toContain('webhooks.alerts.events: push, pull_request');
    expect(written).toContain('webhooks.alerts.eventHeader: x-github-event');
    expect(written).toContain('webhooks.alerts.eventField: action');
    expect(written).toContain('webhooks.alerts.deliver.0.type: platform');
    expect(written).toContain('webhooks.alerts.deliver.0.adapterId: "telegram:tg-a"');
    expect(written).toContain('webhooks.alerts.deliver.0.chatId: -100123');
    expect(written).toContain('webhooks.alerts.deliver.0.threadId: 7');
    expect(written).toContain('webhooks.alerts.hmac.header: x-hub-signature-256');
    expect(written).toContain('webhooks.alerts.hmac.algorithm: sha256');
    expect(written).toContain('webhooks.alerts.rateLimit.maxPerMinute: 60');
    expect(written).toContain('webhooks.alerts.rateLimit.lockoutSeconds: 300');
    // Preservation is not freezing: the modelled change the save was actually
    // making still lands.
    expect(written).toContain('webhooks.alerts.mode: ack');
    // The carried hmac secret goes to the vault like every other credential
    // leaf — carrying it must not reintroduce a plaintext write.
    expect(written).toContain(`webhooks.alerts.hmac.secret: "${secretRef(HMAC_REF)}"`);
    expect(written).not.toContain('hmac-material-1');
    expect(await secrets.get(HMAC_REF)).toBe('hmac-material-1');
  });

  it('webhooks: a hook dropped from the patch loses its unmodelled keys too', async () => {
    await writeBase([
      'webhooks.alerts.personalityId: researcher',
      'webhooks.alerts.secret: hook-bearer-1',
      ...FILE_ONLY_HOOK_KEYS,
      'webhooks.builds.personalityId: researcher',
      'webhooks.builds.secret: hook-bearer-2',
    ]);

    // Removing a hook is a real deletion — the carry must not resurrect it.
    await service.update({ webhooks: { builds: { personalityId: 'researcher' } } });

    const written = (await storage.read(join(DATA, 'config.yaml'))) ?? '';
    expect(written).not.toContain('webhooks.alerts.');
    expect(written).toContain('webhooks.builds.personalityId: researcher');
  });

  it('webhooks: unmodelled keys do not leak onto a hook with a longer, similar id', async () => {
    await writeBase([
      'webhooks.a.personalityId: researcher',
      'webhooks.a.secret: hook-bearer-a',
      'webhooks.a.events: push',
      'webhooks.a.rateLimit.maxPerMinute: 30',
      'webhooks.ab.personalityId: researcher',
      'webhooks.ab.secret: hook-bearer-ab',
    ]);

    await service.update({
      webhooks: {
        a: { personalityId: 'researcher' },
        ab: { personalityId: 'researcher' },
      },
    });

    const written = (await storage.read(join(DATA, 'config.yaml'))) ?? '';
    expect(written).toContain('webhooks.a.events: push');
    expect(written).toContain('webhooks.a.rateLimit.maxPerMinute: 30');
    expect(written).not.toContain('webhooks.ab.events');
    expect(written).not.toContain('webhooks.ab.rateLimit');
  });

  it('webhooks: the saved config still loads, with every preserved field intact', async () => {
    await writeBase([
      'webhooks.alerts.personalityId: researcher',
      'webhooks.alerts.secret: hook-bearer-1',
      'webhooks.alerts.mode: sync',
      ...FILE_ONLY_HOOK_KEYS,
    ]);

    await service.update({ webhooks: { alerts: { personalityId: 'researcher', mode: 'ack' } } });

    // The assertion that matters: not "the strings survived" but "the CLI
    // loader still builds the same WebhookHookConfig from them".
    const prev = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = DATA;
    try {
      const loaded = await loadConfigStrict(storage, secrets);
      expect(loaded?.parseErrors).toEqual([]);
      expect(loaded?.config.webhooks?.alerts).toEqual({
        personalityId: 'researcher',
        secret: 'hook-bearer-1',
        mode: 'ack',
        events: ['push', 'pull_request'],
        eventHeader: 'x-github-event',
        eventField: 'action',
        deliver: [
          { type: 'platform', adapterId: 'telegram:tg-a', chatId: '-100123', threadId: '7' },
        ],
        hmac: {
          secret: 'hmac-material-1',
          header: 'x-hub-signature-256',
          algorithm: 'sha256',
        },
        rateLimit: { maxPerMinute: 60, lockoutSeconds: 300 },
      });
    } finally {
      if (prev === undefined) delete process.env.ETHOS_STATE_DIR;
      else process.env.ETHOS_STATE_DIR = prev;
    }
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

  it('round-trips every backup.* field through config.yaml and back', async () => {
    await writeBase();
    await service.update({
      backup: {
        enabled: false,
        cron: '30 2 * * *',
        scope: ['identity'],
        keep: 3,
        dir: '/mnt/snapshots',
      },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('backup.enabled: false');
    expect(written).toContain('backup.cron: "30 2 * * *"');
    expect(written).toContain('backup.scope: identity');
    expect(written).toContain('backup.keep: 3');
    expect(written).toContain('backup.dir: /mnt/snapshots');

    expect((await service.get()).backup).toEqual({
      enabled: false,
      cron: '30 2 * * *',
      scope: ['identity'],
      keep: 3,
      dir: '/mnt/snapshots',
    });

    // The assertion that matters: the CLI loader builds the same `backup`
    // block from what the web wrote. `@ethosagent/config` is the shape's one
    // source of truth; this layer only transports it.
    const prev = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = DATA;
    try {
      const loaded = await loadConfigStrict(storage, secrets);
      expect(loaded?.parseErrors).toEqual([]);
      expect(loaded?.config.backup).toEqual({
        enabled: false,
        cron: '30 2 * * *',
        scope: ['identity'],
        keep: 3,
        dir: '/mnt/snapshots',
      });
    } finally {
      if (prev === undefined) delete process.env.ETHOS_STATE_DIR;
      else process.env.ETHOS_STATE_DIR = prev;
    }
  });

  it('clears a backup.* key rather than pinning a computed default', async () => {
    await writeBase();
    await service.update({ backup: { cron: '30 2 * * *', dir: '/mnt/snapshots', keep: 3 } });
    await service.update({ backup: { cron: null, dir: null, keep: null, scope: [] } });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('backup.cron');
    expect(written).not.toContain('backup.dir');
    expect(written).not.toContain('backup.keep');
    const r = await service.get();
    expect(r.backup).toEqual({ enabled: true, cron: null, scope: [], keep: null, dir: null });
  });

  it('refuses an out-of-range backup.keep before it can be persisted', async () => {
    await writeBase();
    // The bound mirrors `buildBackupConfig` in packages/config, which THROWS
    // rather than dropping: a `backup.keep: 0` that reaches config.yaml makes
    // it unloadable everywhere, so the refusal has to land before the write.
    // A direct `config.update` caller has no `InputNumber min={1}` in front of
    // it. Same error shape as the neighbouring numeric bounds.
    await expect(service.update({ backup: { keep: 0 } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      cause: 'backup.keep must be an integer >= 1',
    });
    await expect(service.update({ backup: { keep: -1 } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(service.update({ backup: { keep: 1.5 } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    // Past the safe-integer range, which `Number.isSafeInteger` also rejects.
    await expect(
      service.update({ backup: { keep: Number.MAX_SAFE_INTEGER + 2 } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    // Nothing was persisted by the rejected updates, and a valid value passes.
    expect(await storage.read(join(DATA, 'config.yaml'))).not.toContain('backup.keep');
    await service.update({ backup: { keep: 1 } });
    expect(await storage.read(join(DATA, 'config.yaml'))).toContain('backup.keep: 1');
  });

  it('leaves packages/config owning the rule for a hand-edited backup.keep', async () => {
    // The web-layer bound is a mirror, not a replacement. A `backup.keep: 0`
    // that never went through this layer is still refused by the loader, and
    // that is the error the operator sees — this is the failure the mirror
    // exists to keep the web layer from causing.
    await writeBase(['backup.keep: 0']);
    const prev = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = DATA;
    try {
      await expect(loadConfigStrict(storage, secrets)).rejects.toThrow(
        'Invalid backup.keep "0". Expected a positive integer.',
      );
    } finally {
      if (prev === undefined) delete process.env.ETHOS_STATE_DIR;
      else process.env.ETHOS_STATE_DIR = prev;
    }
  });

  it('carries an unknown backup.scope name through — parseScopes judges it at run time', async () => {
    await writeBase();
    await service.update({ backup: { scope: ['identity', 'nonsense'] } });
    expect(await storage.read(join(DATA, 'config.yaml'))).toContain(
      'backup.scope: identity,nonsense',
    );

    // `packages/config` deliberately does NOT validate the roster (it cannot
    // import `@ethosagent/wiring`), so the config still loads and the name is
    // refused where the backup runs.
    const prev = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = DATA;
    try {
      const loaded = await loadConfigStrict(storage, secrets);
      expect(loaded?.config.backup?.scope).toEqual(['identity', 'nonsense']);
    } finally {
      if (prev === undefined) delete process.env.ETHOS_STATE_DIR;
      else process.env.ETHOS_STATE_DIR = prev;
    }
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

  // -- browser launch posture + web.searxng.url ------------------------------
  // `@ethosagent/config`'s `buildBrowser` splits these two ways: the `*Ms`
  // budgets are DROPPED when out of range, while `headed`, the two flags and
  // the whole proxy block are FATAL at boot. A proxy the operator believed was
  // carrying their traffic silently going direct is the fail-open case that
  // asymmetry exists to catch — so every value refused there is refused here
  // too, rather than written and discovered on the next restart.

  it('round-trips every browser leaf and web.searxng.url under its dotted key', async () => {
    await writeBase();
    await service.update({
      browser: {
        navigationTimeoutMs: 45_000,
        commandTimeoutMs: 15_000,
        headed: false,
        idleTimeoutMs: 900_000,
        stealthEnabled: true,
        profilesEnabled: false,
        proxyServer: 'socks5://127.0.0.1:1080',
        proxyUsername: 'ethos',
        proxyPassword: 'proxy-secret-value',
      },
      webSearxngUrl: 'https://searx.example.com',
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain('browser.navigationTimeoutMs: 45000');
    expect(written).toContain('browser.commandTimeoutMs: 15000');
    expect(written).toContain('browser.headed: false');
    expect(written).toContain('browser.idleTimeoutMs: 900000');
    expect(written).toContain('browser.stealth.enabled: true');
    expect(written).toContain('browser.profiles.enabled: false');
    expect(written).toContain('browser.proxy.server: "socks5://127.0.0.1:1080"');
    expect(written).toContain('browser.proxy.username: ethos');
    expect(written).toContain('web.searxng.url: "https://searx.example.com"');

    // Every leaf asserted by value, not by a whole-object compare: a compare
    // passes when the same field is missing from both sides.
    const r = await service.get();
    expect(r.browser.navigationTimeoutMs).toBe(45_000);
    expect(r.browser.commandTimeoutMs).toBe(15_000);
    expect(r.browser.headed).toBe(false);
    expect(r.browser.idleTimeoutMs).toBe(900_000);
    expect(r.browser.stealthEnabled).toBe(true);
    expect(r.browser.profilesEnabled).toBe(false);
    expect(r.browser.proxyServer).toBe('socks5://127.0.0.1:1080');
    expect(r.browser.proxyUsername).toBe('ethos');
    expect(r.browser.proxyPasswordPreview).toBe(redactKey('proxy-secret-value'));
    expect(r.webSearxngUrl).toBe('https://searx.example.com');

    // The block the CLI actually boots on. `buildBrowser` returns NO `browser`
    // at all when it found a fatal error, so this is the real acceptance test.
    const loaded = await loadFromDataDir();
    expect(loaded?.parseErrors).toEqual([]);
    expect(loaded?.config.browser).toEqual({
      navigationTimeoutMs: 45_000,
      commandTimeoutMs: 15_000,
      headed: false,
      idleTimeoutMs: 900_000,
      stealth: { enabled: true },
      profiles: { enabled: false },
      proxy: {
        server: 'socks5://127.0.0.1:1080',
        username: 'ethos',
        password: 'proxy-secret-value',
      },
    });
    expect(loaded?.config.web?.searxng?.url).toBe('https://searx.example.com');
  });

  it('null clears each browser leaf and web.searxng.url back to its default', async () => {
    await writeBase([
      'browser.headed: true',
      'browser.idleTimeoutMs: 900000',
      'browser.stealth.enabled: true',
      'browser.profiles.enabled: false',
      'web.searxng.url: https://searx.example.com',
    ]);
    await service.update({
      browser: {
        headed: null,
        idleTimeoutMs: null,
        stealthEnabled: null,
        profilesEnabled: null,
      },
      webSearxngUrl: null,
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    for (const key of [
      'browser.headed',
      'browser.idleTimeoutMs',
      'browser.stealth.enabled',
      'browser.profiles.enabled',
      'web.searxng.url',
    ]) {
      expect(written).not.toContain(key);
    }
    const r = await service.get();
    expect(r.browser).toEqual(BROWSER_DEFAULTS);
    expect(r.webSearxngUrl).toBeNull();
  });

  it('strips browser and webSearxngUrl from the repository patch (PATCH_KEYS gate)', async () => {
    // SETTINGS_PATCH_KEYS is what keeps a passthrough-written field out of the
    // repository's typed RawConfig patch. A field missing from it is spread
    // onto RawConfig, where the serializer silently drops it — so this asserts
    // the allowlist directly rather than through an on-disk side effect it has
    // none of.
    await writeBase();
    const update = vi.spyOn(repo, 'update');
    await service.update({
      webSearxngUrl: 'http://searx.local',
      browser: { headed: true, stealthEnabled: true },
    });
    const patch = update.mock.calls[0]?.[0];
    expect(patch).toBeDefined();
    expect(patch && 'webSearxngUrl' in patch).toBe(false);
    expect(patch && 'browser' in patch).toBe(false);
    // …and they reached the repository as flat passthrough keys instead.
    expect(patch?.passthrough).toMatchObject({
      'web.searxng.url': 'http://searx.local',
      'browser.headed': 'true',
      'browser.stealth.enabled': 'true',
    });
  });

  it.each([
    ['true', true],
    ['false', false],
    ['auto', 'auto'],
  ] satisfies Array<[string, boolean | 'auto']>)(
    'browser.headed accepts %s and carries it verbatim',
    async (onDisk, value) => {
      await writeBase();
      await service.update({ browser: { headed: value } });
      expect(await storage.read(join(DATA, 'config.yaml'))).toContain(`browser.headed: ${onDisk}`);
      expect((await service.get()).browser.headed).toBe(value);
      // `auto` is NOT resolved on the way through — the session factory owns
      // that, and a resolved value would rewrite the operator's file.
      const loaded = await loadFromDataDir();
      expect(loaded?.parseErrors).toEqual([]);
      expect(loaded?.config.browser?.headed).toBe(value);
    },
  );

  it.each(['yes', 'flase', 'AUTO', '', 1])('browser.headed refuses %p', async (bad) => {
    await writeBase();
    await expect(service.update({ browser: { headed: bad as never } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await storage.read(join(DATA, 'config.yaml'))).not.toContain('browser.headed');
  });

  it.each([
    ['browser.stealth.enabled', 'stealthEnabled'],
    ['browser.profiles.enabled', 'profilesEnabled'],
  ] satisfies Array<[string, 'stealthEnabled' | 'profilesEnabled']>)(
    '%s refuses a non-boolean',
    async (configKey, field) => {
      await writeBase();
      await expect(service.update({ browser: { [field]: 'yes' as never } })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
      expect(await storage.read(join(DATA, 'config.yaml'))).not.toContain(configKey);
    },
  );

  it('reads stealth as OFF when the key is absent', async () => {
    await writeBase(['browser.profiles.enabled: true']);
    expect((await service.get()).browser.stealthEnabled).toBe(false);
  });

  it('reads profiles as OFF when the key is absent', async () => {
    await writeBase(['browser.stealth.enabled: true']);
    expect((await service.get()).browser.profilesEnabled).toBe(false);
  });

  it.each([true, false])('reads profiles back verbatim when the key says %p', async (value) => {
    await writeBase([`browser.profiles.enabled: ${value}`]);
    expect((await service.get()).browser.profilesEnabled).toBe(value);
  });

  // DIVERGENCE GUARD. Three sites have to agree that an absent
  // `browser.profiles.enabled` means OFF, and only two of them can be reached
  // from here:
  //
  //   1. `buildBrowser` in `@ethosagent/config` — emits NO `browser.profiles`
  //      block at all when the key is absent. Asserted below against the real
  //      loader, not against a copy of its behaviour.
  //   2. This service's read path — asserted below on the same on-disk state.
  //   3. `buildLaunchOptions` in `extensions/tools-browser/src/launch-options.ts`
  //      — gates a persistent profile on `cfg.profilesEnabled === true`, so the
  //      `undefined` that (1) hands it through `composeBrowser` is OFF.
  //
  // (3) is pinned by comment rather than by import: `@ethosagent/tools-browser`
  // is not a dependency of web-api, and adding one so a settings test can read
  // a boolean would couple this layer to the browser extension. The same
  // approach the `browser.idleTimeoutMs` bounds guard above takes. If that
  // `=== true` ever becomes a `!== false`, change this test with it.
  it.each([
    // No `browser.*` key at all — `buildBrowser` never runs.
    ['no browser block', []],
    // A `browser.*` block that simply omits this one key — `buildBrowser` DOES
    // run, and must still leave `profiles` unset. The case above cannot catch a
    // default introduced inside `buildBrowser`; this one can.
    ['a browser block without the key', ['browser.headed: auto']],
  ] satisfies Array<[string, string[]]>)(
    'absent browser.profiles.enabled is OFF in the loader and in the read path alike (%s)',
    async (_label, extra) => {
      await writeBase(extra);

      // `withSecrets: false` — `writeBase` leaves a literal apiKey on disk,
      // which the plaintext-secret gate rejects. Nothing here reads a secret.
      const loaded = await loadFromDataDir(false);
      expect(loaded?.parseErrors).toEqual([]);
      // No block at all — not `{ enabled: true }`, and not `{ enabled: false }`.
      expect(loaded?.config.browser?.profiles).toBeUndefined();

      expect((await service.get()).browser.profilesEnabled).toBe(false);
    },
  );

  // The two halves of each case are what make this a DIVERGENCE guard: the
  // bound is asserted against `@ethosagent/config`'s own behaviour rather than
  // against a second copy of the numbers. `buildBrowser`'s literals are
  // module-private, so if they ever move, the `loadConfigStrict` half of one of
  // these fails while `checkInt` keeps its old answer.
  it.each([
    ['the lower bound', 60_000],
    ['the upper bound', 86_400_000],
  ])('browser.idleTimeoutMs on %s is accepted here and kept by the loader', async (_l, value) => {
    await writeBase();
    await service.update({ browser: { idleTimeoutMs: value } });
    const loaded = await loadFromDataDir();
    expect(loaded?.config.browser?.idleTimeoutMs).toBe(value);
  });

  it.each([
    ['below the lower bound', 59_999],
    ['above the upper bound', 86_400_001],
  ])('browser.idleTimeoutMs %s is refused here and dropped by the loader', async (_l, value) => {
    await writeBase();
    await expect(service.update({ browser: { idleTimeoutMs: value } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await storage.read(join(DATA, 'config.yaml'))).not.toContain('browser.idleTimeoutMs');

    // Same value hand-edited into config.yaml: the loader drops it and the
    // runtime falls back to 600000, which is why this layer must refuse it.
    await writeBase([`browser.idleTimeoutMs: ${value}`]);
    const loaded = await loadFromDataDir(false);
    expect(loaded?.config.browser?.idleTimeoutMs).toBeUndefined();
  });

  it('never returns the resolved proxy password on the read path', async () => {
    await writeBase();
    await service.update({
      browser: {
        proxyServer: 'http://proxy.example.com:3128',
        proxyUsername: 'ethos',
        proxyPassword: 'p-r-o-x-y-s3cret',
      },
    });

    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).toContain(secretRef('browser/proxy/password'));
    expect(written).not.toContain('p-r-o-x-y-s3cret');
    expect(await secrets.get('browser/proxy/password')).toBe('p-r-o-x-y-s3cret');

    const r = await service.get();
    expect(r.browser.proxyServer).toBe('http://proxy.example.com:3128');
    expect(r.browser.proxyUsername).toBe('ethos');
    // Resolved THEN redacted — redacting the `${secrets:…}` reference would
    // render nonsense and tell the operator nothing about which key is set.
    expect(r.browser.proxyPasswordPreview).toBe(redactKey('p-r-o-x-y-s3cret'));
    // Belt and braces: the raw credential is nowhere in the read response,
    // under this field name or any other.
    expect(JSON.stringify(r)).not.toContain('p-r-o-x-y-s3cret');
  });

  it('a blank proxy password keeps the stored one; null clears the whole block', async () => {
    await writeBase();
    await service.update({
      browser: { proxyServer: 'http://proxy.example.com:3128', proxyPassword: 'keep-me-please' },
    });
    // Blank = "the form only ever saw a preview", not "erase it".
    await service.update({ browser: { proxyUsername: 'ethos', proxyPassword: '' } });
    expect(await secrets.get('browser/proxy/password')).toBe('keep-me-please');
    expect((await service.get()).browser.proxyPasswordPreview).toBe(redactKey('keep-me-please'));

    // Clearing the anchor takes the username and the vault-backed password with
    // it — credentials with no server refuse boot.
    await service.update({ browser: { proxyServer: null } });
    const r = await service.get();
    expect(r.browser.proxyServer).toBeNull();
    expect(r.browser.proxyUsername).toBeNull();
    expect(r.browser.proxyPasswordPreview).toBeNull();
    expect(await secrets.get('browser/proxy/password')).toBeNull();
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('browser.proxy.');
  });

  it.each(['myproxy:3128', 'proxy.example.com:3128', 'ftp://proxy.example.com', 'not a url'])(
    'browser.proxy.server refuses %p (no usable scheme)',
    async (bad) => {
      await writeBase();
      await expect(service.update({ browser: { proxyServer: bad } })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
      expect(await storage.read(join(DATA, 'config.yaml'))).not.toContain('browser.proxy.');
    },
  );

  // The URL form — `http://user:pass@proxy.example:3128` — is how most proxy
  // documentation writes an authenticated proxy, and accepting it put the
  // password in config.yaml in plaintext, handed it back unredacted through
  // `proxyServer` on the read path, and routed around the `browser/proxy/
  // password` secret store entirely.
  //
  // Both halves of each case are what make this a DIVERGENCE guard, the same
  // shape the `idleTimeoutMs` bounds use above: the refusal is asserted here
  // AND against `@ethosagent/config`'s own loader, whose copy of the rule is
  // module-private. If either copy loosens, one half of this fails.
  it.each([
    ['an embedded username', 'http://ethos@proxy.example.com:3128'],
    ['an embedded password', 'http://:hunter2@proxy.example.com:3128'],
    ['both', 'http://ethos:hunter2@proxy.example.com:3128'],
    ['both, over socks5', 'socks5://ethos:hunter2@127.0.0.1:1080'],
    ['a query', 'http://proxy.example.com:3128?auth=hunter2'],
    ['a fragment', 'http://proxy.example.com:3128#hunter2'],
    ['a non-root path', 'http://proxy.example.com:3128/gateway'],
  ])(
    'browser.proxy.server with %s is refused here and fatal in the loader',
    async (_label, bad) => {
      await writeBase();
      await expect(service.update({ browser: { proxyServer: bad } })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
      const written = await storage.read(join(DATA, 'config.yaml'));
      expect(written).not.toContain('browser.proxy.');
      expect(written).not.toContain('hunter2');

      // Same value hand-edited into config.yaml: the loader refuses it too,
      // fatally, rather than dropping the block and sending traffic direct.
      await writeBase([`browser.proxy.server: ${bad}`]);
      const loaded = await loadFromDataDir(false);
      expect(loaded?.parseErrors ?? []).toHaveLength(1);
      expect(loaded?.config.browser?.proxy).toBeUndefined();
    },
  );

  it('names browser.proxy.username/password when the URL carries credentials', async () => {
    await writeBase();
    const creds = 'http://ethos:hunter2@proxy.example.com:3128';
    // Names the operator-facing key AND both fields the credentials belong in.
    await expect(service.update({ browser: { proxyServer: creds } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      cause: expect.stringMatching(
        /^browser\.proxy\.server .*browser\.proxy\.username and browser\.proxy\.password/s,
      ),
    });
    // The rejected value IS the credential; it must not come back in the error.
    await expect(service.update({ browser: { proxyServer: creds } })).rejects.toMatchObject({
      cause: expect.not.stringContaining('hunter2'),
    });
  });

  it('still accepts a bare endpoint with an explicit scheme and a port', async () => {
    await writeBase();
    await service.update({ browser: { proxyServer: 'http://proxy.example.com:3128' } });
    const loaded = await loadFromDataDir(false);
    expect(loaded?.parseErrors ?? []).toEqual([]);
    expect(loaded?.config.browser?.proxy?.server).toBe('http://proxy.example.com:3128');
  });

  it('refuses a proxy credential with no server to carry it', async () => {
    await writeBase();
    await expect(
      service.update({ browser: { proxyUsername: 'ethos', proxyPassword: 'orphan' } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    const written = await storage.read(join(DATA, 'config.yaml'));
    expect(written).not.toContain('browser.proxy.');
    expect(written).not.toContain('orphan');
  });
});
