import { join } from 'node:path';
import { readRawConfig } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository, parseWakeRouting } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

// Settings → Voice, wake routes: the phrase → personality table has to survive a
// full round trip through the same service the Settings page calls, land in the
// spelling `@ethosagent/config`'s own loader reads back, and TELL the satellite
// lane that it changed (eng-review D5 — a Settings save is the push trigger).

const DATA = '/data';
const BASE = [
  'provider: anthropic',
  'model: claude-opus-4-7',
  'apiKey: sk-anthropic-1234567890abcdef',
  'personality: researcher',
];

describe('Settings → Voice wake routes', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let service: ConfigService;
  let pushes: number;
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
    pushes = 0;
    await storage.mkdir(DATA);
    const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    service = new ConfigService({
      config: repo,
      secrets,
      onUpdated: () => {
        pushes += 1;
      },
    });
    await storage.write(join(DATA, 'config.yaml'), BASE.join('\n'));
  });

  async function yaml(): Promise<string> {
    return (await storage.read(join(DATA, 'config.yaml'))) ?? '';
  }

  async function passthrough(): Promise<Record<string, string>> {
    const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    return (await repo.read())?.passthrough ?? {};
  }

  it('round-trips a route through write, read, and the CLI loader', async () => {
    await service.update({
      wakeRoutes: {
        eng: { phrase: 'hey engineer', personality: 'engineer', privileged: true, enabled: true },
      },
    });

    expect(await yaml()).toContain('voice.wake.routes.eng.personality: engineer');
    const loaded = await readRawConfig(storage);
    expect(loaded?.voice?.wake?.routes?.eng).toMatchObject({
      phrase: 'hey engineer',
      personality: 'engineer',
      privileged: true,
    });
    expect(parseWakeRouting(await passthrough()).routes).toEqual([
      {
        id: 'eng',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: true,
        enabled: true,
        // Read from the file, so never one of the synthesized `hey <name>`
        // defaults — see `withImplicitWakeRoutes`.
        implicit: false,
      },
    ]);
  });

  it('replaces the table wholesale so a deleted route stops answering', async () => {
    await service.update({
      wakeRoutes: {
        eng: { phrase: 'hey engineer', personality: 'engineer' },
        res: { phrase: 'hey researcher', personality: 'researcher' },
      },
    });
    await service.update({
      wakeRoutes: { res: { phrase: 'hey researcher', personality: 'researcher' } },
    });

    const routes = parseWakeRouting(await passthrough()).routes;
    expect(routes.map((r) => r.id)).toEqual(['res']);
    expect(await yaml()).not.toContain('voice.wake.routes.eng');
  });

  it('notifies the push seam on every completed write', async () => {
    await service.update({ wakeRoutes: {} });
    await service.update({ verbose: true });
    expect(pushes).toBe(2);
  });

  it('a listener that throws does not fail the write that already landed', async () => {
    const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    const brittle = new ConfigService({
      config: repo,
      secrets,
      onUpdated: () => {
        throw new Error('satellite push exploded');
      },
    });
    await expect(
      brittle.update({ wakeRoutes: { r: { phrase: 'hey', personality: 'researcher' } } }),
    ).resolves.toBeUndefined();
    expect(await yaml()).toContain('voice.wake.routes.r.phrase: hey');
  });

  it('refuses a route id the config parser could not match', async () => {
    await expect(
      service.update({ wakeRoutes: { 'bad id': { phrase: 'hey', personality: 'researcher' } } }),
    ).rejects.toThrow(/identifier/);
  });

  it('refuses a route with no phrase', async () => {
    await expect(
      service.update({ wakeRoutes: { eng: { phrase: '  ', personality: 'engineer' } } }),
    ).rejects.toThrow(/phrase/);
  });
});

describe('parseWakeRouting', () => {
  it('applies defaults when the deployment wrote no wake scalars', () => {
    expect(parseWakeRouting({}).settings).toEqual({
      engine: 'fallback',
      sensitivity: 0.5,
      confirmationFrames: 2,
      edgeStt: false,
      idleTimeoutMs: 30_000,
      // Absence of the master switch means "never disabled", not "disabled".
      wakeEnabled: true,
    });
  });

  it('reads the scalars and converts the idle timeout to milliseconds', () => {
    expect(
      parseWakeRouting({
        'voice.wake.engine': 'sherpa',
        'voice.wake.sensitivity': '0.8',
        'voice.wake.confirmationFrames': '4',
        'voice.wake.edgeStt': 'true',
        'voice.wake.idleTimeout': '45',
        'voice.wake.enabled': 'false',
      }).settings,
    ).toEqual({
      engine: 'sherpa',
      sensitivity: 0.8,
      confirmationFrames: 4,
      edgeStt: true,
      idleTimeoutMs: 45_000,
      wakeEnabled: false,
    });
  });

  it('ignores out-of-range and unknown values rather than clamping them', () => {
    const settings = parseWakeRouting({
      'voice.wake.engine': 'whisper-wake',
      'voice.wake.sensitivity': '9',
      'voice.wake.confirmationFrames': '0',
      'voice.wake.idleTimeout': '1',
    }).settings;
    // Every one of these falls back to the default — a clamped near-miss would
    // silently run the house at a threshold nobody chose.
    expect(settings).toMatchObject({
      engine: 'fallback',
      sensitivity: 0.5,
      confirmationFrames: 2,
      idleTimeoutMs: 30_000,
    });
  });

  it('drops a route missing phrase or personality', () => {
    const routes = parseWakeRouting({
      'voice.wake.routes.a.phrase': 'hey a',
      'voice.wake.routes.b.personality': 'researcher',
      'voice.wake.routes.c.phrase': 'hey c',
      'voice.wake.routes.c.personality': 'researcher',
    }).routes;
    expect(routes.map((r) => r.id)).toEqual(['c']);
  });

  it('resolves the two tri-state flags — absent privileged is NOT privileged', () => {
    const routes = parseWakeRouting({
      'voice.wake.routes.a.phrase': 'hey a',
      'voice.wake.routes.a.personality': 'researcher',
      'voice.wake.routes.b.phrase': 'hey b',
      'voice.wake.routes.b.personality': 'researcher',
      'voice.wake.routes.b.privileged': 'true',
      'voice.wake.routes.b.enabled': 'false',
    }).routes;
    expect(routes).toEqual([
      {
        id: 'a',
        phrase: 'hey a',
        personalityId: 'researcher',
        privileged: false,
        enabled: true,
        implicit: false,
      },
      {
        id: 'b',
        phrase: 'hey b',
        personalityId: 'researcher',
        privileged: true,
        enabled: false,
        implicit: false,
      },
    ]);
  });

  it('reads per-node overrides', () => {
    expect(
      parseWakeRouting({
        'voice.wake.nodes.kitchen.inputDevice': 'hw:1,0',
        'voice.wake.nodes.kitchen.enabled': 'false',
      }).nodes,
    ).toEqual({ kitchen: { inputDevice: 'hw:1,0', enabled: false } });
  });
});
