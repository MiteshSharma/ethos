// `defaultChannelMode` in config.yaml, per platform
// (plan/phases/ambient-group-monitoring.md §2).
//
// Two things are being pinned here, and the second is the reason this is not
// one shared table. Each platform accepts exactly the mode set its OWN adapter
// enum honours — Telegram five, Slack four — so a config file can never name a
// mode the adapter would silently ignore, and `regex_match` cannot leak onto
// Slack (whose `ChannelModeSchema` has no such value) nor quietly disappear
// from Telegram.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  observeModePlatforms,
  readRawConfig,
  writeConfig,
} from '../index';

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];

const TELEGRAM_BOT = [
  'telegram.bots.0.id: watcher',
  'telegram.bots.0.token: 1:tok',
  'telegram.bots.0.bind.type: personality',
  'telegram.bots.0.bind.name: p',
];

const SLACK_APP = [
  'slack.apps.0.id: prod',
  'slack.apps.0.botToken: xoxb',
  'slack.apps.0.appToken: xapp',
  'slack.apps.0.signingSecret: sig',
  'slack.apps.0.bind.type: personality',
  'slack.apps.0.bind.name: p',
];

async function storageWith(lines: string[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  return storage;
}

/** Each adapter's own `ChannelModeSchema`, restated so a drift is a failure. */
const TELEGRAM_MODES = ['mention_only', 'thread_follow', 'all', 'regex_match', 'observe'];
const SLACK_MODES = ['mention_only', 'thread_follow', 'all', 'observe'];

describe('telegram.bots.<n>.defaultChannelMode', () => {
  for (const mode of TELEGRAM_MODES) {
    it(`accepts '${mode}'`, async () => {
      const storage = await storageWith([
        ...TELEGRAM_BOT,
        `telegram.bots.0.defaultChannelMode: ${mode}`,
      ]);
      const loaded = await loadConfigStrict(storage);
      expect(loaded?.parseErrors).toEqual([]);
      expect(loaded?.config.telegram?.bots[0]?.defaultChannelMode).toBe(mode);
    });
  }

  it('is absent when the operator sets nothing, leaving the adapter default in charge', async () => {
    const storage = await storageWith(TELEGRAM_BOT);
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.config.telegram?.bots[0]).not.toHaveProperty('defaultChannelMode');
  });

  it('rejects an unknown mode, naming all five it does accept', async () => {
    const storage = await storageWith([
      ...TELEGRAM_BOT,
      'telegram.bots.0.defaultChannelMode: lurk',
    ]);
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toContain(
      "telegram.bots[0]: invalid defaultChannelMode 'lurk' (expected 'mention_only', " +
        "'thread_follow', 'all', 'regex_match' or 'observe').",
    );
    // A bot whose mode does not parse is not booted on a guessed default.
    expect(loaded?.config.telegram?.bots ?? []).toHaveLength(0);
  });

  it('round-trips observe through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'p',
      telegram: {
        bots: [
          {
            id: 'watcher',
            token: '1:tok',
            bind: { type: 'personality', name: 'p' },
            defaultChannelMode: 'observe',
          },
        ],
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('telegram.bots.0.defaultChannelMode: observe');
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.telegram?.bots[0]?.defaultChannelMode).toBe('observe');
  });
});

describe('slack.apps.<n>.defaultChannelMode', () => {
  for (const mode of SLACK_MODES) {
    it(`accepts '${mode}'`, async () => {
      const storage = await storageWith([...SLACK_APP, `slack.apps.0.defaultChannelMode: ${mode}`]);
      const loaded = await loadConfigStrict(storage);
      expect(loaded?.parseErrors).toEqual([]);
      expect(loaded?.config.slack?.apps[0]?.defaultChannelMode).toBe(mode);
    });
  }

  // The asymmetry, stated as a test rather than left to the union type: the
  // Slack adapter has no `regex_match`, so accepting it here would configure a
  // mode nothing honours.
  it("rejects 'regex_match', which the Slack adapter has no case for", async () => {
    const storage = await storageWith([
      ...SLACK_APP,
      'slack.apps.0.defaultChannelMode: regex_match',
    ]);
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toContain(
      "slack.apps[0]: invalid defaultChannelMode 'regex_match' (expected 'mention_only', " +
        "'thread_follow', 'all' or 'observe').",
    );
    expect(loaded?.config.slack?.apps ?? []).toHaveLength(0);
  });

  it('rejects an unknown mode, naming all four it does accept', async () => {
    const storage = await storageWith([...SLACK_APP, 'slack.apps.0.defaultChannelMode: lurk']);
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toContain(
      "slack.apps[0]: invalid defaultChannelMode 'lurk' (expected 'mention_only', " +
        "'thread_follow', 'all' or 'observe').",
    );
  });

  it('round-trips observe through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'p',
      slack: {
        apps: [
          {
            id: 'prod',
            botToken: 'xoxb',
            appToken: 'xapp',
            signingSecret: 'sig',
            bind: { type: 'personality', name: 'p' },
            defaultChannelMode: 'observe',
          },
        ],
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('slack.apps.0.defaultChannelMode: observe');
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.slack?.apps[0]?.defaultChannelMode).toBe('observe');
  });
});

// The boot-time "observe configured but nothing records it" check reads this.
// Until Telegram and Slack could express observe at all, it could only ever
// name whatsapp.
describe('observeModePlatforms sees the two platforms that just gained the key', () => {
  async function load(lines: string[]): Promise<EthosConfig> {
    const loaded = await loadConfigStrict(await storageWith(lines));
    if (!loaded) throw new Error('config did not load');
    return loaded.config;
  }

  it('names telegram when a bot defaults to observe', async () => {
    expect(
      observeModePlatforms(
        await load([...TELEGRAM_BOT, 'telegram.bots.0.defaultChannelMode: observe']),
      ),
    ).toEqual(['telegram']);
  });

  it('names slack when an app defaults to observe', async () => {
    expect(
      observeModePlatforms(await load([...SLACK_APP, 'slack.apps.0.defaultChannelMode: observe'])),
    ).toEqual(['slack']);
  });

  it('names every observing platform together', async () => {
    const platforms = observeModePlatforms(
      await load([
        ...TELEGRAM_BOT,
        'telegram.bots.0.defaultChannelMode: observe',
        ...SLACK_APP,
        'slack.apps.0.defaultChannelMode: observe',
        'whatsapp.0.id: wa',
        'whatsapp.0.default_mode: observe',
      ]),
    );
    expect([...platforms].sort()).toEqual(['slack', 'telegram', 'whatsapp']);
  });

  it('stays empty for bots on a replying mode', async () => {
    expect(
      observeModePlatforms(
        await load([
          ...TELEGRAM_BOT,
          'telegram.bots.0.defaultChannelMode: regex_match',
          ...SLACK_APP,
          'slack.apps.0.defaultChannelMode: thread_follow',
        ]),
      ),
    ).toEqual([]);
  });
});
