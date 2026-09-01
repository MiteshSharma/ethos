// Items 5 + 10 — the two inbound bounds the Discord adapter now takes from
// config: `gateway.maxInboundMediaBytes` (attachment ceiling) and
// `discord.missedMessageBackfill` (enabled / windowSeconds / limit).
//
// Both are enforced inside `registerMessageHandler`, so the tests drive the
// real handler with a fake discord.js client rather than re-simulating it.

import type { AttachmentCache, InboundMessage } from '@ethosagent/types';
import type { Client, Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMessageHandler } from '../events/messages';
import type { BackfillStateStore } from '../store/backfill-state';

const CDN = 'https://cdn.discordapp.com/attachments/1/2/pic.png';

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

interface HistoryMessage {
  id: string;
  content: string;
  createdTimestamp: number;
  author: { id: string; username: string; bot: boolean };
}

function fakeMessage(opts: {
  attachments?: Array<{ size: number; name: string; url: string; contentType: string }>;
  history?: HistoryMessage[];
  fetchCalls?: Array<{ limit?: number }>;
  createdTimestamp?: number;
}): Message {
  const attachments = new Map(
    (opts.attachments ?? []).map((a, i) => [String(i), { ...a, contentType: a.contentType }]),
  );
  return {
    id: 'm1',
    channelId: 'C1',
    content: 'hello',
    createdTimestamp: opts.createdTimestamp ?? 1_000_000,
    author: { id: 'U1', username: 'alice', bot: false },
    attachments,
    mentions: { has: () => false, everyone: false, repliedUser: undefined },
    reference: undefined,
    channel: {
      isDMBased: () => true,
      isThread: () => false,
      parentId: null,
      messages: {
        fetch: async (args: { limit?: number }) => {
          opts.fetchCalls?.push(args);
          return new Map((opts.history ?? []).map((h) => [h.id, h]));
        },
      },
    },
    react: async () => {},
  } as unknown as Message;
}

/** Records every write so the test can assert what got past the cap. */
function recordingCache(written: string[]): AttachmentCache {
  return {
    write: async (bytes: Uint8Array) => {
      written.push(`${bytes.length}`);
      return 'file:///cached';
    },
  } as unknown as AttachmentCache;
}

function backfillStore(done = false): BackfillStateStore {
  let marked = done;
  return {
    hasDone: () => marked,
    mark: async () => {
      marked = true;
    },
  } as unknown as BackfillStateStore;
}

function baseCtx(overrides: Record<string, unknown>) {
  return {
    botKey: 'bot-a',
    defaultChannelMode: 'all' as const,
    receiptReaction: '',
    onMessage: () => {},
    onReceipt: () => {},
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Discord inbound media cap', () => {
  function stubFetch(byteLength: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(byteLength),
      })),
    );
  }

  async function run(maxInboundMediaBytes: number | undefined, size: number) {
    const { client, handlers } = fakeClient();
    const written: string[] = [];
    const messages: InboundMessage[] = [];
    registerMessageHandler(
      baseCtx({
        client,
        cache: recordingCache(written),
        maxInboundMediaBytes,
        onMessage: (m: InboundMessage) => messages.push(m),
        // biome-ignore lint/suspicious/noExplicitAny: the fake ctx omits optional stores
      }) as any,
    );
    stubFetch(size);
    await handlers.get('messageCreate')?.(
      fakeMessage({
        attachments: [{ size, name: 'pic.png', url: CDN, contentType: 'image/png' }],
      }),
    );
    return { written, messages };
  }

  it('skips an attachment over the configured override', async () => {
    const { written, messages } = await run(1024, 2048);
    expect(written).toEqual([]);
    expect(messages[0]?.attachments).toBeUndefined();
  });

  it('downloads an attachment under the configured override', async () => {
    const { written, messages } = await run(4096, 2048);
    expect(written).toEqual(['2048']);
    expect(messages[0]?.attachments).toHaveLength(1);
  });

  it('falls back to the adapter own 25 MB default when unset', async () => {
    const under = await run(undefined, 2048);
    expect(under.written).toEqual(['2048']);

    const over = await run(undefined, 25 * 1024 * 1024 + 1);
    expect(over.written).toEqual([]);
  });
});

describe('Discord missed-message backfill bounds', () => {
  const now = 1_000_000;
  const history: HistoryMessage[] = [
    {
      id: 'h1',
      content: 'ancient',
      createdTimestamp: now - 3_600_000,
      author: { id: 'U2', username: 'bob', bot: false },
    },
    {
      id: 'h2',
      content: 'recent',
      createdTimestamp: now - 30_000,
      author: { id: 'U3', username: 'carol', bot: false },
    },
  ];

  async function run(backfill?: { enabled?: boolean; windowSeconds?: number; limit?: number }) {
    const { client, handlers } = fakeClient();
    const messages: InboundMessage[] = [];
    const fetchCalls: Array<{ limit?: number }> = [];
    registerMessageHandler(
      baseCtx({
        client,
        backfillState: backfillStore(),
        backfill,
        onMessage: (m: InboundMessage) => messages.push(m),
        // biome-ignore lint/suspicious/noExplicitAny: the fake ctx omits optional stores
      }) as any,
    );
    await handlers.get('messageCreate')?.(
      fakeMessage({ history, fetchCalls, createdTimestamp: now }),
    );
    return { envelope: messages[0], fetchCalls };
  }

  it('reads history with the 50-message default when unconfigured', async () => {
    const { envelope, fetchCalls } = await run();
    expect(fetchCalls).toEqual([{ limit: 50, before: 'm1' }]);
    expect(envelope?.priorContext).toContain('ancient');
    expect(envelope?.priorContext).toContain('recent');
  });

  it('skips the history read entirely when disabled', async () => {
    const { envelope, fetchCalls } = await run({ enabled: false });
    expect(fetchCalls).toEqual([]);
    expect(envelope?.priorContext).toBeUndefined();
  });

  it('asks Discord for exactly the configured limit', async () => {
    const { fetchCalls } = await run({ limit: 7 });
    expect(fetchCalls).toEqual([{ limit: 7, before: 'm1' }]);
  });

  it('drops fetched messages older than the configured window', async () => {
    const { envelope } = await run({ windowSeconds: 60 });
    expect(envelope?.priorContext).toContain('recent');
    expect(envelope?.priorContext).not.toContain('ancient');
    expect(envelope?.priorContextEntries?.map((e) => e.userId)).toEqual(['U3']);
  });

  it('leaves no prior context when the window excludes everything', async () => {
    const { envelope } = await run({ windowSeconds: 1 });
    expect(envelope?.priorContext).toBeUndefined();
  });
});
