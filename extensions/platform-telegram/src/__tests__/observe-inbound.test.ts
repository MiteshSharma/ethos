// Telegram's inbound path under every channel mode, driven through the real
// `bot.on('message')` handler with a mocked grammy client.
//
// `evaluateChannelMode` (`@ethosagent/core`) has its own table-driven suite;
// this proves what the ADAPTER does with the answer — that the envelope leaves
// the handler stamped, that `sentAt` is Telegram's own send time rather than a
// clock reading, and that nothing on the way out breaks the one promise
// observe mode makes: the chat never sees the bot.

import { InMemoryAttachmentCache, InMemoryStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  getMe: vi.fn().mockResolvedValue({ id: 1, is_bot: true, first_name: 'Bot', username: 'testbot' }),
  getFile: vi.fn().mockResolvedValue({ file_path: 'photos/f1.jpg', file_size: 4 }),
};

const registeredHandlers: Record<string, ((ctx: unknown) => void)[]> = {};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on(event: string, handler: (ctx: unknown) => void) {
      if (!registeredHandlers[event]) registeredHandlers[event] = [];
      registeredHandlers[event].push(handler);
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

import type { ChannelMode } from '../config';
import { TelegramAdapter } from '../index';

const BOT_KEY = 'test-bot';
const SENT_AT_SECONDS = 1_699_000_000;
const OVERRIDES_FILE = `telegram/${BOT_KEY}/channel-overrides.jsonl`;

interface DeliverOptions {
  mode: ChannelMode;
  /** Text of the incoming message. Defaults to an unmentioned group post. */
  text?: string;
  /** A DM rather than a group post. */
  isDm?: boolean;
  /** Stored `regex_match` pattern for chat 100, written to the override store. */
  regexPattern?: string;
  /**
   * Raw value of Telegram's `date` field. Defaults to a real send time; the
   * point of overriding it is to drive the shapes grammy's types say cannot
   * occur but a wire payload can still carry.
   */
  date?: unknown;
}

/** Start an adapter under `opts.mode` and collect everything it forwards. */
async function mount(opts: DeliverOptions): Promise<InboundMessage[]> {
  for (const fn of Object.values(mockApi)) fn.mockClear();
  for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];

  let storage: Storage | undefined;
  if (opts.regexPattern !== undefined) {
    storage = new InMemoryStorage();
    const record = {
      channel: '100',
      mode: opts.mode,
      updatedAt: 1,
      regexPattern: opts.regexPattern,
    };
    await storage.mkdir(`telegram/${BOT_KEY}`);
    await storage.write(OVERRIDES_FILE, `${JSON.stringify(record)}\n`);
  }

  const adapter = new TelegramAdapter({
    token: '1:fake-token',
    cache: new InMemoryAttachmentCache(),
    botKey: BOT_KEY,
    defaultChannelMode: opts.mode,
    ...(storage ? { storage } : {}),
  });
  await adapter.start();

  const captured: InboundMessage[] = [];
  adapter.onMessage((msg) => captured.push(msg));
  return captured;
}

async function deliver(opts: DeliverOptions): Promise<InboundMessage[]> {
  const captured = await mount(opts);

  const handlers = registeredHandlers.message;
  if (!handlers?.length) throw new Error('No message handler registered');
  for (const h of handlers) {
    h({
      chat: { id: 100, type: opts.isDm ? 'private' : 'supergroup' },
      from: { id: 200, username: 'sitemanager' },
      message: {
        text: opts.text ?? 'concrete pour slipped to thursday',
        caption: undefined,
        message_id: 7,
        date: 'date' in opts ? opts.date : SENT_AT_SECONDS,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });
  }

  return captured;
}

/**
 * Fire `edited_message` and wait out the adapter's 200ms edit debounce.
 * Resolves with whatever was forwarded — an empty array if the edit was
 * gated away, which is the point of most of these cases.
 */
async function deliverEdit(opts: DeliverOptions): Promise<InboundMessage[]> {
  const captured = await mount(opts);

  const handlers = registeredHandlers.edited_message;
  if (!handlers?.length) throw new Error('No edited_message handler registered');
  // The edit window compares `edit_date` against `date`, so an edit is kept
  // five seconds after its message whatever `date` says — including the bogus
  // shapes, which the handler reads as 0.
  const date = 'date' in opts ? opts.date : SENT_AT_SECONDS;
  const editDate = typeof date === 'number' && Number.isFinite(date) ? date + 5 : 0;
  for (const h of handlers) {
    h({
      chat: { id: 100, type: opts.isDm ? 'private' : 'supergroup' },
      from: { id: 200, username: 'sitemanager' },
      editedMessage: {
        text: opts.text ?? 'concrete pour slipped to thursday',
        caption: undefined,
        message_id: 7,
        date,
        edit_date: editDate,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });
  }

  await new Promise((r) => setTimeout(r, 300));
  return captured;
}

describe('Telegram inbound — observe mode', () => {
  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
  });

  it('delivers an unmentioned group message as a record-only envelope', async () => {
    const captured = await deliver({ mode: 'observe' });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(true);
    expect(captured[0].chatId).toBe('100');
    expect(captured[0].userId).toBe('200');
  });

  // The product decision worth a test of its own: silence in an observed chat
  // must not be conditional on what a third party types.
  it('records an explicit @mention and still does not answer it', async () => {
    const captured = await deliver({ mode: 'observe', text: '@testbot are we on track?' });

    expect(captured).toHaveLength(1);
    expect(captured[0].isGroupMention).toBe(true);
    expect(captured[0].recordOnly).toBe(true);
  });

  // A 👀 on every message is the bot answering — visibly, to the whole chat.
  it('sets no receipt reaction on an observed message', async () => {
    await deliver({ mode: 'observe' });
    expect(mockApi.setMessageReaction).not.toHaveBeenCalled();
  });

  it('sets no receipt reaction on an observed @mention either', async () => {
    await deliver({ mode: 'observe', text: '@testbot hello' });
    expect(mockApi.setMessageReaction).not.toHaveBeenCalled();
  });

  it('a DM is still a conversation, never record-only', async () => {
    const captured = await deliver({ mode: 'observe', isDm: true });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
  });
});

describe('Telegram inbound — the modes that still reply', () => {
  it('all: answers, stamps recordOnly false and reacts', async () => {
    const captured = await deliver({ mode: 'all' });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
    expect(mockApi.setMessageReaction).toHaveBeenCalledTimes(1);
  });

  it('mention_only: an unmentioned group message reaches nothing at all', async () => {
    const captured = await deliver({ mode: 'mention_only' });

    expect(captured).toHaveLength(0);
    expect(mockApi.setMessageReaction).not.toHaveBeenCalled();
  });

  it('mention_only: an @mention is answered', async () => {
    const captured = await deliver({ mode: 'mention_only', text: '@testbot ping' });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
  });

  it('regex_match: a stored pattern that matches is answered', async () => {
    const captured = await deliver({ mode: 'regex_match', regexPattern: 'concrete' });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
  });

  it('regex_match: a stored pattern that does not match is dropped', async () => {
    const captured = await deliver({ mode: 'regex_match', regexPattern: 'scaffolding' });

    expect(captured).toHaveLength(0);
  });

  // The guard the shared evaluator gave back to the adapter along with pattern
  // compilation. Without it a single bad pattern in the store throws on EVERY
  // message in that chat instead of matching nothing.
  it('regex_match: an invalid stored pattern is a non-match, not a thrown error', async () => {
    await expect(deliver({ mode: 'regex_match', regexPattern: '([unclosed' })).resolves.toEqual([]);
  });
});

describe('Telegram inbound — sentAt', () => {
  it("carries Telegram's send time in ms, not the time of receipt", async () => {
    const captured = await deliver({ mode: 'all' });

    expect(captured[0].sentAt).toBe(SENT_AT_SECONDS * 1000);
    expect(captured[0].sentAt).not.toBe(Date.now());
  });

  it('stamps sentAt on a record-only envelope too', async () => {
    const captured = await deliver({ mode: 'observe' });

    expect(captured[0].sentAt).toBe(SENT_AT_SECONDS * 1000);
  });

  // `sentAt` is persisted: the transcript store's `sent_at` is INTEGER NOT NULL
  // in a STRICT table, and SQLite has no NaN — a bound NaN arrives as NULL and
  // aborts the INSERT. The gateway's `sentAt ?? Date.now()` does not save it
  // either, because NaN is not nullish. So the adapter must never emit one:
  // absent means "no platform timestamp", which is what Slack's `tsToSentAt`
  // and WhatsApp's `resolveSentAt` already say.
  const BOGUS_DATES: [string, unknown][] = [
    ['absent', undefined],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1699000000'],
    ['zero', 0],
    ['negative', -1],
  ];

  for (const [label, date] of BOGUS_DATES) {
    it(`omits sentAt rather than emitting a non-finite one when date is ${label}`, async () => {
      const captured = await deliver({ mode: 'all', isDm: true, date });

      expect(captured).toHaveLength(1);
      expect(captured[0].sentAt).toBeUndefined();
      expect('sentAt' in captured[0]).toBe(false);
    });

    it(`omits sentAt on an edit when date is ${label}`, async () => {
      const captured = await deliverEdit({ mode: 'all', isDm: true, date });

      expect(captured).toHaveLength(1);
      expect(captured[0].sentAt).toBeUndefined();
      expect('sentAt' in captured[0]).toBe(false);
    });
  }
});

// Defect 2: `edited_message` used to bypass channel-mode gating entirely, so
// an edit in an `observe` chat arrived answerable and the bot replied in a chat
// it was configured only to watch.
describe('Telegram inbound — edited_message under channel modes', () => {
  it('observe: an edit is recorded, never answered', async () => {
    const captured = await deliverEdit({ mode: 'observe' });

    expect(captured).toHaveLength(1);
    expect(captured[0].isEdit).toBe(true);
    expect(captured[0].recordOnly).toBe(true);
  });

  it('observe: an edit that mentions the bot is still not answered', async () => {
    const captured = await deliverEdit({ mode: 'observe', text: '@testbot are we on track?' });

    expect(captured).toHaveLength(1);
    expect(captured[0].isGroupMention).toBe(true);
    expect(captured[0].recordOnly).toBe(true);
  });

  // The edit path builds no receipt reaction today. Asserted so that if one is
  // ever added it cannot land in a chat the operator told the bot to watch.
  it('observe: an edit sets no receipt reaction', async () => {
    await deliverEdit({ mode: 'observe' });

    expect(mockApi.setMessageReaction).not.toHaveBeenCalled();
  });

  it('all: an edit is answered, as before', async () => {
    const captured = await deliverEdit({ mode: 'all' });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
    expect(captured[0].sentAt).toBe(SENT_AT_SECONDS * 1000);
  });

  it('mention_only: an edit that mentions the bot is answered', async () => {
    const captured = await deliverEdit({ mode: 'mention_only', text: '@testbot ping' });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
  });

  it('mention_only: an unmentioned edit reaches nothing at all', async () => {
    const captured = await deliverEdit({ mode: 'mention_only' });

    expect(captured).toHaveLength(0);
  });

  it('a DM edit is a conversation, never record-only', async () => {
    const captured = await deliverEdit({ mode: 'observe', isDm: true });

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Record-only messages must not cost a download.
//
// The gateway's transcript row is TEXT — it keeps `text` and discards
// attachments — so fetching the photo spends the bandwidth to throw the bytes
// away, and leaves a third party's media in the attachment cache under a
// lifetime the transcript's retention never touches.
// ---------------------------------------------------------------------------

/** Fire a captioned photo through the real `message` handler under `mode`. */
async function deliverPhoto(mode: ChannelMode): Promise<InboundMessage[]> {
  const captured = await mount({ mode });

  const handlers = registeredHandlers.message;
  if (!handlers?.length) throw new Error('No message handler registered');
  for (const h of handlers) {
    h({
      chat: { id: 100, type: 'supergroup' },
      from: { id: 200, username: 'sitemanager' },
      message: {
        caption: 'rebar delivered, pour is thursday',
        photo: [{ file_id: 'f1', file_size: 4 }],
        message_id: 7,
        date: SENT_AT_SECONDS,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });
  }

  // The download path is fire-and-forget, so the envelope for a message that
  // IS answered arrives a tick later than the record-only one.
  await new Promise((r) => setTimeout(r, 20));
  return captured;
}

describe('Telegram inbound — media on a record-only message', () => {
  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads nothing for an observed photo, and keeps its caption', async () => {
    const captured = await deliverPhoto('observe');

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(true);
    expect(captured[0].text).toBe('rebar delivered, pour is thursday');
    expect(captured[0].attachments).toBeUndefined();
    expect(mockApi.getFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  // The control: without it, "no download" cannot be told from a regression
  // that broke the download path outright.
  it('still downloads a photo on a message it answers', async () => {
    const captured = await deliverPhoto('all');

    expect(captured).toHaveLength(1);
    expect(captured[0].recordOnly).toBe(false);
    expect(captured[0].attachments).toHaveLength(1);
    expect(mockApi.getFile).toHaveBeenCalledTimes(1);
  });
});
