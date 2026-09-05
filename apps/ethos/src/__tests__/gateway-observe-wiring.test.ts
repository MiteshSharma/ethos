// Observe mode, end to end from `config.yaml` to a real adapter
// (plan/phases/ambient-group-monitoring.md §2).
//
// The adapter side of observe mode has its own suites. What those cannot see
// is whether anything in production ever REACHES them: before this wiring the
// Telegram construction site passed no `storage`, no `defaultChannelMode` and
// no `logger`, so `defaultChannelMode: observe` in a config file produced a
// bot that answered every mention as usual and a privacy-mode warning that
// could never print. A test asserting "the config field parsed" would have
// passed throughout.
//
// So these cases drive the REAL `TelegramAdapter` and `SlackAdapter` (with
// only their platform SDKs mocked) out of a REAL `config.yaml`, through
// `loadConfigStrict` and `buildAdapters`, and assert on behaviour: what the
// adapter forwards, what it posts back to the chat, and what it logs.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethosDir, loadConfigStrict } from '@ethosagent/config';
import { FsStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// --- grammy (Telegram) ------------------------------------------------------

/** `getMe` results: BotFather Group Privacy on and off. */
const PRIVACY_ON = {
  id: 1,
  is_bot: true,
  first_name: 'Bot',
  username: 'sitewatcher',
  can_read_all_group_messages: false,
};
const PRIVACY_OFF = { ...PRIVACY_ON, can_read_all_group_messages: true };

const telegramApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  getMe: vi.fn().mockResolvedValue(PRIVACY_OFF),
};

/** Handlers the real adapter registers on the mock `Bot`, by event name. */
const telegramHandlers: Record<string, ((ctx: unknown) => void)[]> = {};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = telegramApi;
    on(event: string, handler: (ctx: unknown) => void) {
      if (!telegramHandlers[event]) telegramHandlers[event] = [];
      telegramHandlers[event].push(handler);
    }
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  }
  class MockInlineKeyboard {
    text() {
      return this;
    }
    row() {
      return this;
    }
  }
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard };
});

// --- @slack/bolt ------------------------------------------------------------

const slackAuthTest = vi.fn();

vi.mock('@slack/bolt', () => {
  class App {
    client = {
      auth: { test: slackAuthTest },
      chat: { postMessage: vi.fn(), update: vi.fn() },
    };
    async start() {}
    async stop() {}
    command() {}
    event() {}
    message() {}
    view() {}
    action() {}
    shortcut() {}
    error() {}
    use() {}
  }
  return { default: { App } };
});

const { buildAdapters } = await import('../commands/gateway');

/**
 * Loads the REAL adapter packages — the point of the exercise. By source path
 * rather than by package name: neither adapter is a dependency of this app
 * (they are loaded at runtime through `loadAdapterModule`, which is why
 * `buildAdapters` takes a loader at all) and neither is in the root vitest
 * alias map, so the bare specifier does not resolve from here.
 */
const realLoader = async <T>(modulePath: string): Promise<T | null> => {
  if (modulePath === '@ethosagent/platform-telegram') {
    return (await import('../../../../extensions/platform-telegram/src/index')) as T;
  }
  if (modulePath === '@ethosagent/platform-slack') {
    return (await import('../../../../extensions/platform-slack/src/index')) as T;
  }
  return null;
};

const BASE_YAML = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

let stateDir: string;
let priorStateDir: string | undefined;

/** Write a `config.yaml` into the scratch state dir and load it strictly. */
async function loadYaml(lines: string[]) {
  const storage = new FsStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE_YAML, ...lines].join('\n'));
  const loaded = await loadConfigStrict(storage);
  if (!loaded) throw new Error('config did not load');
  return loaded;
}

/** Build the adapters a given `config.yaml` produces, for real. */
async function adaptersFor(lines: string[]): Promise<{
  adapters: PlatformAdapter[];
  parseErrors: string[];
}> {
  const loaded = await loadYaml(lines);
  return {
    adapters: await buildAdapters(loaded.config, realLoader),
    parseErrors: loaded.parseErrors,
  };
}

const TELEGRAM_BOT = [
  'telegram.bots.0.id: sitewatcher',
  'telegram.bots.0.token: 1:fake-token',
  'telegram.bots.0.bind.type: personality',
  'telegram.bots.0.bind.name: researcher',
];

/**
 * Deliver an ordinary, unaddressed group message to the adapter the config
 * built, and report both what it forwarded and whether the chat saw anything.
 */
async function deliverGroupMessage(
  adapter: PlatformAdapter,
  text: string,
): Promise<InboundMessage[]> {
  const captured: InboundMessage[] = [];
  adapter.onMessage((m) => captured.push(m));
  await adapter.start();

  const handlers = telegramHandlers.message ?? [];
  if (handlers.length === 0) throw new Error('adapter registered no message handler');
  for (const h of handlers) {
    h({
      chat: { id: 100, type: 'supergroup' },
      from: { id: 200, username: 'sitemanager' },
      message: {
        text,
        caption: undefined,
        message_id: 7,
        date: 1_699_000_000,
        reply_to_message: null,
      },
      me: { username: 'sitewatcher' },
    });
  }
  return captured;
}

beforeAll(async () => {
  // `buildAdapters` opens the attachment cache, the personality registry and
  // (now) the Telegram override store against `ethosDir()`. None of that
  // belongs in the developer's real `~/.ethos`.
  priorStateDir = process.env.ETHOS_STATE_DIR;
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-observe-wiring-'));
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (priorStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = priorStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const key of Object.keys(telegramHandlers)) delete telegramHandlers[key];
  // `mockClear`, not `mockReset`: the adapter's best-effort startup calls
  // (`setMyName` and friends) `.catch()` what they return, so a reset that
  // drops the resolved value makes every `start()` throw on `undefined`.
  for (const fn of Object.values(telegramApi)) fn.mockClear();
  telegramApi.getMe.mockResolvedValue(PRIVACY_OFF);
  slackAuthTest.mockClear();
});

// ---------------------------------------------------------------------------
// The end-to-end case
// ---------------------------------------------------------------------------

describe('telegram.bots.<n>.defaultChannelMode: observe — config.yaml to behaviour', () => {
  it('produces an adapter that records an unaddressed group message and never answers it', async () => {
    telegramApi.getMe.mockResolvedValue(PRIVACY_OFF);
    const { adapters, parseErrors } = await adaptersFor([
      ...TELEGRAM_BOT,
      'telegram.bots.0.defaultChannelMode: observe',
    ]);
    expect(parseErrors).toEqual([]);
    expect(adapters).toHaveLength(1);

    const captured = await deliverGroupMessage(adapters[0], 'concrete pour slipped to thursday');

    // Recorded: an envelope reaches the gateway, stamped record-only, which is
    // what the gateway's observe gate routes to the transcript store.
    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(true);
    expect(captured[0].chatId).toBe('100');
    // Silent: nothing at all goes back to the watched chat.
    expect(telegramApi.setMessageReaction).not.toHaveBeenCalled();
    expect(telegramApi.sendMessage).not.toHaveBeenCalled();
  });

  it('does not answer even an explicit @mention in an observed chat', async () => {
    telegramApi.getMe.mockResolvedValue(PRIVACY_OFF);
    const { adapters } = await adaptersFor([
      ...TELEGRAM_BOT,
      'telegram.bots.0.defaultChannelMode: observe',
    ]);

    const captured = await deliverGroupMessage(adapters[0], '@sitewatcher are we on track?');

    expect(captured).toHaveLength(1);
    expect(captured[0].isGroupMention).toBe(true);
    expect(captured[0].recordOnly).toBe(true);
    expect(telegramApi.setMessageReaction).not.toHaveBeenCalled();
  });

  // The control: the same message, the same wiring, the default mode. Without
  // it the case above would also pass on an adapter that answers nothing.
  it('a bot with no defaultChannelMode still drops an unaddressed group message', async () => {
    const { adapters } = await adaptersFor(TELEGRAM_BOT);

    const captured = await deliverGroupMessage(adapters[0], 'concrete pour slipped to thursday');

    expect(captured).toHaveLength(0);
  });

  it('answers an @mention under mention_only, so observe is the mode doing the work', async () => {
    const { adapters } = await adaptersFor([
      ...TELEGRAM_BOT,
      'telegram.bots.0.defaultChannelMode: mention_only',
    ]);

    const captured = await deliverGroupMessage(adapters[0], '@sitewatcher are we on track?');

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
    expect(telegramApi.setMessageReaction).toHaveBeenCalledTimes(1);
  });

  it('answers everything under all, from config', async () => {
    const { adapters } = await adaptersFor([
      ...TELEGRAM_BOT,
      'telegram.bots.0.defaultChannelMode: all',
    ]);

    const captured = await deliverGroupMessage(adapters[0], 'concrete pour slipped to thursday');

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The store behind `/ethos channel-mode`
// ---------------------------------------------------------------------------

describe('telegram per-chat overrides', () => {
  it('advertises channelModes and persistence, which are false without a Storage', async () => {
    const { adapters } = await adaptersFor(TELEGRAM_BOT);

    // Both are literally `!!this.channelOverrides` on the adapter, and the
    // override store is only built when a `storage` arrives.
    expect(adapters[0].capabilities?.channelModes).toBe(true);
    expect(adapters[0].capabilities?.persistence).toBe(true);
  });

  // Proves the DIRECTORY as well as the Storage: the adapter's own fallback is
  // the relative `'telegram'`, and FsStorage takes absolute paths, so an
  // unqualified default would look for this file under the process CWD and
  // find nothing.
  it('reads a stored per-chat override from <ethosDir>/telegram/<botKey>/', async () => {
    const storage = new FsStorage();
    const dir = join(ethosDir(), 'telegram', 'sitewatcher');
    await storage.mkdir(dir);
    await storage.write(
      join(dir, 'channel-overrides.jsonl'),
      `${JSON.stringify({ channel: '100', mode: 'observe', updatedAt: 1 })}\n`,
    );

    // Default mode answers mentions; the override for chat 100 says observe.
    const { adapters } = await adaptersFor([
      ...TELEGRAM_BOT,
      'telegram.bots.0.defaultChannelMode: mention_only',
    ]);
    const captured = await deliverGroupMessage(adapters[0], '@sitewatcher are we on track?');

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(true);
    expect(telegramApi.setMessageReaction).not.toHaveBeenCalled();

    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// The warning that only exists if a logger arrives
// ---------------------------------------------------------------------------

describe('telegram observe-mode privacy warning', () => {
  it('fires through the wired logger when privacy mode hides the observed chats', async () => {
    telegramApi.getMe.mockResolvedValue(PRIVACY_ON);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { adapters } = await adaptersFor([
        ...TELEGRAM_BOT,
        'telegram.bots.0.defaultChannelMode: observe',
      ]);
      await adapters[0].start();

      expect(telegramApi.getMe).toHaveBeenCalled();
      const printed = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).toContain('@sitewatcher');
      expect(printed).toContain('/setprivacy');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when the same bot has privacy mode off', async () => {
    telegramApi.getMe.mockResolvedValue(PRIVACY_OFF);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { adapters } = await adaptersFor([
        ...TELEGRAM_BOT,
        'telegram.bots.0.defaultChannelMode: observe',
      ]);
      await adapters[0].start();

      const printed = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).not.toContain('/setprivacy');
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Slack's own startup diagnostic, dead until a logger was passed
// ---------------------------------------------------------------------------

describe('slack startup diagnostics', () => {
  const SLACK_APP = [
    'slack.apps.0.id: prod-slack',
    'slack.apps.0.botToken: xoxb-1',
    'slack.apps.0.appToken: xapp-1',
    'slack.apps.0.signingSecret: s1',
    'slack.apps.0.bind.type: personality',
    'slack.apps.0.bind.name: researcher',
  ];

  it('prints "authenticated as" on start, through the wired logger', async () => {
    slackAuthTest.mockResolvedValue({ user_id: 'UBOT', user: 'ethos' });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { adapters } = await adaptersFor(SLACK_APP);
      expect(adapters).toHaveLength(1);
      await adapters[0].start();

      const printed = info.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).toContain('Slack bot authenticated as @ethos');
    } finally {
      info.mockRestore();
    }
  });

  it('accepts observe as a configured Slack default channel mode', async () => {
    slackAuthTest.mockResolvedValue({ user_id: 'UBOT', user: 'ethos' });
    const { adapters, parseErrors } = await adaptersFor([
      ...SLACK_APP,
      'slack.apps.0.defaultChannelMode: observe',
    ]);

    expect(parseErrors).toEqual([]);
    expect(adapters).toHaveLength(1);
    // `SlackAdapter.defaultChannelMode` is the resolved mode every channel
    // without an override falls back to.
    const adapter = adapters[0] as PlatformAdapter & { defaultChannelMode?: string };
    expect(adapter.defaultChannelMode).toBe('observe');
  });
});
