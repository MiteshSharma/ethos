// Discord's inbound path in `observe` mode, driven through the real
// `registerMessageHandler` with a fake discord.js client.
//
// The triage suite proves the decision; this proves what the ADAPTER does with
// it — that the envelope actually leaves the handler stamped, and that nothing
// on the way out breaks the one promise observe mode makes: the room never
// sees the bot.

import type { AttachmentCache, InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMode } from '../config';
import { registerMessageHandler } from '../events/messages';

function fakeClient() {
  const handlers = new Map<string, (message: Message) => Promise<void>>();
  const client = {
    on: (event: string, handler: (message: Message) => Promise<void>) => {
      handlers.set(event, handler);
    },
    user: undefined,
  } as unknown as Client;
  return { client, handlers };
}

function guildMessage(react: () => Promise<void>): Message {
  return {
    id: 'm1',
    channelId: 'C_SITE_7',
    content: 'concrete pour slipped to thursday',
    createdTimestamp: 1_699_000_000_000,
    author: { id: 'U_STRANGER', username: 'sitemanager', bot: false },
    attachments: new Map(),
    mentions: { has: () => false, everyone: false, repliedUser: undefined },
    reference: undefined,
    channel: {
      isDMBased: () => false,
      isThread: () => false,
      parentId: null,
      messages: { fetch: async () => new Map() },
    },
    react,
  } as unknown as Message;
}

async function deliver(mode: ChannelMode): Promise<{
  envelopes: InboundMessage[];
  react: ReturnType<typeof vi.fn>;
}> {
  const { client, handlers } = fakeClient();
  const envelopes: InboundMessage[] = [];
  const react = vi.fn(async () => {});

  registerMessageHandler({
    client,
    botKey: 'bot-1',
    defaultChannelMode: mode,
    receiptReaction: '👀',
    onMessage: (msg: InboundMessage) => envelopes.push(msg),
    onReceipt: () => {},
  });

  const handler = handlers.get('messageCreate');
  expect(handler).toBeDefined();
  await handler?.(guildMessage(react));

  return { envelopes, react };
}

describe('Discord inbound — observe mode', () => {
  it('delivers an unmentioned group message as a record-only envelope', async () => {
    const { envelopes } = await deliver('observe');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.recordOnly).toBe(true);
    expect(envelopes[0]?.chatId).toBe('C_SITE_7');
    expect(envelopes[0]?.userId).toBe('U_STRANGER');
    expect(envelopes[0]?.sentAt).toBe(1_699_000_000_000);
  });

  // A 👀 on every message is the bot answering — visibly, to the whole room.
  it('adds no receipt reaction to an observed message', async () => {
    const { react } = await deliver('observe');
    expect(react).not.toHaveBeenCalled();
  });

  it('still reacts on a message it will actually answer', async () => {
    const { envelopes, react } = await deliver('all');

    expect(envelopes[0]?.recordOnly).toBe(false);
    expect(react).toHaveBeenCalledWith('👀');
  });

  it('delivers nothing at all in mention_only mode', async () => {
    const { envelopes, react } = await deliver('mention_only');

    expect(envelopes).toHaveLength(0);
    expect(react).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Record-only messages must not cost a download.
//
// The gateway's transcript row is TEXT — it keeps `text` and discards
// attachments — so fetching the image spends the bandwidth to throw the bytes
// away, and leaves a third party's media in the attachment cache under a
// lifetime the transcript's retention never touches.
// ---------------------------------------------------------------------------

const CDN_URL = 'https://cdn.discordapp.com/attachments/1/2/blueprint.png';

function messageWithAttachment(): Message {
  return {
    id: 'm2',
    channelId: 'C_SITE_7',
    content: 'blueprint for the north wall',
    createdTimestamp: 1_699_000_000_000,
    author: { id: 'U_STRANGER', username: 'sitemanager', bot: false },
    attachments: new Map([
      ['a1', { name: 'blueprint.png', size: 4, contentType: 'image/png', url: CDN_URL }],
    ]),
    mentions: { has: () => false, everyone: false, repliedUser: undefined },
    reference: undefined,
    channel: {
      isDMBased: () => false,
      isThread: () => false,
      parentId: null,
      messages: { fetch: async () => new Map() },
    },
    react: async () => {},
  } as unknown as Message;
}

async function deliverAttachment(mode: ChannelMode): Promise<{
  envelopes: InboundMessage[];
  written: number[];
}> {
  const { client, handlers } = fakeClient();
  const envelopes: InboundMessage[] = [];
  const written: number[] = [];
  const cache = {
    write: async (bytes: Uint8Array) => {
      written.push(bytes.length);
      return 'file:///cached';
    },
  } as unknown as AttachmentCache;

  registerMessageHandler({
    client,
    botKey: 'bot-1',
    defaultChannelMode: mode,
    receiptReaction: '',
    cache,
    onMessage: (msg: InboundMessage) => envelopes.push(msg),
    onReceipt: () => {},
  });

  const handler = handlers.get('messageCreate');
  expect(handler).toBeDefined();
  await handler?.(messageWithAttachment());

  return { envelopes, written };
}

describe('Discord inbound — attachments on a record-only message', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads nothing for an observed attachment, and keeps the message text', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { envelopes, written } = await deliverAttachment('observe');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.recordOnly).toBe(true);
    expect(envelopes[0]?.text).toBe('blueprint for the north wall');
    expect(envelopes[0]?.attachments).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  // The control: without it, "no download" cannot be told from a regression
  // that broke the download path outright.
  it('still downloads an attachment on a message it answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })),
    );
    const { envelopes, written } = await deliverAttachment('all');

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.recordOnly).toBe(false);
    expect(envelopes[0]?.attachments).toHaveLength(1);
    expect(written).toEqual([4]);
  });
});
