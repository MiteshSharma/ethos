// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the asserted string
// is a literal `${secrets:…}` config reference, not template interpolation.

import { join } from 'node:path';
import { readRawConfig } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

// Settings → Voice → Telephony: `voice.trunk.*`, `voice.livekit.*`,
// `voice.inbound.*`, `voice.bargeIn.*` and `voice.bots[]`.
//
// The phase's hard rule is no yaml-only keys, and the test of that is not "the
// web can write it" but "the web writes what the CLI can load". So every case
// below round-trips twice: through `ConfigService.get` and through
// `readRawConfig`, the loader the agent itself boots from.

const DATA = '/data';

const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk-anthropic-1234567890abcdef',
  'personality: researcher',
];

describe('Settings → Voice telephony', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
  // `readRawConfig` reads `<ethosDir()>/config.yaml`; point it at the same
  // in-memory dir the repository writes to.
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
    service = new ConfigService({
      config: repo,
      secrets,
      personalities: { exists: async (id) => id === 'receptionist' || id === 'researcher' },
    });
  });

  async function seed(lines: string[] = []): Promise<void> {
    await storage.write(join(DATA, 'config.yaml'), [...BASE, ...lines].join('\n'));
  }

  async function yaml(): Promise<string> {
    return (await storage.read(join(DATA, 'config.yaml'))) ?? '';
  }

  // -- trunk -----------------------------------------------------------------

  it('round-trips a trunk through write, read, and the CLI loader', async () => {
    await seed();
    await service.update({
      voiceTrunkProvider: 'twilio',
      voiceTrunkId: 'ST_abc123',
      voiceTrunkFromNumber: '+15551234567',
      voiceTrunkUsername: 'ethos-sip',
      voiceTrunkPassword: 'sip-password-abcdefgh',
      voiceTrunkWebhookSecret: 'hook-secret-abcdefgh',
      voiceTrunkWebhookPath: '/voice/inbound',
      voiceTrunkCodec: 'opus',
    });

    const read = await service.get();
    expect(read.voiceTrunkProvider).toBe('twilio');
    expect(read.voiceTrunkId).toBe('ST_abc123');
    expect(read.voiceTrunkFromNumber).toBe('+15551234567');
    expect(read.voiceTrunkUsername).toBe('ethos-sip');
    expect(read.voiceTrunkWebhookPath).toBe('/voice/inbound');
    expect(read.voiceTrunkCodec).toBe('opus');

    // A trunk the web writes but the agent cannot load is a trunk that does not
    // exist. `readRawConfig` resolves nothing, so the secrets are still refs.
    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.trunk).toEqual({
      provider: 'twilio',
      trunkId: 'ST_abc123',
      fromNumber: '+15551234567',
      username: 'ethos-sip',
      password: '${secrets:voice/trunk/password}',
      webhookSecret: '${secrets:voice/trunk/webhookSecret}',
      webhookPath: '/voice/inbound',
      codec: 'opus',
    });
  });

  it('externalizes the trunk secrets and only ever previews them', async () => {
    await seed();
    await service.update({
      voiceTrunkProvider: 'telnyx',
      voiceTrunkId: 'ST_abc123',
      voiceTrunkPassword: 'sip-password-abcdefgh',
      voiceTrunkWebhookSecret: 'hook-secret-abcdefgh',
    });

    const file = await yaml();
    expect(file).not.toContain('sip-password-abcdefgh');
    expect(file).not.toContain('hook-secret-abcdefgh');
    expect(file).toContain('voice.trunk.password: "${secrets:voice/trunk/password}"');
    expect(file).toContain('voice.trunk.webhookSecret: "${secrets:voice/trunk/webhookSecret}"');
    expect(await secrets.get('voice/trunk/password')).toBe('sip-password-abcdefgh');
    expect(await secrets.get('voice/trunk/webhookSecret')).toBe('hook-secret-abcdefgh');

    const read = await service.get();
    expect(read.voiceTrunkPasswordPreview).not.toBeNull();
    expect(read.voiceTrunkPasswordPreview).not.toContain('password-abcdefgh');
    expect(read.voiceTrunkWebhookSecretPreview).not.toContain('secret-abcdefgh');
  });

  it('a save with a blank secret keeps the stored one', async () => {
    await seed();
    await service.update({
      voiceTrunkProvider: 'twilio',
      voiceTrunkId: 'ST_abc123',
      voiceTrunkPassword: 'sip-password-abcdefgh',
    });
    // What the form sends when the operator edits the caller ID and never
    // touches the password field it only ever saw a preview of.
    await service.update({
      voiceTrunkProvider: 'twilio',
      voiceTrunkId: 'ST_abc123',
      voiceTrunkFromNumber: '+15559999999',
      voiceTrunkPassword: '',
    });

    expect(await secrets.get('voice/trunk/password')).toBe('sip-password-abcdefgh');
    expect((await service.get()).voiceTrunkFromNumber).toBe('+15559999999');
  });

  it('clearing the provider drops the whole trunk block and its vault entries', async () => {
    await seed();
    await service.update({
      voiceTrunkProvider: 'twilio',
      voiceTrunkId: 'ST_abc123',
      voiceTrunkPassword: 'sip-password-abcdefgh',
      voiceTrunkWebhookSecret: 'hook-secret-abcdefgh',
    });
    expect(await secrets.get('voice/trunk/password')).toBe('sip-password-abcdefgh');

    await service.update({ voiceTrunkProvider: null });

    const read = await service.get();
    expect(read.voiceTrunkProvider).toBeNull();
    expect(read.voiceTrunkId).toBeNull();
    expect(read.voiceTrunkPasswordPreview).toBeNull();
    expect(await yaml()).not.toContain('voice.trunk.');
    // The config key was the only thing pointing at the vault entry.
    expect(await secrets.get('voice/trunk/password')).toBeNull();
    expect(await secrets.get('voice/trunk/webhookSecret')).toBeNull();
  });

  it('refuses a trunk with no id — the CLI loader would reject the block', async () => {
    await seed();
    await expect(service.update({ voiceTrunkProvider: 'twilio' })).rejects.toThrow(
      /voice\.trunk\.trunkId is required/,
    );
    expect(await yaml()).not.toContain('voice.trunk.');
  });

  it('accepts a partial edit when the file already carries the required fields', async () => {
    await seed(['voice.trunk.provider: twilio', 'voice.trunk.trunkId: ST_abc123']);
    await service.update({ voiceTrunkFromNumber: '+15551112222' });
    expect((await service.get()).voiceTrunkFromNumber).toBe('+15551112222');
  });

  it('refuses a webhook path that does not start with a slash', async () => {
    await seed();
    await expect(service.update({ voiceTrunkWebhookPath: 'voice/inbound' })).rejects.toThrow(
      /must start with/,
    );
  });

  // -- livekit ---------------------------------------------------------------

  it('round-trips the LiveKit block and vaults both credentials', async () => {
    await seed();
    await service.update({
      voiceLivekitUrl: 'wss://ethos.livekit.cloud',
      voiceLivekitApiKey: 'API-key-abcdefghijkl',
      voiceLivekitApiSecret: 'API-secret-abcdefghijkl',
    });

    const read = await service.get();
    expect(read.voiceLivekitUrl).toBe('wss://ethos.livekit.cloud');
    expect(read.voiceLivekitApiKeyPreview).not.toBeNull();
    expect(read.voiceLivekitApiKeyPreview).not.toContain('abcdefghijkl');

    const file = await yaml();
    expect(file).not.toContain('API-secret-abcdefghijkl');
    expect(await secrets.get('voice/livekit/apiSecret')).toBe('API-secret-abcdefghijkl');

    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.livekit).toEqual({
      url: 'wss://ethos.livekit.cloud',
      apiKey: '${secrets:voice/livekit/apiKey}',
      apiSecret: '${secrets:voice/livekit/apiSecret}',
    });
  });

  it('refuses a LiveKit block missing a credential', async () => {
    await seed();
    await expect(service.update({ voiceLivekitUrl: 'wss://ethos.livekit.cloud' })).rejects.toThrow(
      /voice\.livekit\.apiKey is required/,
    );
  });

  it('clearing the url drops the LiveKit block and its vault entries', async () => {
    await seed();
    await service.update({
      voiceLivekitUrl: 'wss://ethos.livekit.cloud',
      voiceLivekitApiKey: 'API-key-abcdefghijkl',
      voiceLivekitApiSecret: 'API-secret-abcdefghijkl',
    });
    await service.update({ voiceLivekitUrl: null });

    expect((await service.get()).voiceLivekitUrl).toBeNull();
    expect(await secrets.get('voice/livekit/apiKey')).toBeNull();
    expect(await secrets.get('voice/livekit/apiSecret')).toBeNull();
  });

  // -- inbound ---------------------------------------------------------------

  it('round-trips the inbound policy through the CLI loader', async () => {
    await seed();
    await service.update({
      voiceInboundAllowlist: ['+15551234567', '+1555*'],
      voiceInboundReceptionist: 'receptionist',
      voiceInboundConcurrencyCap: 3,
      voiceInboundPerCallerPerHour: 4,
      voiceInboundDailyBudgetUsd: 12.5,
      voiceInboundPrewarm: 'allowlisted',
      voiceInboundOwnerPlatform: 'telegram',
      voiceInboundOwnerChatId: '4242',
      voiceInboundOwnerBotKey: 'bot-a',
    });

    const read = await service.get();
    expect(read.voiceInboundAllowlist).toEqual(['+15551234567', '+1555*']);
    expect(read.voiceInboundConcurrencyCap).toBe(3);
    expect(read.voiceInboundDailyBudgetUsd).toBe(12.5);
    expect(read.voiceInboundPrewarm).toBe('allowlisted');
    expect(read.voiceInboundOwnerChatId).toBe('4242');

    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.inbound).toEqual({
      allowlist: ['+15551234567', '+1555*'],
      receptionist: 'receptionist',
      concurrencyCap: 3,
      perCallerPerHour: 4,
      dailyBudgetUsd: 12.5,
      prewarm: 'allowlisted',
      owner: { platform: 'telegram', chatId: '4242', botKey: 'bot-a' },
    });
  });

  it('distinguishes an absent allowlist from an empty one', async () => {
    await seed();
    expect((await service.get()).voiceInboundAllowlist).toBeNull();
    await service.update({ voiceInboundAllowlist: ['+15551234567'] });
    expect((await service.get()).voiceInboundAllowlist).toEqual(['+15551234567']);
    // An empty list clears the key — "screen everyone" is the receptionist's
    // job, not an allowlist nobody is on.
    await service.update({ voiceInboundAllowlist: [] });
    expect((await service.get()).voiceInboundAllowlist).toBeNull();
  });

  it('refuses half an owner destination', async () => {
    await seed();
    await expect(service.update({ voiceInboundOwnerPlatform: 'telegram' })).rejects.toThrow(
      /voice\.inbound\.owner\.chatId is required/,
    );
  });

  it('refuses a zero concurrency cap', async () => {
    await seed();
    await expect(service.update({ voiceInboundConcurrencyCap: 0 })).rejects.toThrow(
      /voiceInboundConcurrencyCap/,
    );
  });

  // -- bargeIn ---------------------------------------------------------------

  it('round-trips per-surface barge-in tuning and replaces the block wholesale', async () => {
    await seed();
    await service.update({
      voiceBargeIn: {
        call: { energyThreshold: 0.12, minSpeechMs: 300, silenceMs: 800 },
        satellite: { energyThreshold: 0.04 },
      },
    });

    const read = await service.get();
    expect(read.voiceBargeIn.call).toEqual({
      energyThreshold: 0.12,
      minSpeechMs: 300,
      silenceMs: 800,
    });
    expect(read.voiceBargeIn.satellite).toEqual({
      energyThreshold: 0.04,
      minSpeechMs: null,
      silenceMs: null,
    });
    // Exactly the two surfaces that were written — nothing else materializes.
    expect(Object.keys(read.voiceBargeIn).sort()).toEqual(['call', 'satellite']);

    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.bargeIn).toEqual({
      call: { energyThreshold: 0.12, minSpeechMs: 300, silenceMs: 800 },
      satellite: { energyThreshold: 0.04 },
    });

    // A save carries the whole block, so an omitted surface loses its tuning.
    await service.update({ voiceBargeIn: { call: { minSpeechMs: 250 } } });
    const after = await service.get();
    expect(Object.keys(after.voiceBargeIn)).toEqual(['call']);
    expect(after.voiceBargeIn.call).toEqual({
      energyThreshold: null,
      minSpeechMs: 250,
      silenceMs: null,
    });
  });

  it('refuses an unknown barge-in surface rather than dropping it', async () => {
    await seed();
    await expect(
      service.update({ voiceBargeIn: { speaker: { minSpeechMs: 200 } } }),
    ).rejects.toThrow(/is not a barge-in surface/);
    expect(await yaml()).not.toContain('voice.bargeIn.');
  });

  // `browser` is refused for the same reason and by the same code path: the
  // browser talk lane endpoints in the browser, off `display.voice_*`, so a
  // threshold written here would round-trip and change nothing.
  it('refuses the browser surface', async () => {
    await seed();
    await expect(
      service.update({ voiceBargeIn: { browser: { energyThreshold: 0.2 } } }),
    ).rejects.toThrow(/is not a barge-in surface/);
    expect(await yaml()).not.toContain('voice.bargeIn.');
  });

  it('refuses an energy threshold outside (0, 1]', async () => {
    await seed();
    await expect(
      service.update({ voiceBargeIn: { call: { energyThreshold: 1.5 } } }),
    ).rejects.toThrow(/\(0, 1\]/);
  });

  // -- bots ------------------------------------------------------------------

  it('round-trips the number → bot → personality table through the CLI loader', async () => {
    await seed();
    await service.update({
      voiceBots: [
        {
          id: 'main-line',
          match: '+15551234567',
          bind: { type: 'personality', name: 'receptionist', allowSlashSwitch: true },
        },
        { match: '+1555*', bind: { type: 'personality', name: 'researcher' } },
      ],
    });

    const read = await service.get();
    expect(read.voiceBots).toEqual([
      {
        id: 'main-line',
        match: '+15551234567',
        bind: { type: 'personality', name: 'receptionist', allowSlashSwitch: true },
      },
      {
        id: null,
        match: '+1555*',
        bind: { type: 'personality', name: 'researcher', allowSlashSwitch: false },
      },
    ]);

    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.bots).toEqual([
      {
        id: 'main-line',
        match: '+15551234567',
        bind: { type: 'personality', name: 'receptionist', allowSlashSwitch: true },
      },
      { match: '+1555*', bind: { type: 'personality', name: 'researcher' } },
    ]);
  });

  it('replaces the whole table, renumbered, so a removed row is gone', async () => {
    await seed();
    await service.update({
      voiceBots: [
        { match: '+15551234567', bind: { type: 'personality', name: 'receptionist' } },
        { match: '+15559999999', bind: { type: 'personality', name: 'researcher' } },
      ],
    });
    await service.update({
      voiceBots: [{ match: '+15559999999', bind: { type: 'personality', name: 'researcher' } }],
    });

    const read = await service.get();
    expect(read.voiceBots).toHaveLength(1);
    expect(read.voiceBots[0]?.match).toBe('+15559999999');
    expect(await yaml()).not.toContain('+15551234567');
    expect(await yaml()).toContain('voice.bots.0.match: +15559999999');
  });

  it('refuses a bot bound to a personality that does not exist', async () => {
    await seed();
    await expect(
      service.update({
        voiceBots: [{ match: '+15551234567', bind: { type: 'personality', name: 'ghost' } }],
      }),
    ).rejects.toThrow(/unknown personality 'ghost'/);
    expect(await yaml()).not.toContain('voice.bots.');
  });

  it('does not check a team bind against the personality registry', async () => {
    await seed();
    await service.update({
      voiceBots: [{ match: '+15551234567', bind: { type: 'team', name: 'support' } }],
    });
    expect((await service.get()).voiceBots[0]?.bind).toEqual({
      type: 'team',
      name: 'support',
      allowSlashSwitch: false,
    });
  });

  it('refuses a bot id the config format cannot carry', async () => {
    await seed();
    await expect(
      service.update({
        voiceBots: [
          { id: 'main line', match: '+1555', bind: { type: 'personality', name: 'researcher' } },
        ],
      }),
    ).rejects.toThrow(/identifier/);
  });

  it('sorts stored bots numerically, not lexicographically', async () => {
    await seed([
      'voice.bots.2.match: +2',
      'voice.bots.2.bind.type: personality',
      'voice.bots.2.bind.name: researcher',
      'voice.bots.10.match: +10',
      'voice.bots.10.bind.type: personality',
      'voice.bots.10.bind.name: researcher',
    ]);
    expect((await service.get()).voiceBots.map((b) => b.match)).toEqual(['+2', '+10']);
  });

  // -- isolation -------------------------------------------------------------

  it('leaves telephony alone when the patch does not mention it', async () => {
    await seed([
      'voice.trunk.provider: twilio',
      'voice.trunk.trunkId: ST_abc123',
      'voice.bots.0.match: +15551234567',
      'voice.bots.0.bind.type: personality',
      'voice.bots.0.bind.name: receptionist',
    ]);
    await service.update({ voiceDefaultMode: 'all' });
    const read = await service.get();
    expect(read.voiceTrunkProvider).toBe('twilio');
    expect(read.voiceBots).toHaveLength(1);
  });
});
