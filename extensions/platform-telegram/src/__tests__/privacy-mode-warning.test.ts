// The observe-mode prerequisite check.
//
// A Telegram bot with BotFather's Group Privacy ON receives only the group
// messages that mention or reply to it, so an `observe` chat under that
// setting records nothing and says nothing. `getMe` reports the setting as
// `can_read_all_group_messages`, so the warning is driven by the bot's real
// configuration — these cases pin that it fires on a bot that cannot hear its
// observed rooms and stays quiet on one that can.

import { InMemoryAttachmentCache, InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, LogMeta, Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  getMe: vi.fn(),
};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on() {}
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

import type { ChannelMode } from '../config';
import { TelegramAdapter } from '../index';

const BOT_KEY = 'test-bot';
const OVERRIDES_FILE = `telegram/${BOT_KEY}/channel-overrides.jsonl`;

/** Collects everything written at `warn`, through one `child()` hop. */
function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const make = (): Logger => ({
    debug(_m: string, _meta?: LogMeta) {},
    info(_m: string, _meta?: LogMeta) {},
    warn(message: string, _meta?: LogMeta) {
      warnings.push(message);
    },
    error(_m: string, _meta?: LogMeta) {},
    child(_meta: LogMeta) {
      return make();
    },
  });
  return { logger: make(), warnings };
}

interface StartOptions {
  /** The bot's global default mode. */
  mode: ChannelMode;
  /**
   * Stored per-chat override for chat 100, written to the override store.
   *
   * `string`, not `ChannelMode`, because the unreadable-override cases below
   * need to plant exactly what `ChannelModeSchema` rejects — which is the only
   * way that state reaches production too (a hand edit, or a newer binary
   * writing into the same file).
   */
  overrideMode?: ChannelMode | (string & {});
  /** `getMe` result. `undefined` makes the call reject instead. */
  getMe?: Record<string, unknown>;
  /** Omit the logger entirely, as an unwired deployment would. */
  noLogger?: boolean;
}

async function start(opts: StartOptions): Promise<string[]> {
  for (const fn of Object.values(mockApi)) fn.mockClear();
  mockApi.getMe.mockImplementation(() =>
    opts.getMe ? Promise.resolve(opts.getMe) : Promise.reject(new Error('401: Unauthorized')),
  );

  let storage: Storage | undefined;
  if (opts.overrideMode !== undefined) {
    storage = new InMemoryStorage();
    const record = { channel: '100', mode: opts.overrideMode, updatedAt: 1 };
    await storage.mkdir(`telegram/${BOT_KEY}`);
    await storage.write(OVERRIDES_FILE, `${JSON.stringify(record)}\n`);
  }

  const { logger, warnings } = recordingLogger();
  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    cache: new InMemoryAttachmentCache(),
    botKey: BOT_KEY,
    defaultChannelMode: opts.mode,
    ...(storage ? { storage } : {}),
    ...(opts.noLogger ? {} : { logger }),
  });
  await adapter.start();
  return warnings;
}

const PRIVACY_ON = {
  id: 1,
  is_bot: true,
  first_name: 'Bot',
  username: 'sitewatcher',
  can_read_all_group_messages: false,
};
const PRIVACY_OFF = { ...PRIVACY_ON, can_read_all_group_messages: true };

describe('observe-mode privacy warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns when the default mode is observe and privacy mode is on', async () => {
    const warnings = await start({ mode: 'observe', getMe: PRIVACY_ON });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('@sitewatcher');
    expect(warnings[0]).toContain('/setprivacy');
  });

  it('warns when only a per-chat override sets observe', async () => {
    const warnings = await start({
      mode: 'mention_only',
      overrideMode: 'observe',
      getMe: PRIVACY_ON,
    });
    expect(warnings).toHaveLength(1);
  });

  it('stays quiet on an observe bot that has privacy mode off', async () => {
    const warnings = await start({ mode: 'observe', getMe: PRIVACY_OFF });
    expect(warnings).toEqual([]);
  });

  it('stays quiet when no chat is in observe mode, privacy mode notwithstanding', async () => {
    const warnings = await start({ mode: 'mention_only', getMe: PRIVACY_ON });
    expect(warnings).toEqual([]);
    // The bot's own setting is nobody's problem until a chat is observed, so
    // the check should not have spent an API call asking.
    expect(mockApi.getMe).not.toHaveBeenCalled();
  });

  it('still warns when one chat is overridden away from an observe default', async () => {
    // An override covers one chat. Every other group the bot sits in still
    // falls back to the default, so the bot is still watching rooms it cannot
    // hear and the warning is still the truth.
    const warnings = await start({ mode: 'observe', overrideMode: 'all', getMe: PRIVACY_ON });
    expect(warnings).toHaveLength(1);
  });

  it('does not cry wolf when getMe omits can_read_all_group_messages', async () => {
    const warnings = await start({
      mode: 'observe',
      getMe: { id: 1, is_bot: true, first_name: 'Bot', username: 'sitewatcher' },
    });
    expect(warnings).toEqual([]);
  });

  it('starts normally when getMe fails', async () => {
    const warnings = await start({ mode: 'observe' });
    expect(warnings).toEqual([]);
    expect(mockApi.setMyCommands).toHaveBeenCalled();
  });

  it('skips the getMe call entirely when no logger is installed', async () => {
    await start({ mode: 'observe', getMe: PRIVACY_ON, noLogger: true });
    expect(mockApi.getMe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The other silent state: a stored mode this build cannot read
// ---------------------------------------------------------------------------

// A chat whose stored mode is outside `CHANNEL_MODES` is neither replied to nor
// recorded — `evaluateChannelMode` (`@ethosagent/core`) fails closed on it. From
// outside, that is indistinguishable from a bot that was never added to the
// group, and the privacy warning above cannot report it: its `observe` test is a
// string LITERAL, so an unreadable mode does not match it. Telegram has no
// `/ethos channel-mode show` to read the value back from the way Slack does, so
// this log line is the whole diagnostic surface. Enforced by
// `warnIfOverridesUnreadable` in `../index.ts`.
describe('unreadable-override warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns, naming the chat and the stored string verbatim', async () => {
    const warnings = await start({ mode: 'mention_only', overrideMode: 'obserev' });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"obserev"');
    expect(warnings[0]).toContain('100');
  });

  it('warns for a mode that is real on another adapter', async () => {
    // `regex_match` is Telegram's own, so the mirror case is Slack's — but a
    // mode a NEWER Telegram build knows and this one does not is the same
    // shape, and is the case that actually reaches a downgraded binary.
    const warnings = await start({ mode: 'mention_only', overrideMode: 'silent_digest_only' });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"silent_digest_only"');
  });

  it('stays quiet when every stored override is readable', async () => {
    // The control: without it the cases above would pass against a warning that
    // fires on every startup.
    const warnings = await start({ mode: 'mention_only', overrideMode: 'regex_match' });

    expect(warnings).toEqual([]);
  });

  it('stays quiet when no override is stored at all', async () => {
    expect(await start({ mode: 'mention_only' })).toEqual([]);
  });

  it('says nothing without a logger', async () => {
    expect(await start({ mode: 'mention_only', overrideMode: 'obserev', noLogger: true })).toEqual(
      [],
    );
  });

  it('is independent of the privacy warning — both can fire', async () => {
    // Different diagnostics about different chats: chat 100 is unreadable, and
    // every OTHER group still falls back to the observed default the bot cannot
    // hear. Collapsing them into one check would lose whichever fired second.
    const warnings = await start({
      mode: 'observe',
      overrideMode: 'obserev',
      getMe: PRIVACY_ON,
    });

    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('/setprivacy'))).toBe(true);
    expect(warnings.some((w) => w.includes('"obserev"'))).toBe(true);
  });
});
