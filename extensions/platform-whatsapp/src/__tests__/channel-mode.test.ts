// The inbound gate: which group messages the adapter answers, which it only
// records, and which it drops — plus the two mention shapes the old inline
// gate dropped by mistake (plan/phases/ambient-group-monitoring.md T6, R11).

import type { AttachmentCache, InboundMessage, Storage } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMode } from '../config';
import type { RawWhatsAppMessage } from '../message-parser';

const BOT_JID = '15551234567:12@s.whatsapp.net';
const BOT_NUMBER = '15551234567';
const GROUP = '120363000000000000@g.us';
const DM = '15559999999@s.whatsapp.net';
const PARTICIPANT = '15559999999@s.whatsapp.net';

/** Every `sock.sendMessage` the adapter makes during a test. */
const sent: Array<{ jid: string; content: Record<string, unknown> }> = [];
const downloadMediaMessage = vi.fn(async () => Buffer.from([1, 2, 3, 4]));
/** The handlers the adapter registers on `sock.ev`. */
const evHandlers = new Map<string, (payload: unknown) => unknown>();

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: () => ({
    ev: {
      on: (event: string, handler: (payload: unknown) => unknown) => {
        evHandlers.set(event, handler);
      },
    },
    user: { id: BOT_JID },
    authState: { creds: { registered: true } },
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      sent.push({ jid, content });
      return { key: { id: 'sent-1' } };
    },
  }),
  useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
  DisconnectReason: { loggedOut: 401 },
  downloadMediaMessage,
}));

const { WhatsAppAdapter } = await import('../index');

/** Minimal Storage: the override store only reads, mkdirs and appends. */
function fakeStorage(files: Record<string, string>): Storage {
  return {
    read: async (path: string) => files[path] ?? null,
    mkdir: async () => {},
    append: async (path: string, data: string) => {
      files[path] = (files[path] ?? '') + data;
    },
  } as unknown as Storage;
}

function fakeCache(writes: number[]): AttachmentCache {
  return {
    write: async (bytes: Uint8Array) => {
      writes.push(bytes.length);
      return 'file:///cached';
    },
  } as unknown as AttachmentCache;
}

interface HarnessOptions {
  defaultMode?: ChannelMode;
  cache?: AttachmentCache;
  storage?: Storage;
  /** Absent = `false`, which is what every mode test above wants. */
  denyUnknown?: boolean;
  allowedJids?: string[];
  denyMessage?: string;
}

/**
 * Starts an adapter against the mocked Baileys socket and returns a `deliver`
 * that drives the real `messages.upsert` handler — the production path, gate
 * and media block included.
 */
async function harness(opts: HarnessOptions = {}) {
  const adapter = new WhatsAppAdapter({
    sessionDir: '/tmp/ethos-wa-channel-mode-test',
    botKey: 'bot1',
    denyUnknown: opts.denyUnknown ?? false,
    ...(opts.allowedJids ? { allowedJids: opts.allowedJids } : {}),
    ...(opts.denyMessage ? { denyMessage: opts.denyMessage } : {}),
    ...(opts.defaultMode ? { defaultMode: opts.defaultMode } : {}),
    ...(opts.cache ? { cache: opts.cache } : {}),
    ...(opts.storage ? { storage: opts.storage, whatsappDir: 'whatsapp' } : {}),
  });
  const received: InboundMessage[] = [];
  adapter.onMessage((m) => received.push(m));
  await adapter.start();
  // `botJid` is only known once the connection opens.
  evHandlers.get('connection.update')?.({ connection: 'open' });

  const upsert = evHandlers.get('messages.upsert');
  if (!upsert) throw new Error('adapter registered no messages.upsert handler');
  return {
    received,
    deliver: async (msg: RawWhatsAppMessage) => {
      await upsert({ type: 'notify', messages: [msg] });
    },
  };
}

function base(jid: string): RawWhatsAppMessage['key'] {
  return { remoteJid: jid, fromMe: false, id: 'wa-1', participant: PARTICIPANT };
}

function textMessage(jid: string, text: string): RawWhatsAppMessage {
  return { key: base(jid), message: { conversation: text }, messageTimestamp: 1700000000 };
}

/** A group message from somebody who is NOT on the allowlist. */
function textMessageFrom(jid: string, text: string, participant: string): RawWhatsAppMessage {
  return {
    key: { remoteJid: jid, fromMe: false, id: 'wa-1', participant },
    message: { conversation: text },
    messageTimestamp: 1700000000,
  };
}

function mentionChipMessage(jid: string, text: string, mentioned: string[]): RawWhatsAppMessage {
  return {
    key: base(jid),
    message: { extendedTextMessage: { text, contextInfo: { mentionedJid: mentioned } } },
    messageTimestamp: 1700000000,
  };
}

function captionedImage(jid: string, caption: string): RawWhatsAppMessage {
  return {
    key: base(jid),
    message: { imageMessage: { mimetype: 'image/jpeg', caption, fileLength: 4 } },
    messageTimestamp: 1700000000,
  };
}

function reactions(): Array<{ jid: string; content: Record<string, unknown> }> {
  return sent.filter((s) => 'react' in s.content);
}

/** Everything the adapter actually SAID — the deny notice included. */
function texts(): Array<{ jid: string; content: Record<string, unknown> }> {
  return sent.filter((s) => 'text' in s.content);
}

beforeEach(() => {
  sent.length = 0;
  evHandlers.clear();
  downloadMediaMessage.mockClear();
});

describe('mention detection (regression: the gate disagreed with the parser)', () => {
  it('delivers a captioned image that @mentions the bot in a mention_only group', async () => {
    const writes: number[] = [];
    const { received, deliver } = await harness({
      defaultMode: 'mention_only',
      cache: fakeCache(writes),
    });

    await deliver(captionedImage(GROUP, `@${BOT_NUMBER} what is in this photo?`));

    expect(received).toHaveLength(1);
    expect(received[0]?.isGroupMention).toBe(true);
    expect(received[0]?.text).toBe(`@${BOT_NUMBER} what is in this photo?`);
    expect(received[0]?.attachments?.[0]?.type).toBe('image');
  });

  it('delivers a mention chip carrying no literal @number in the body', async () => {
    const { received, deliver } = await harness({ defaultMode: 'mention_only' });

    await deliver(
      mentionChipMessage(GROUP, 'please handle this', [`${BOT_NUMBER}@s.whatsapp.net`]),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.isGroupMention).toBe(true);
  });

  it('still drops an unmentioned group message in mention_only', async () => {
    const { received, deliver } = await harness({ defaultMode: 'mention_only' });
    await deliver(textMessage(GROUP, 'unrelated chatter'));
    expect(received).toHaveLength(0);
  });
});

describe('the decision runs before the media download', () => {
  it('downloads nothing for a message the mode drops', async () => {
    const writes: number[] = [];
    const { received, deliver } = await harness({
      defaultMode: 'mention_only',
      cache: fakeCache(writes),
    });

    await deliver(captionedImage(GROUP, 'a photo nobody asked the bot about'));

    expect(received).toHaveLength(0);
    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('downloads nothing for a message the mode only records, and keeps the caption', async () => {
    // The gateway's transcript row is TEXT. Downloading here would spend the
    // bandwidth to throw the bytes away, and leave a third party's photo in
    // the attachment cache outside the transcript's retention.
    const writes: number[] = [];
    const { received, deliver } = await harness({
      defaultMode: 'observe',
      cache: fakeCache(writes),
    });

    await deliver(captionedImage(GROUP, 'rebar delivered, pour is thursday'));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(true);
    expect(received[0]?.text).toBe('rebar delivered, pour is thursday');
    expect(received[0]?.attachments).toBeUndefined();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('downloads for a message it answers', async () => {
    const writes: number[] = [];
    const { received, deliver } = await harness({ defaultMode: 'all', cache: fakeCache(writes) });

    await deliver(captionedImage(GROUP, 'look at this'));

    expect(received).toHaveLength(1);
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([4]);
  });
});

describe('receipt reaction', () => {
  it('is skipped for a recorded-only message', async () => {
    const { received, deliver } = await harness({ defaultMode: 'observe' });

    await deliver(textMessage(GROUP, 'site update: pour finished'));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(true);
    expect(reactions()).toEqual([]);
  });

  it('is still sent for a message the adapter answers', async () => {
    const { received, deliver } = await harness({ defaultMode: 'mention_only' });

    await deliver(textMessage(GROUP, `@${BOT_NUMBER} status?`));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(false);
    expect(reactions()).toHaveLength(1);
    expect(reactions()[0]?.content.react).toEqual({ text: '\u{1F440}', key: base(GROUP) });
  });
});

describe('every mode decides', () => {
  const cases: Array<{
    mode: ChannelMode;
    what: string;
    build: () => RawWhatsAppMessage;
    delivered: boolean;
    recordOnly?: boolean;
  }> = [
    {
      mode: 'all',
      what: 'an unmentioned group message',
      build: () => textMessage(GROUP, 'hello room'),
      delivered: true,
      recordOnly: false,
    },
    {
      mode: 'mention_only',
      what: 'an unmentioned group message',
      build: () => textMessage(GROUP, 'hello room'),
      delivered: false,
    },
    {
      mode: 'mention_only',
      what: 'an @mention',
      build: () => textMessage(GROUP, `@${BOT_NUMBER} hello`),
      delivered: true,
      recordOnly: false,
    },
    {
      mode: 'observe',
      what: 'an unmentioned group message',
      build: () => textMessage(GROUP, 'hello room'),
      delivered: true,
      recordOnly: true,
    },
    {
      mode: 'observe',
      what: 'an @mention (observe never replies)',
      build: () => textMessage(GROUP, `@${BOT_NUMBER} answer me`),
      delivered: true,
      recordOnly: true,
    },
    {
      mode: 'observe',
      what: 'a DM (always a conversation with the bot)',
      build: () => textMessage(DM, 'hello'),
      delivered: true,
      recordOnly: false,
    },
  ];

  for (const c of cases) {
    it(`${c.mode}: ${c.what}`, async () => {
      const { received, deliver } = await harness({ defaultMode: c.mode });
      await deliver(c.build());
      expect(received).toHaveLength(c.delivered ? 1 : 0);
      if (c.delivered) expect(received[0]?.recordOnly).toBe(c.recordOnly);
    });
  }

  it('answers every group message when no default mode is configured', async () => {
    const { received, deliver } = await harness();
    await deliver(textMessage(GROUP, 'hello room'));
    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(false);
  });
});

describe('per-chat overrides', () => {
  it('a stored override beats the default mode', async () => {
    const storage = fakeStorage({
      'whatsapp/bot1/channel-overrides.jsonl': `${JSON.stringify({
        channel: GROUP,
        mode: 'observe',
        updatedAt: 1,
      })}\n`,
    });
    const { received, deliver } = await harness({ defaultMode: 'all', storage });

    await deliver(textMessage(GROUP, 'hello room'));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(true);
    expect(reactions()).toEqual([]);
  });
});

// A stored mode this build cannot read, driven from the override file through
// the real `messages.upsert` handler.
//
// `evaluateChannelMode` fails closed on a mode it does not recognise, but
// until the shared store KEPT such a record that branch was unreachable here:
// the store dropped the line, `get()` returned `undefined` —
// indistinguishable from "no override stored" — and the gate substituted
// `defaultMode`, which for this adapter is `all`.
describe('a stored mode this build cannot read', () => {
  /** Every shape that actually reaches disk, not one shape of nonsense. */
  const UNREADABLE = [
    'observe ', // trailing space
    'Observe', // wrong case
    'obserev', // typo
    'silent_digest_only', // a mode a newer binary knows and this one does not
    '', // empty
    // Two modes that are real — on OTHER adapters. WhatsApp's enum is the
    // smallest of the four: no threads, so no `thread_follow`, and no
    // `regex_match`. `evaluateChannelMode` used to test a hard-coded UNION of
    // all four enums, under which both were "recognised" here and an @mention
    // fell through to the answering `isGroupMention` branch. WhatsApp now
    // passes its own `CHANNEL_MODES` (`../config`) as `supportedModes`.
    'thread_follow',
    'regex_match',
  ];

  const storedAs = (mode: string) =>
    fakeStorage({
      'whatsapp/bot1/channel-overrides.jsonl': `${JSON.stringify({
        channel: GROUP,
        mode,
        updatedAt: 1,
      })}\n`,
    });

  for (const mode of UNREADABLE) {
    it(`forwards nothing for an unmentioned group message under ${JSON.stringify(mode)}`, async () => {
      const { received, deliver } = await harness({ defaultMode: 'all', storage: storedAs(mode) });

      await deliver(textMessage(GROUP, 'hello room'));

      expect(received).toHaveLength(0);
      expect(reactions()).toEqual([]);
    });

    it(`forwards nothing for an @mention under ${JSON.stringify(mode)}`, async () => {
      // The dangerous case: an explicit mention is what every answering mode
      // replies to.
      const { received, deliver } = await harness({
        defaultMode: 'mention_only',
        storage: storedAs(mode),
      });

      await deliver(
        mentionChipMessage(GROUP, 'please handle this', [`${BOT_NUMBER}@s.whatsapp.net`]),
      );

      expect(received).toHaveLength(0);
      expect(reactions()).toEqual([]);
    });
  }

  it('a DM is still a conversation — a bad override must not deafen the bot to its owner', async () => {
    const storage = fakeStorage({
      'whatsapp/bot1/channel-overrides.jsonl': `${JSON.stringify({
        channel: DM,
        mode: 'obserev',
        updatedAt: 1,
      })}\n`,
    });
    const { received, deliver } = await harness({ defaultMode: 'mention_only', storage });

    await deliver(textMessage(DM, 'hello'));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(false);
  });

  // The two cases that must NOT change. An absent override is not the same as
  // an override this build cannot read.
  it('an ABSENT override still falls back to the configured default', async () => {
    const { received, deliver } = await harness({ defaultMode: 'all', storage: fakeStorage({}) });

    await deliver(textMessage(GROUP, 'hello room'));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(false);
  });

  it('a VALID stored override behaves exactly as before', async () => {
    const { received, deliver } = await harness({
      defaultMode: 'all',
      storage: storedAs('observe'),
    });

    await deliver(textMessage(GROUP, 'hello room'));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(true);
  });
});

describe('sentAt', () => {
  it('is the platform send time in milliseconds, not arrival time', async () => {
    const { received, deliver } = await harness({ defaultMode: 'all' });
    await deliver(textMessage(GROUP, 'hello room'));
    expect(received[0]?.sentAt).toBe(1_700_000_000_000);
  });

  it('accepts the Long shape protobufjs hands back for the same field', async () => {
    const { received, deliver } = await harness({ defaultMode: 'all' });
    const msg = textMessage(GROUP, 'hello room');
    msg.messageTimestamp = { toNumber: () => 1_700_000_042 };
    await deliver(msg);
    expect(received[0]?.sentAt).toBe(1_700_000_042_000);
  });

  it('is undefined when WhatsApp sent no timestamp', async () => {
    const { received, deliver } = await harness({ defaultMode: 'all' });
    const msg = textMessage(GROUP, 'hello room');
    msg.messageTimestamp = undefined;
    await deliver(msg);
    expect(received[0]?.sentAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The allowlist and the mode gate
// ---------------------------------------------------------------------------

/**
 * The allowlist used to run FIRST, and it sent `denyMessage` to the GROUP jid.
 * In an observed group every participant is non-allowlisted by definition, so
 * the bot replied to every message in the one mode whose whole promise is that
 * it never replies to any. These drive the real `messages.upsert` handler and
 * assert on what reached the socket, because the bug was invisible from the
 * return value — the envelope was dropped either way.
 */
describe('the allowlist governs who may command, not who may be observed', () => {
  const STRANGER = '15558888888@s.whatsapp.net';
  const ALLOWED = '15559999999';
  const DENY = 'sorry, I only talk to my owner';

  function guarded(defaultMode: ChannelMode) {
    return harness({
      defaultMode,
      denyUnknown: true,
      allowedJids: [ALLOWED],
      denyMessage: DENY,
    });
  }

  it('says nothing to a stranger in an observed group', async () => {
    const { deliver } = await guarded('observe');

    await deliver(textMessageFrom(GROUP, 'rebar delivered, pour is thursday', STRANGER));

    // Nothing at all reached the socket: no deny notice, no receipt reaction.
    expect(sent).toEqual([]);
  });

  it('records the stranger anyway, because that is what observe is for', async () => {
    // The operator set this room to `observe` to watch people who will never
    // be on the allowlist. Gating the RECORDING on it would leave the digest
    // reading nothing but the owner's own messages.
    const { received, deliver } = await guarded('observe');

    await deliver(textMessageFrom(GROUP, 'rebar delivered, pour is thursday', STRANGER));

    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(true);
    expect(received[0]?.text).toBe('rebar delivered, pour is thursday');
  });

  it('still denies a stranger in a group it answers', async () => {
    const { received, deliver } = await guarded('all');

    await deliver(textMessageFrom(GROUP, 'hey bot, run this', STRANGER));

    expect(texts()).toHaveLength(1);
    expect(texts()[0]?.jid).toBe(GROUP);
    expect(texts()[0]?.content.text).toBe(DENY);
    expect(received).toHaveLength(0);
  });

  it('still denies a stranger in a DM', async () => {
    const { received, deliver } = await guarded('observe');

    // A DM outranks the mode (`evaluateChannelMode` answers every DM), so the
    // allowlist is consulted and the refusal is exactly what it always was.
    await deliver(textMessage(STRANGER, 'let me in'));

    expect(texts()).toHaveLength(1);
    expect(texts()[0]?.jid).toBe(STRANGER);
    expect(texts()[0]?.content.text).toBe(DENY);
    expect(received).toHaveLength(0);
  });

  it('still answers an allowlisted sender in a group it answers', async () => {
    const { received, deliver } = await guarded('all');

    await deliver(textMessage(GROUP, 'status?'));

    expect(texts()).toEqual([]);
    expect(received).toHaveLength(1);
    expect(received[0]?.recordOnly).toBe(false);
    expect(reactions()).toHaveLength(1);
  });
});
