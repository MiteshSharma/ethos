import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readConfig,
  readRawConfig,
  validateNoPlaintextSecrets,
  writeConfig,
} from '../index';

// V4 telephony config surface — plan/phases/voice-v4-telephony.md.
// `voice.trunk.*` gains the inbound-webhook facts, `voice.inbound.*` carries the
// answering policy, `voice.bargeIn.*` tunes VAD per audio surface.

function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

async function parseErrors(lines: string[]): Promise<string[]> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  const result = await loadConfigStrict(storage);
  return result?.parseErrors ?? [];
}

describe('parseConfigYaml — V4 telephony keys', () => {
  it('parses a full telephony config into the typed shape', async () => {
    const cfg = await load([
      'voice.bots.0.match: +15551234567',
      'voice.bots.0.bind.type: personality',
      'voice.bots.0.bind.name: researcher',
      'voice.trunk.provider: livekit',
      'voice.trunk.trunkId: ST_1',
      'voice.trunk.fromNumber: +15550000000',
      'voice.trunk.username: sipuser',
      'voice.trunk.password: sippass',
      'voice.trunk.webhookSecret: hook-secret',
      'voice.trunk.webhookPath: /voice/inbound',
      'voice.trunk.codec: opus',
      'voice.inbound.allowlist: +1555123*, +447700900000 ,',
      'voice.inbound.receptionist: receptionist',
      'voice.inbound.concurrencyCap: 3',
      'voice.inbound.perCallerPerHour: 5',
      'voice.inbound.dailyBudgetUsd: 12.5',
      'voice.inbound.prewarm: allowlisted',
      'voice.inbound.owner.platform: telegram',
      'voice.inbound.owner.chatId: 4242',
      'voice.inbound.owner.botKey: bot-a',
      'voice.bargeIn.call.energyThreshold: 0.4',
      'voice.bargeIn.call.minSpeechMs: 220',
      'voice.bargeIn.call.silenceMs: 700',
      'voice.bargeIn.satellite.energyThreshold: 0.2',
      'voice.bargeIn.satellite.silenceMs: 900',
    ]);

    expect(cfg.voice?.trunk).toEqual({
      provider: 'livekit',
      trunkId: 'ST_1',
      fromNumber: '+15550000000',
      username: 'sipuser',
      password: 'sippass',
      webhookSecret: 'hook-secret',
      webhookPath: '/voice/inbound',
      codec: 'opus',
    });
    expect(cfg.voice?.inbound).toEqual({
      allowlist: ['+1555123*', '+447700900000'],
      receptionist: 'receptionist',
      concurrencyCap: 3,
      perCallerPerHour: 5,
      dailyBudgetUsd: 12.5,
      prewarm: 'allowlisted',
      owner: { platform: 'telegram', chatId: '4242', botKey: 'bot-a' },
    });
    expect(cfg.voice?.bargeIn).toEqual({
      call: { energyThreshold: 0.4, minSpeechMs: 220, silenceMs: 700 },
      satellite: { energyThreshold: 0.2, silenceMs: 900 },
    });
  });

  it('parses provider: livekit', async () => {
    const cfg = await load(['voice.trunk.provider: livekit', 'voice.trunk.trunkId: ST_1']);
    expect(cfg.voice?.trunk).toEqual({ provider: 'livekit', trunkId: 'ST_1' });
  });

  it('leaves an absent allowlist and an absent owner undefined', async () => {
    const cfg = await load(['voice.inbound.concurrencyCap: 2']);
    expect(cfg.voice?.inbound).toEqual({ concurrencyCap: 2 });
  });

  it('round-trips every new key through writeConfig -> readRawConfig -> writeConfig', async () => {
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [{ match: '+1555', bind: { type: 'personality', name: 'researcher' } }],
        trunk: {
          provider: 'livekit',
          trunkId: 'ST_1',
          fromNumber: '+15550000000',
          username: 'sipuser',
          password: 'sippass',
          webhookSecret: 'hook-secret',
          webhookPath: '/voice/inbound',
          codec: 'g711',
        },
        inbound: {
          allowlist: ['+1555123*', '+447700900000'],
          receptionist: 'receptionist',
          concurrencyCap: 3,
          perCallerPerHour: 5,
          dailyBudgetUsd: 12.5,
          prewarm: 'none',
          owner: { platform: 'slack', chatId: 'C123', botKey: 'bot-a' },
        },
        bargeIn: {
          call: { energyThreshold: 0.4, minSpeechMs: 220, silenceMs: 700 },
          satellite: { energyThreshold: 0.2, minSpeechMs: 120 },
        },
      },
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);

    const reloaded = await readConfig(storage, secrets);
    expect(reloaded?.voice).toEqual(original.voice);

    // A second write from what was read must produce byte-identical text — the
    // proof that the serializer and the parser agree on every one of these keys.
    const firstYaml = await storage.read(join(ethosDir(), 'config.yaml'));
    const onDisk = await readRawConfig(storage);
    if (!onDisk) throw new Error('expected a config');
    await writeConfig(storage, onDisk, secrets);
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toBe(firstYaml);
  });
});

describe('parseConfigYaml — V4 telephony validation', () => {
  it('rejects an invalid prewarm value', async () => {
    const errors = await parseErrors(['voice.inbound.prewarm: sometimes']);
    expect(errors.some((e) => e.includes('voice.inbound.prewarm'))).toBe(true);
    expect(errors.some((e) => e.includes('allowlisted, none, all'))).toBe(true);
  });

  it('rejects an unknown bargeIn surface', async () => {
    const errors = await parseErrors(['voice.bargeIn.kitchen.silenceMs: 500']);
    expect(errors.some((e) => e.includes('voice.bargeIn.kitchen'))).toBe(true);
    expect(errors.some((e) => e.includes('call, satellite'))).toBe(true);
  });

  // `browser` parsed for a release and reached nothing — the web talk lane
  // endpoints in the browser, off `display.voice_*`. Refusing it is the point:
  // a key that silently absorbs a threshold is how an operator spends an
  // afternoon tuning a control nothing reads. The refusal names the real knob.
  it('refuses voice.bargeIn.browser and points at display.voice_*', async () => {
    const errors = await parseErrors(['voice.bargeIn.browser.energyThreshold: 0.2']);
    expect(errors.some((e) => e.includes('voice.bargeIn.browser'))).toBe(true);
    expect(errors.some((e) => e.includes('display.voice_*'))).toBe(true);
  });

  it('drops the whole bargeIn block when a browser surface is present', async () => {
    const cfg = await load([
      'voice.bargeIn.call.silenceMs: 700',
      'voice.bargeIn.browser.energyThreshold: 0.2',
    ]);
    expect(cfg.voice?.bargeIn).toBeUndefined();
  });

  it('rejects a bargeIn energyThreshold outside (0, 1]', async () => {
    const errors = await parseErrors(['voice.bargeIn.call.energyThreshold: 0']);
    expect(errors.some((e) => e.includes('voice.bargeIn.call.energyThreshold'))).toBe(true);
  });

  it('rejects concurrencyCap: 0', async () => {
    const errors = await parseErrors(['voice.inbound.concurrencyCap: 0']);
    expect(errors.some((e) => e.includes('voice.inbound.concurrencyCap'))).toBe(true);
  });

  it('rejects a fractional perCallerPerHour', async () => {
    const errors = await parseErrors(['voice.inbound.perCallerPerHour: 1.5']);
    expect(errors.some((e) => e.includes('voice.inbound.perCallerPerHour'))).toBe(true);
  });

  it('rejects dailyBudgetUsd: -1', async () => {
    const errors = await parseErrors(['voice.inbound.dailyBudgetUsd: -1']);
    expect(errors.some((e) => e.includes('voice.inbound.dailyBudgetUsd'))).toBe(true);
  });

  it('rejects a webhookPath without a leading slash', async () => {
    const errors = await parseErrors([
      'voice.trunk.provider: twilio',
      'voice.trunk.trunkId: ST_1',
      'voice.trunk.webhookPath: voice/inbound',
    ]);
    expect(errors.some((e) => e.includes('voice.trunk.webhookPath'))).toBe(true);
  });

  it('rejects an invalid codec', async () => {
    const errors = await parseErrors([
      'voice.trunk.provider: twilio',
      'voice.trunk.trunkId: ST_1',
      'voice.trunk.codec: g729',
    ]);
    expect(errors.some((e) => e.includes('voice.trunk.codec'))).toBe(true);
    expect(errors.some((e) => e.includes('opus, g711'))).toBe(true);
  });

  it('rejects owner.platform without owner.chatId', async () => {
    const errors = await parseErrors(['voice.inbound.owner.platform: telegram']);
    expect(
      errors.some((e) => e.includes("voice.inbound.owner: missing required field 'chatId'")),
    ).toBe(true);
  });

  it('rejects owner.chatId without owner.platform', async () => {
    const errors = await parseErrors(['voice.inbound.owner.chatId: 4242']);
    expect(
      errors.some((e) => e.includes("voice.inbound.owner: missing required field 'platform'")),
    ).toBe(true);
  });

  it('drops the whole inbound block when any field is invalid', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [...BASE, 'voice.inbound.receptionist: r', 'voice.inbound.concurrencyCap: 0'].join('\n'),
    );
    const result = await loadConfigStrict(storage);
    expect(result?.config.voice?.inbound).toBeUndefined();
  });
});

describe('voice.trunk.webhookSecret — vault handling', () => {
  it('externalizes to a ref on write and resolves back on read', async () => {
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'researcher',
      voice: {
        bots: [],
        trunk: {
          provider: 'twilio',
          trunkId: 'ST_1',
          password: 'sippass',
          webhookSecret: 'hook-secret',
        },
      },
    };
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, original, secrets);

    const yaml = (await storage.read(join(ethosDir(), 'config.yaml'))) ?? '';
    expect(yaml).not.toContain('hook-secret');

    const onDisk = await readRawConfig(storage);
    expect(onDisk?.voice?.trunk?.webhookSecret).toBe(secretRef('voice/trunk/webhookSecret'));
    expect(await secrets.get('voice/trunk/webhookSecret')).toBe('hook-secret');

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.voice?.trunk).toEqual(original.voice?.trunk);
  });

  it('externalizes webhookSecret when no password is set', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        voice: {
          bots: [],
          trunk: { provider: 'twilio', trunkId: 'ST_1', webhookSecret: 'hook-secret' },
        },
      },
      secrets,
    );
    expect((await secrets.list()).filter((r) => r.startsWith('voice/'))).toEqual([
      'voice/trunk/webhookSecret',
    ]);
  });

  it('is idempotent — a rewrite neither re-wraps the ref nor mints a second one', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const secrets = new InMemorySecretsResolver();
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'researcher',
        voice: {
          bots: [],
          trunk: { provider: 'twilio', trunkId: 'ST_1', webhookSecret: 'hook-secret' },
        },
      },
      secrets,
    );
    const firstRefs = (await secrets.list()).sort();
    const onDisk = await readRawConfig(storage);
    if (!onDisk) throw new Error('expected a config');
    await writeConfig(storage, onDisk, secrets);

    expect((await secrets.list()).sort()).toEqual(firstRefs);
    expect(await storage.read(join(ethosDir(), 'config.yaml'))).toContain(
      secretRef('voice/trunk/webhookSecret'),
    );
  });

  it('refuses to load a plaintext webhookSecret', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        ...BASE,
        'voice.trunk.provider: twilio',
        'voice.trunk.trunkId: ST_1',
        'voice.trunk.webhookSecret: hook-secret',
      ].join('\n'),
    );
    const raw = await readRawConfig(storage);
    if (!raw) throw new Error('expected a config');
    expect(() => validateNoPlaintextSecrets(raw)).toThrow('webhookSecret');
  });
});
