import { homedir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

describe('ethosDir', () => {
  afterEach(() => {
    delete process.env.ETHOS_STATE_DIR;
  });

  it('returns ~/.ethos when ETHOS_STATE_DIR is not set', () => {
    delete process.env.ETHOS_STATE_DIR;
    expect(ethosDir()).toBe(join(homedir(), '.ethos'));
  });

  it('returns ETHOS_STATE_DIR when set', () => {
    process.env.ETHOS_STATE_DIR = '/tmp/custom-ethos';
    expect(ethosDir()).toBe('/tmp/custom-ethos');
  });
});

async function loadYaml(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('parseConfigYaml — whatsapp.<n>.<field>', () => {
  it('parses an indexed whatsapp entry into config.whatsapp', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'whatsapp.0.id: wa1',
        'whatsapp.0.default_mode: all',
        'whatsapp.0.allowed_numbers: 111@s.whatsapp.net,222@s.whatsapp.net',
      ].join('\n'),
    );
    expect(cfg.whatsapp).toEqual([
      {
        id: 'wa1',
        default_mode: 'all',
        allowed_numbers: ['111@s.whatsapp.net', '222@s.whatsapp.net'],
      },
    ]);
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      whatsapp: [
        {
          id: 'wa1',
          default_mode: 'all',
          allowed_numbers: ['111@s.whatsapp.net', '222@s.whatsapp.net'],
        },
      ],
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('whatsapp.0.id: wa1');
    expect(raw).toContain('whatsapp.0.default_mode: all');
    expect(raw).toContain('whatsapp.0.allowed_numbers: 111@s.whatsapp.net,222@s.whatsapp.net');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.whatsapp).toEqual(original.whatsapp);
  });

  it('round-trips toolSettings (global web_search fallback map)', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      toolSettings: {
        _default: { web_search: { provider: 'tavily', secret: 'tavily-main' } },
        scout: { web_search: { provider: 'brave', secret: 'brave-main' } },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('toolSettings._default.web_search.provider: tavily');
    expect(raw).toContain('toolSettings._default.web_search.secret: tavily-main');
    expect(raw).toContain('toolSettings.scout.web_search.provider: brave');
    expect(raw).toContain('toolSettings.scout.web_search.secret: brave-main');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.toolSettings).toEqual(original.toolSettings);
  });

  it('round-trips phone_number for phone-number pairing', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      whatsapp: [{ id: 'wa1', default_mode: 'all', phone_number: '+1 555 123 4567' }],
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('whatsapp.0.phone_number: +1 555 123 4567');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.whatsapp).toEqual(original.whatsapp);
  });

  it('leaves config.whatsapp undefined when no whatsapp keys are present', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
      ].join('\n'),
    );
    expect(cfg.whatsapp).toBeUndefined();
  });

  it('parses an optional bind and round-trips it', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'whatsapp.0.id: wa1',
        'whatsapp.0.bind.type: personality',
        'whatsapp.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(cfg.whatsapp?.[0]?.bind).toEqual({ type: 'personality', name: 'researcher' });

    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('whatsapp.0.bind.type: personality');
    expect(raw).toContain('whatsapp.0.bind.name: researcher');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.whatsapp?.[0]?.bind).toEqual({
      type: 'personality',
      name: 'researcher',
    });
  });

  it('leaves bind undefined for a whatsapp entry with no bind keys', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'whatsapp.0.id: wa1',
        'whatsapp.0.default_mode: all',
      ].join('\n'),
    );
    expect(cfg.whatsapp?.[0]?.bind).toBeUndefined();
  });
});

describe('parseConfigYaml — admin.enabled', () => {
  it('parses admin.enabled: true into config.admin', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'admin.enabled: true',
      ].join('\n'),
    );
    expect(cfg.admin).toEqual({ enabled: true });
  });

  it('parses admin.enabled: false into config.admin', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'admin.enabled: false',
      ].join('\n'),
    );
    expect(cfg.admin).toEqual({ enabled: false });
  });

  it('leaves config.admin undefined when the key is absent (default off)', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
      ].join('\n'),
    );
    expect(cfg.admin).toBeUndefined();
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      admin: { enabled: true },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('admin.enabled: true');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.admin).toEqual({ enabled: true });
  });
});

describe('parseConfigYaml — a2a.enabled', () => {
  it('parses a2a.enabled: true into config.a2a', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'a2a.enabled: true',
      ].join('\n'),
    );
    expect(cfg.a2a).toEqual({ enabled: true });
  });

  it('leaves config.a2a undefined when the key is absent (default off)', async () => {
    const cfg = await loadYaml(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
      ].join('\n'),
    );
    expect(cfg.a2a).toBeUndefined();
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      a2a: { enabled: true },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('a2a.enabled: true');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.a2a).toEqual({ enabled: true });
  });
});

describe('parseConfigYaml — security.trusted_github_orgs', () => {
  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    'apiKey: sk',
    'personality: researcher',
  ];

  it('leaves config.security undefined when the key is absent', async () => {
    const cfg = await loadYaml(base.join('\n'));
    expect(cfg.security).toBeUndefined();
  });

  it('parses a comma-separated org list', async () => {
    const cfg = await loadYaml(
      [...base, 'security.trusted_github_orgs: acme-corp, ethosagent'].join('\n'),
    );
    expect(cfg.security).toEqual({ trustedGitHubOrgs: ['acme-corp', 'ethosagent'] });
  });

  it('parses an explicitly empty list as [] rather than undefined', async () => {
    const cfg = await loadYaml([...base, 'security.trusted_github_orgs: ""'].join('\n'));
    expect(cfg.security).toEqual({ trustedGitHubOrgs: [] });
  });

  it('parses a bare key with no value as [] rather than undefined', async () => {
    const cfg = await loadYaml([...base, 'security.trusted_github_orgs:'].join('\n'));
    expect(cfg.security).toEqual({ trustedGitHubOrgs: [] });
  });

  it('round-trips a configured list through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk',
        personality: 'researcher',
        security: { trustedGitHubOrgs: ['acme-corp'] },
      },
      new InMemorySecretsResolver(),
    );

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('security.trusted_github_orgs: acme-corp');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.security).toEqual({ trustedGitHubOrgs: ['acme-corp'] });
  });

  it('round-trips an empty list without restoring the default', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk',
        personality: 'researcher',
        security: { trustedGitHubOrgs: [] },
      },
      new InMemorySecretsResolver(),
    );

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.security).toEqual({ trustedGitHubOrgs: [] });
  });
});

describe('parseConfigYaml — storage backend', () => {
  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    'apiKey: sk',
    'personality: researcher',
  ];

  it('parses storage.backend: s3 and nested storage.s3.* keys', async () => {
    const cfg = await loadYaml(
      [
        ...base,
        'storage.backend: s3',
        'storage.s3.bucket: my-bucket',
        'storage.s3.region: us-east-1',
        'storage.s3.prefix: ethos',
      ].join('\n'),
    );
    expect(cfg.storage?.backend).toBe('s3');
    expect(cfg.storage?.s3?.bucket).toBe('my-bucket');
    expect(cfg.storage?.s3?.region).toBe('us-east-1');
    expect(cfg.storage?.s3?.prefix).toBe('ethos');
  });

  it('keeps storage.encryption: true alone yielding { encryption: true }', async () => {
    const cfg = await loadYaml([...base, 'storage.encryption: true'].join('\n'));
    expect(cfg.storage).toEqual({ encryption: true });
    expect(cfg.storage?.backend).toBeUndefined();
    expect(cfg.storage?.s3).toBeUndefined();
  });

  it('omits the s3 block when backend is s3 but no bucket is set', async () => {
    const cfg = await loadYaml([...base, 'storage.backend: s3'].join('\n'));
    expect(cfg.storage?.backend).toBe('s3');
    expect(cfg.storage?.s3).toBeUndefined();
  });

  it('leaves storage undefined when no storage.* keys are present', async () => {
    const cfg = await loadYaml(base.join('\n'));
    expect(cfg.storage).toBeUndefined();
  });

  it('omits an invalid storage.backend value', async () => {
    const cfg = await loadYaml([...base, 'storage.backend: garbage'].join('\n'));
    expect(cfg.storage?.backend).toBeUndefined();
  });
});

describe('parseConfigYaml — display.streaming_edits', () => {
  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    'apiKey: sk',
    'personality: researcher',
  ];

  it('parses off/dms/all verbatim', async () => {
    for (const mode of ['off', 'dms', 'all'] as const) {
      const cfg = await loadYaml([...base, `display.streaming_edits: ${mode}`].join('\n'));
      expect(cfg.displayStreamingEdits).toBe(mode);
    }
  });

  it('leaves displayStreamingEdits undefined when absent (default dms applied by the gateway consumer)', async () => {
    const cfg = await loadYaml(base.join('\n'));
    expect(cfg.displayStreamingEdits).toBeUndefined();
  });

  it('omits an invalid display.streaming_edits value', async () => {
    const cfg = await loadYaml([...base, 'display.streaming_edits: garbage'].join('\n'));
    expect(cfg.displayStreamingEdits).toBeUndefined();
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      displayStreamingEdits: 'all',
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('display.streaming_edits: all');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.displayStreamingEdits).toBe('all');
  });
});

describe('parseConfigYaml — display.call_style / display.call_accent', () => {
  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    'apiKey: sk',
    'personality: researcher',
  ];

  it('parses the three call treatments verbatim', async () => {
    for (const style of ['liquid', 'orb', 'rings'] as const) {
      const cfg = await loadYaml([...base, `display.call_style: ${style}`].join('\n'));
      expect(cfg.displayCallStyle).toBe(style);
    }
  });

  it('parses `personality` — the default, and the only non-pinning value', async () => {
    const cfg = await loadYaml([...base, 'display.call_style: personality'].join('\n'));
    expect(cfg.displayCallStyle).toBe('personality');
  });

  it('leaves both undefined when absent (personality applied by the surface)', async () => {
    const cfg = await loadYaml(base.join('\n'));
    expect(cfg.displayCallStyle).toBeUndefined();
    expect(cfg.displayCallAccent).toBeUndefined();
  });

  it('omits an invalid treatment', async () => {
    const cfg = await loadYaml([...base, 'display.call_style: sparkles'].join('\n'));
    expect(cfg.displayCallStyle).toBeUndefined();
  });

  it('parses `personality` and a 6-digit hex, and drops anything else', async () => {
    const personality = await loadYaml([...base, 'display.call_accent: personality'].join('\n'));
    expect(personality.displayCallAccent).toBe('personality');

    const hex = await loadYaml([...base, 'display.call_accent: "#4ADE80"'].join('\n'));
    expect(hex.displayCallAccent).toBe('#4ADE80');

    // A typo must not reach a canvas fillStyle — the surface falls back to the
    // personality accent instead of painting the call an unreadable color.
    for (const bad of ['red', '#GGGGGG', '#4ADE8']) {
      const cfg = await loadYaml([...base, `display.call_accent: "${bad}"`].join('\n'));
      expect(cfg.displayCallAccent).toBeUndefined();
    }
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      displayCallStyle: 'orb',
      displayCallAccent: '#E879F9',
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('display.call_style: orb');
    expect(raw).toContain('display.call_accent: #E879F9');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.displayCallStyle).toBe('orb');
    expect(roundTripped?.displayCallAccent).toBe('#E879F9');
  });
});

describe('parseConfigYaml — voice.channels / voice.transcode / voice.artifacts', () => {
  const base = [
    'provider: anthropic',
    'model: claude-opus-4-7',
    'apiKey: sk',
    'personality: researcher',
  ];

  it('parses each new key to its typed value', async () => {
    const cfg = await loadYaml(
      [
        ...base,
        'voice.channels.telegram.ttsOut: true',
        'voice.channels.slack.ttsOut: false',
        'voice.transcode.ffmpegPath: /opt/homebrew/bin/ffmpeg',
        'voice.transcode.bitrateKbps: 48',
        'voice.transcode.timeout: 45',
        'voice.artifacts.abandonAfterDays: 14',
        'voice.artifacts.maxTotalMb: 1024',
      ].join('\n'),
    );
    expect(cfg.voice?.channels).toEqual({
      telegram: { ttsOut: true },
      slack: { ttsOut: false },
    });
    expect(cfg.voice?.transcode).toEqual({
      ffmpegPath: '/opt/homebrew/bin/ffmpeg',
      bitrateKbps: 48,
      timeout: 45,
    });
    expect(cfg.voice?.artifacts).toEqual({ abandonAfterDays: 14, maxTotalMb: 1024 });
  });

  it('leaves voice undefined for a config with no voice keys at all', async () => {
    const cfg = await loadYaml(base.join('\n'));
    expect(cfg.voice).toBeUndefined();
  });

  it('ignores an unknown platform id', async () => {
    const cfg = await loadYaml(
      [...base, 'voice.channels.matrix.ttsOut: true', 'voice.channels.discord.ttsOut: true'].join(
        '\n',
      ),
    );
    expect(cfg.voice?.channels).toEqual({ discord: { ttsOut: true } });
  });

  it('ignores a non-boolean ttsOut, leaving the section absent rather than throwing', async () => {
    const cfg = await loadYaml([...base, 'voice.channels.slack.ttsOut: yes'].join('\n'));
    expect(cfg.voice).toBeUndefined();
    expect(cfg.apiKey).toBe('sk');
  });

  it('ignores out-of-range and non-numeric values, and still loads the rest', async () => {
    const cfg = await loadYaml(
      [
        ...base,
        'voice.transcode.bitrateKbps: 4',
        'voice.transcode.timeout: 601',
        'voice.artifacts.abandonAfterDays: soon',
        'voice.artifacts.maxTotalMb: 512',
      ].join('\n'),
    );
    expect(cfg.voice?.transcode).toBeUndefined();
    expect(cfg.voice?.artifacts).toEqual({ maxTotalMb: 512 });
    expect(cfg.personality).toBe('researcher');
  });

  it('round-trips through writeConfig and back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const voice: NonNullable<EthosConfig['voice']> = {
      bots: [],
      channels: { telegram: { ttsOut: true }, whatsapp: { ttsOut: false } },
      transcode: { ffmpegPath: '/usr/bin/ffmpeg', bitrateKbps: 32, timeout: 30 },
      artifacts: { abandonAfterDays: 7, maxTotalMb: 512 },
    };
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      voice,
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('voice.channels.telegram.ttsOut: true');
    expect(raw).toContain('voice.channels.whatsapp.ttsOut: false');
    expect(raw).toContain('voice.transcode.ffmpegPath: /usr/bin/ffmpeg');
    expect(raw).toContain('voice.transcode.bitrateKbps: 32');
    expect(raw).toContain('voice.transcode.timeout: 30');
    expect(raw).toContain('voice.artifacts.abandonAfterDays: 7');
    expect(raw).toContain('voice.artifacts.maxTotalMb: 512');

    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.voice).toEqual(voice);
  });
});
