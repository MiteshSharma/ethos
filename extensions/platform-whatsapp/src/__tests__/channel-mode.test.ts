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
    denyUnknown: false,
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
