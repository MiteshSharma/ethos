import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readConfig,
  readRawConfig,
  validateBotBindings,
  writeConfig,
} from '../index';

// Voice bot binding schema — plan/phases/gap-voice-realtime.md §3(b),(e).
// Mirrors telegram.bots[] but keyed on a room/number `match` pattern.

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

async function load(yaml: string): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

async function loadStrict(yaml: string) {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), yaml);
  return loadConfigStrict(storage);
}

describe('parseConfigYaml — voice.bots[]', () => {
  it('parses a multi-bot voice config with mixed bindings', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: +15551234567',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
        'voice.bots.1.id: reception',
        'voice.bots.1.match: room-support-*',
        'voice.bots.1.bind.type: team',
        'voice.bots.1.bind.name: eng',
      ].join('\n'),
    );

    expect(cfg.voice?.bots).toHaveLength(2);
    expect(cfg.voice?.bots[0]).toEqual({
      match: '+15551234567',
      bind: { type: 'personality', name: 'researcher' },
    });
    expect(cfg.voice?.bots[1]).toEqual({
      id: 'reception',
      match: 'room-support-*',
      bind: { type: 'team', name: 'eng' },
    });
  });

  it('honors bind.allowSlashSwitch', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'voice.bots.0.match: +1999',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
        'voice.bots.0.bind.allowSlashSwitch: true',
      ].join('\n'),
    );

    expect(cfg.voice?.bots[0].bind).toEqual({
      type: 'personality',
      name: 'researcher',
      allowSlashSwitch: true,
    });
  });

  it('round-trips through writeConfig -> readRawConfig', async () => {
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [
          {
            id: 'reception',
            match: '+15551234567',
            bind: { type: 'personality', name: 'researcher' },
          },
          { match: 'room-*', bind: { type: 'team', name: 'eng', allowSlashSwitch: true } },
        ],
      },
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const reloaded = await readRawConfig(storage);

    expect(reloaded?.voice?.bots).toEqual(original.voice?.bots);
  });

  it('omits malformed entries from the parsed list', async () => {
    // Entry 0 has a match but no bind — must not appear; entry 1 is well-formed.
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: p',
        'voice.bots.0.match: +1000',
        'voice.bots.1.match: +2000',
        'voice.bots.1.bind.type: personality',
        'voice.bots.1.bind.name: researcher',
      ].join('\n'),
    );

    expect(cfg.voice?.bots).toHaveLength(1);
    expect(cfg.voice?.bots[0].match).toBe('+2000');
  });
});

describe('loadConfigStrict — voice.bots malformed entries surface as parseErrors', () => {
  it('reports a missing match field', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'match'"))).toBe(
      true,
    );
  });

  it('reports a typo in bind.type', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: +1555',
        'voice.bots.0.bind.type: personailty',
        'voice.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("'personailty'"))).toBe(true);
    expect(result?.config.voice?.bots ?? []).toHaveLength(0);
  });

  it('returns empty parseErrors for a well-formed config', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: +1555',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(result?.parseErrors).toEqual([]);
    expect(result?.config.voice?.bots).toHaveLength(1);
  });
});

describe('parseConfigYaml — voice.livekit.*', () => {
  it('parses the LiveKit transport block alongside bots', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: room-*',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
        'voice.livekit.url: wss://live.example.com',
        'voice.livekit.apiKey: LK_KEY',
        'voice.livekit.apiSecret: LK_SECRET',
      ].join('\n'),
    );

    expect(cfg.voice?.livekit).toEqual({
      url: 'wss://live.example.com',
      apiKey: 'LK_KEY',
      apiSecret: 'LK_SECRET',
    });
    expect(cfg.voice?.bots).toHaveLength(1);
  });

  it('parses a LiveKit block with no bots', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.livekit.url: wss://live.example.com',
        'voice.livekit.apiKey: LK_KEY',
        'voice.livekit.apiSecret: LK_SECRET',
      ].join('\n'),
    );

    expect(cfg.voice?.livekit?.url).toBe('wss://live.example.com');
    expect(cfg.voice?.bots).toEqual([]);
  });

  it('round-trips the LiveKit block through writeConfig -> readRawConfig', async () => {
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [{ match: 'room-*', bind: { type: 'personality', name: 'researcher' } }],
        livekit: { url: 'wss://live.example.com', apiKey: 'LK_KEY', apiSecret: 'LK_SECRET' },
      },
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const onDisk = await readRawConfig(storage);
    expect(onDisk?.voice?.livekit?.apiKey).toBe(secretRef('voice/livekit/apiKey'));
    expect(onDisk?.voice?.livekit?.apiSecret).toBe(secretRef('voice/livekit/apiSecret'));
    const reloaded = await readConfig(storage, secrets);

    expect(reloaded?.voice).toEqual(original.voice);
  });

  it('surfaces a parse error for a partial LiveKit block', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.livekit.url: wss://live.example.com',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'apiKey'"))).toBe(
      true,
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'apiSecret'"))).toBe(
      true,
    );
    expect(result?.config.voice?.livekit).toBeUndefined();
  });
});

describe('parseConfigYaml — voice.trunk.*', () => {
  it('parses a full SIP trunk block alongside bots + livekit', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.bots.0.match: +15551234567',
        'voice.bots.0.bind.type: personality',
        'voice.bots.0.bind.name: researcher',
        'voice.trunk.provider: twilio',
        'voice.trunk.trunkId: TK123',
        'voice.trunk.fromNumber: +15550000000',
        'voice.trunk.username: sipuser',
        'voice.trunk.password: sippass',
      ].join('\n'),
    );

    expect(cfg.voice?.trunk).toEqual({
      provider: 'twilio',
      trunkId: 'TK123',
      fromNumber: '+15550000000',
      username: 'sipuser',
      password: 'sippass',
    });
    expect(cfg.voice?.bots).toHaveLength(1);
  });

  it('parses a minimal trunk block (provider + trunkId only)', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.trunk.provider: telnyx',
        'voice.trunk.trunkId: trunk-1',
      ].join('\n'),
    );

    expect(cfg.voice?.trunk).toEqual({ provider: 'telnyx', trunkId: 'trunk-1' });
    expect(cfg.voice?.bots).toEqual([]);
  });

  it('round-trips the trunk block through writeConfig -> readRawConfig', async () => {
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [{ match: '+1555', bind: { type: 'personality', name: 'researcher' } }],
        trunk: {
          provider: 'twilio',
          trunkId: 'TK123',
          fromNumber: '+15550000000',
          username: 'sipuser',
          password: 'sippass',
        },
      },
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);
    const onDisk = await readRawConfig(storage);
    expect(onDisk?.voice?.trunk?.password).toBe(secretRef('voice/trunk/password'));
    const reloaded = await readConfig(storage, secrets);

    expect(reloaded?.voice).toEqual(original.voice);
  });

  it('surfaces a parse error for a trunk block missing trunkId', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.trunk.provider: twilio',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("missing required field 'trunkId'"))).toBe(
      true,
    );
    expect(result?.config.voice?.trunk).toBeUndefined();
  });

  it('surfaces a parse error for an invalid trunk provider', async () => {
    const result = await loadStrict(
      [
        'provider: anthropic',
        'model: m',
        'apiKey: sk',
        'personality: researcher',
        'voice.trunk.provider: vonage',
        'voice.trunk.trunkId: TK123',
      ].join('\n'),
    );
    expect(result?.parseErrors.some((e) => e.includes("invalid provider 'vonage'"))).toBe(true);
    expect(result?.config.voice?.trunk).toBeUndefined();
  });
});

describe('validateBotBindings — voice.bots[]', () => {
  const deps = {
    personalityIds: new Set(['researcher']),
    teamNames: new Set(['eng']),
  };

  it('accepts a voice bot bound to a known personality', () => {
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: { bots: [{ match: '+1555', bind: { type: 'personality', name: 'researcher' } }] },
    };
    expect(validateBotBindings(config, deps)).toEqual([]);
  });

  it('rejects a voice bot bound to an unknown personality', () => {
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: { bots: [{ match: '+1555', bind: { type: 'personality', name: 'ghost' } }] },
    };
    const errors = validateBotBindings(config, deps);
    expect(errors.some((e) => e.includes("bind.name='ghost' is not a known personality"))).toBe(
      true,
    );
  });

  it('rejects two voice bots with a colliding derived botKey', () => {
    const config: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [
          { match: '+1555', bind: { type: 'personality', name: 'researcher' } },
          { match: '+1555', bind: { type: 'personality', name: 'researcher' } },
        ],
      },
    };
    const errors = validateBotBindings(config, deps);
    expect(errors.some((e) => e.includes('duplicate botKey'))).toBe(true);
  });
});
