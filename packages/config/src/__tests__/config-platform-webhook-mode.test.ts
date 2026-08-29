// Telegram webhook mode + Slack HTTP Events mode — the config half
// (plan/phases/telegram-slack-webhook-mode.md §2a, §3b, §6, §8).
//
// The load-bearing property pinned here is that the whole block is ADDITIVE:
// a config that names none of the new keys must parse to exactly what it
// parsed to before they existed — `useWebhook` absent (long-poll),
// `dropPendingUpdates` absent (so the adapter's `?? true` applies), `mode`
// absent (Socket Mode). Every other test here is about a key that an operator
// actually wrote.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  deriveBotKey,
  type EthosConfig,
  ethosDir,
  loadConfigStrict,
  readConfig,
  readRawConfig,
  writeConfig,
} from '../index';

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

const base = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];

const telegramBot = [
  'telegram.bots.0.token: 123:ABC',
  'telegram.bots.0.bind.type: personality',
  'telegram.bots.0.bind.name: researcher',
];

const slackApp = [
  'slack.apps.0.botToken: xoxb-1',
  'slack.apps.0.appToken: xapp-1',
  'slack.apps.0.signingSecret: s1',
  'slack.apps.0.bind.type: personality',
  'slack.apps.0.bind.name: researcher',
];

describe('default-preserving: none of the new keys present', () => {
  it('parses a Telegram bot to exactly the pre-change shape', async () => {
    const cfg = await load([...base, ...telegramBot].join('\n'));
    // Deep equality, not field-by-field: this is the regression guard that the
    // change added no key by default.
    expect(cfg.telegram?.bots[0]).toEqual({
      token: '123:ABC',
      bind: { type: 'personality', name: 'researcher' },
    });
    expect(cfg.telegram?.bots[0].useWebhook).toBeUndefined();
    expect(cfg.telegram?.bots[0].dropPendingUpdates).toBeUndefined();
  });

  it('parses a Slack app to exactly the pre-change shape', async () => {
    const cfg = await load([...base, ...slackApp].join('\n'));
    expect(cfg.slack?.apps[0]).toEqual({
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      signingSecret: 's1',
      bind: { type: 'personality', name: 'researcher' },
    });
    expect(cfg.slack?.apps[0].mode).toBeUndefined();
    expect(cfg.slack?.apps[0].webhookPath).toBeUndefined();
  });
});

describe('TelegramBotConfig webhook keys', () => {
  it('parses useWebhook + webhookUrl + webhookSecretToken', async () => {
    const cfg = await load(
      [
        ...base,
        ...telegramBot,
        'telegram.bots.0.useWebhook: true',
        // The URL includes the /telegram/webhook/<botKey> segment (§7, §8) —
        // it must survive the ':' in 'https://' intact.
        'telegram.bots.0.webhookUrl: https://bots.example.com/telegram/webhook/researcher-bot',
        'telegram.bots.0.webhookSecretToken: shhh',
      ].join('\n'),
    );
    const bot = cfg.telegram?.bots[0];
    expect(bot?.useWebhook).toBe(true);
    expect(bot?.webhookUrl).toBe('https://bots.example.com/telegram/webhook/researcher-bot');
    expect(bot?.webhookSecretToken).toBe('shhh');
  });

  it('parses useWebhook: false as boolean false', async () => {
    const cfg = await load(
      [...base, ...telegramBot, 'telegram.bots.0.useWebhook: false'].join('\n'),
    );
    expect(cfg.telegram?.bots[0].useWebhook).toBe(false);
  });

  it('parses dropPendingUpdates: false as boolean false, distinct from absent', async () => {
    // The sleep/wake case (§6): an explicit `false` keeps the backlog Telegram
    // queued while the process was paused. It must not collapse into the
    // "absent → adapter default true" branch.
    const cfg = await load(
      [...base, ...telegramBot, 'telegram.bots.0.dropPendingUpdates: false'].join('\n'),
    );
    expect(cfg.telegram?.bots[0].dropPendingUpdates).toBe(false);
    expect('dropPendingUpdates' in (cfg.telegram?.bots[0] ?? {})).toBe(true);
  });

  it('parses dropPendingUpdates: true as boolean true', async () => {
    const cfg = await load(
      [...base, ...telegramBot, 'telegram.bots.0.dropPendingUpdates: true'].join('\n'),
    );
    expect(cfg.telegram?.bots[0].dropPendingUpdates).toBe(true);
  });
});

describe('SlackAppConfig mode / webhookPath', () => {
  it('parses mode.socket and mode.http as booleans', async () => {
    const cfg = await load(
      [
        ...base,
        ...slackApp,
        'slack.apps.0.mode.socket: false',
        'slack.apps.0.mode.http: true',
        'slack.apps.0.webhookPath: research-app',
      ].join('\n'),
    );
    expect(cfg.slack?.apps[0].mode).toEqual({ socket: false, http: true });
    expect(cfg.slack?.apps[0].webhookPath).toBe('research-app');
  });

  it('keeps a partial mode block partial', async () => {
    const cfg = await load([...base, ...slackApp, 'slack.apps.0.mode.http: true'].join('\n'));
    expect(cfg.slack?.apps[0].mode).toEqual({ http: true });
  });

  it('parses an app with no appToken and reports no error', async () => {
    // appToken is required only in Socket Mode, and the adapter enforces that —
    // the config layer must not reject an HTTP-mode app for lacking one (§8).
    const result = await loadStrict(
      [
        ...base,
        'slack.apps.0.botToken: xoxb-1',
        'slack.apps.0.signingSecret: s1',
        'slack.apps.0.bind.type: personality',
        'slack.apps.0.bind.name: researcher',
        'slack.apps.0.mode.socket: false',
        'slack.apps.0.mode.http: true',
      ].join('\n'),
    );
    expect(result?.parseErrors ?? []).toEqual([]);
    expect(result?.config.slack?.apps).toHaveLength(1);
    expect(result?.config.slack?.apps[0].appToken).toBeUndefined();
    expect(result?.config.slack?.apps[0].mode).toEqual({ socket: false, http: true });
  });

  it('still reports a missing botToken / signingSecret', async () => {
    const result = await loadStrict(
      [
        ...base,
        'slack.apps.0.appToken: xapp-1',
        'slack.apps.0.bind.type: personality',
        'slack.apps.0.bind.name: researcher',
      ].join('\n'),
    );
    expect(
      result?.parseErrors.some((e) =>
        e.includes('missing required field(s) botToken, signingSecret'),
      ),
    ).toBe(true);
  });
});

describe('webhookSecretToken is treated as a credential', () => {
  it('resolves from a secret reference the same way token does', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('telegram/bots/researcher-bot/token', 'REAL-token');
    await secrets.set('telegram/bots/researcher-bot/webhookSecretToken', 'REAL-secret');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        ...base,
        'telegram.bots.0.id: researcher-bot',
        `telegram.bots.0.token: ${secretRef('telegram/bots/researcher-bot/token')}`,
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: researcher',
        'telegram.bots.0.useWebhook: true',
        'telegram.bots.0.webhookUrl: https://x.example.com/telegram/webhook/researcher-bot',
        `telegram.bots.0.webhookSecretToken: ${secretRef('telegram/bots/researcher-bot/webhookSecretToken')}`,
      ].join('\n'),
    );
    const cfg = await readConfig(storage, secrets);
    expect(cfg?.telegram?.bots[0].token).toBe('REAL-token');
    expect(cfg?.telegram?.bots[0].webhookSecretToken).toBe('REAL-secret');
  });

  it('is externalized by writeConfig under a botKey-keyed ref, never written in cleartext', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'p',
        telegram: {
          bots: [
            {
              token: 'PLAIN-token',
              bind: { type: 'personality', name: 'researcher' },
              useWebhook: true,
              webhookUrl: 'https://x.example.com/telegram/webhook/b',
              webhookSecretToken: 'PLAIN-webhook-secret',
            },
          ],
        },
      },
      secrets,
    );

    const botKey = deriveBotKey({ token: 'PLAIN-token' });
    expect((await secrets.list()).sort()).toContain(`telegram/bots/${botKey}/webhookSecretToken`);
    expect(await secrets.get(`telegram/bots/${botKey}/webhookSecretToken`)).toBe(
      'PLAIN-webhook-secret',
    );

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).not.toContain('PLAIN-webhook-secret');
    expect(raw).toContain(secretRef(`telegram/bots/${botKey}/webhookSecretToken`));
  });
});

describe('writeConfig round-trip', () => {
  it('round-trips every new Telegram and Slack key', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'm',
        apiKey: 'sk',
        personality: 'p',
        telegram: {
          bots: [
            {
              id: 'poller',
              token: 'tok-poll',
              bind: { type: 'personality', name: 'researcher' },
              dropPendingUpdates: false,
            },
            {
              id: 'hooked',
              token: 'tok-hook',
              bind: { type: 'team', name: 'eng' },
              useWebhook: true,
              webhookUrl: 'https://x.example.com/telegram/webhook/hooked',
              webhookSecretToken: 'wh-secret',
            },
          ],
        },
        slack: {
          apps: [
            {
              id: 'http-app',
              botToken: 'xoxb-1',
              signingSecret: 's1',
              bind: { type: 'personality', name: 'researcher' },
              mode: { socket: false, http: true },
              webhookPath: 'http-app',
            },
          ],
        },
      },
      secrets,
    );

    const cfg = await readConfig(storage, secrets);
    expect(cfg?.telegram?.bots[0]).toMatchObject({
      id: 'poller',
      token: 'tok-poll',
      dropPendingUpdates: false,
    });
    expect(cfg?.telegram?.bots[0].useWebhook).toBeUndefined();
    expect(cfg?.telegram?.bots[1]).toMatchObject({
      id: 'hooked',
      token: 'tok-hook',
      useWebhook: true,
      webhookUrl: 'https://x.example.com/telegram/webhook/hooked',
      webhookSecretToken: 'wh-secret',
    });
    expect(cfg?.slack?.apps[0]).toMatchObject({
      id: 'http-app',
      botToken: 'xoxb-1',
      signingSecret: 's1',
      mode: { socket: false, http: true },
      webhookPath: 'http-app',
    });
    expect(cfg?.slack?.apps[0].appToken).toBeUndefined();
  });
});
