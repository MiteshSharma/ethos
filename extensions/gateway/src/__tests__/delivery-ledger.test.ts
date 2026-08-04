import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import type {
  AgentEvent,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

// ---------------------------------------------------------------------------
// Item 9 — durable delivery obligations.
//
// The property under test is NOT "we called send()". It is "the adapter said
// ok", because every shipped adapter catches platform failures and returns
// { ok: false } rather than throwing. Each case below either confirms or
// withholds that ok and asserts what the ledger did with the row.
// ---------------------------------------------------------------------------

function ledger() {
  return new SQLiteDeliveryLedger(':memory:');
}

/** Adapter whose send outcome is scriptable, plus a record of what it saw. */
function stubAdapter(opts: { ok?: boolean; canEdit?: boolean } = {}) {
  const sent: Array<{ chatId: string; message: OutboundMessage }> = [];
  let nextId = 1;
  const adapter = {
    id: 'telegram:test',
    displayName: 'Telegram',
    capabilities: { platform: 'telegram' },
    canSendTyping: false,
    canEditMessage: opts.canEdit ?? false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (chatId: string, message: OutboundMessage): Promise<DeliveryResult> => {
      sent.push({ chatId, message });
      return opts.ok === false
        ? { ok: false, error: 'platform rejected the message' }
        : { ok: true, messageId: String(nextId++) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter;
  return Object.assign(adapter, { sent });
}

/** Edit-capable adapter for the streaming terminal-edit path. */
function editAdapter(opts: { editOk?: boolean } = {}) {
  const edits: Array<{ messageId: string; text: string }> = [];
  const base = stubAdapter({ canEdit: true });
  const withEdit = Object.assign(base, {
    edits,
    editMessage: vi.fn(
      async (_c: string, messageId: string, text: string): Promise<DeliveryResult> => {
        edits.push({ messageId, text });
        return opts.editOk === false
          ? { ok: false, error: 'edit rejected' }
          : { ok: true, messageId };
      },
    ),
  });
  return withEdit;
}

function loopYielding(events: AgentEvent[]) {
  return {
    run: vi.fn(async function* () {
      for (const e of events) yield e;
    }),
    hooks: new DefaultHookRegistry(),
  };
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hi',
    isDm: true,
    isGroupMention: false,
    messageId: `m${Math.random()}`,
    botKey: 'bot-a',
    raw: {},
    ...overrides,
  };
}

function gatewayWith(
  loop: ReturnType<typeof loopYielding>,
  store: SQLiteDeliveryLedger,
  extra: Record<string, unknown> = {},
  botKeys: string[] = ['bot-a'],
) {
  return new Gateway({
    bots: botKeys.map((botKey) => ({
      botKey,
      loop: loop as unknown as AgentLoop,
      binding: { type: 'personality' as const, name: 'default' },
    })),
    deliveryLedger: store,
    clarifySweepIntervalMs: 0,
    streamingEditIntervalMs: 0,
    ...extra,
  });
}

const plainTurn = [
  { type: 'text_delta' as const, text: 'the answer' },
  { type: 'done' as const, text: 'the answer', turnCount: 1 },
];

// ---------------------------------------------------------------------------
// Each covered path records an obligation
// ---------------------------------------------------------------------------

describe('Gateway — the four covered reply paths each record an obligation', () => {
  let store: SQLiteDeliveryLedger;
  beforeEach(() => {
    store = ledger();
  });

  it('1. non-streaming final reply', async () => {
    const gw = gatewayWith(loopYielding(plainTurn), store);
    const adapter = stubAdapter();
    await gw.handleMessage(msg(), adapter);

    const rows = await store.listPending(['bot-a']);
    expect(rows).toHaveLength(0); // confirmed, so nothing pending
    expect(adapter.sent.at(-1)?.message.text).toBe('the answer');
  });

  it('2. errored / interrupted final reply', async () => {
    const gw = gatewayWith(
      loopYielding([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'model exploded', code: 'provider_error' },
      ]),
      store,
    );
    // Adapter refuses, so the obligation for the interruption notice survives.
    const adapter = stubAdapter({ ok: false });
    await gw.handleMessage(msg(), adapter);

    const rows = await store.listPending(['bot-a']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain('Response interrupted: model exploded');
  });

  it('3. hook-claimed (gateway_message) reply', async () => {
    const loop = loopYielding(plainTurn);
    loop.hooks.registerClaiming('gateway_message', async () => ({
      handled: true,
      reply: 'claimed answer',
    }));
    const gw = gatewayWith(loop, store);
    const adapter = stubAdapter({ ok: false });

    await gw.handleMessage(msg({ text: '/ping' }), adapter);

    expect(loop.run).not.toHaveBeenCalled();
    const rows = await store.listPending(['bot-a']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('claimed answer');
  });

  it('4. streaming terminal edit', async () => {
    // Throttle intermediate edits hard so the ONLY editMessage call is the
    // terminal one in finalize() — the call the obligation wraps.
    const gw = gatewayWith(
      loopYielding([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'done', text: 'Hello world', turnCount: 1 },
      ]),
      store,
      { streamingEditIntervalMs: 600_000 },
    );
    // The first chunk sends fine; the TERMINAL edit fails, so its obligation
    // must survive as pending.
    const adapter = editAdapter({ editOk: false });
    await gw.handleMessage(msg(), adapter);

    expect(adapter.edits).toHaveLength(1);
    expect(adapter.edits[0]?.text).toBe('Hello world');
    const rows = await store.listPending(['bot-a']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('Hello world');
  });

  it('4b. a streaming terminal edit that lands is confirmed, not left pending', async () => {
    const gw = gatewayWith(
      loopYielding([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'done', text: 'Hello world', turnCount: 1 },
      ]),
      store,
      { streamingEditIntervalMs: 600_000 },
    );
    const adapter = editAdapter();
    await gw.handleMessage(msg(), adapter);

    expect(adapter.edits).toHaveLength(1);
    expect(adapter.edits[0]?.text).toBe('Hello world');
    expect(await store.listPending(['bot-a'])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Confirmation semantics
// ---------------------------------------------------------------------------

describe('Gateway — { ok: false } is never delivered', () => {
  it('an unconfirmed send leaves the row pending and is redelivered', async () => {
    const store = ledger();
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith(loopYielding(plainTurn), store);

    await gw.handleMessage(msg(), failing);
    // This is the case that would be marked `delivered` under a
    // "resolved without throwing" definition of confirmed.
    const pending = await store.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');

    // Next boot: the adapter is healthy again.
    const healthy = stubAdapter();
    const rebooted = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', healthy]]),
    });
    expect(await rebooted.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(healthy.sent.map((s) => s.message.text)).toEqual(['the answer']);
  });

  it('a throwing adapter is treated exactly like { ok: false }', async () => {
    const store = ledger();
    const thrower = stubAdapter();
    vi.mocked(thrower.send).mockRejectedValue(new Error('socket hangup'));
    const gw = gatewayWith(loopYielding(plainTurn), store);

    await gw.handleMessage(msg(), thrower);
    expect(await store.listPending(['bot-a'])).toHaveLength(1);
  });

  it('a confirmed reply is not redelivered', async () => {
    const store = ledger();
    const adapter = stubAdapter();
    const gw = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', adapter]]),
    });

    await gw.handleMessage(msg(), adapter);
    expect(adapter.sent).toHaveLength(1);

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
    expect(adapter.sent).toHaveLength(1);
  });

  it('redelivers exactly once — a second sweep is a no-op', async () => {
    const store = ledger();
    await store.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 'telegram:bot-a:chat-1',
      content: 'lost reply',
    });
    const adapter = stubAdapter();
    const gw = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', adapter]]),
    });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
    expect(adapter.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dedup interaction
// ---------------------------------------------------------------------------

describe('Gateway — redelivery vs. the outbound dedup cache', () => {
  it('reaches the adapter even with the cache warm for the same (sessionId, content)', async () => {
    const store = ledger();
    const failing = stubAdapter({ ok: false });
    const healthy = stubAdapter();
    // One gateway: its turn runs through `failing` (stamping the dedup cache
    // via shouldSend), its sweep runs through the registry's `healthy`.
    const gw = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', healthy]]),
      outboundDedupTtlMs: 600_000, // long TTL: the cache stays warm
    });

    await gw.handleMessage(msg(), failing);
    expect(await store.listPending(['bot-a'])).toHaveLength(1);

    // The cache is warm for exactly this (sessionId, content). A redelivery
    // that went through shouldSend() would be silently swallowed here.
    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(healthy.sent.map((s) => s.message.text)).toEqual(['the answer']);
  });

  it('after redelivery a genuine duplicate within the TTL IS suppressed', async () => {
    const store = ledger();
    const failing = stubAdapter({ ok: false });
    const gw1 = gatewayWith(loopYielding(plainTurn), store, { outboundDedupTtlMs: 600_000 });
    await gw1.handleMessage(msg(), failing);
    expect(await store.listPending(['bot-a'])).toHaveLength(1);

    // A fresh process with a COLD cache redelivers, then record()s.
    const adapter = stubAdapter();
    const gw2 = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', adapter]]),
      outboundDedupTtlMs: 600_000,
    });
    expect(await gw2.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(adapter.sent).toHaveLength(1);

    // A genuine duplicate of the same content on the same session is now
    // suppressed before it reaches the adapter — proof record() ran.
    await gw2.handleMessage(msg(), adapter);
    expect(adapter.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Thread restoration
//
// The lane key is `${platform}:${botKey}:${chatId}[:${threadId}]` — a chat and
// a thread inside it are different conversations. A redelivery that drops the
// thread lands the resurrected answer in the root channel: right audience,
// wrong place, and stripped of the context that made it legible. On Slack and
// Telegram-with-topics that is what a user actually sees.
// ---------------------------------------------------------------------------

describe('Gateway — redelivery returns to the original thread', () => {
  it('a threaded non-streaming reply redelivers into that thread', async () => {
    const store = ledger();
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith(loopYielding(plainTurn), store);

    await gw.handleMessage(msg({ threadId: 'thread-7' }), failing);
    const pending = await store.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.threadId).toBe('thread-7');

    const healthy = stubAdapter();
    const rebooted = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', healthy]]),
    });
    expect(await rebooted.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(healthy.sent).toHaveLength(1);
    expect(healthy.sent[0]?.message.text).toBe('the answer');
    expect(healthy.sent[0]?.message.threadId).toBe('thread-7');
  });

  it('an unthreaded reply redelivers to the root chat with threadId undefined', async () => {
    const store = ledger();
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith(loopYielding(plainTurn), store);

    await gw.handleMessage(msg(), failing);
    const healthy = stubAdapter();
    const rebooted = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', healthy]]),
    });
    await rebooted.sweepPendingDeliveries();

    // Undefined — not '' and not the string 'null', either of which an adapter
    // would forward to the platform verbatim.
    expect(healthy.sent[0]?.message.threadId).toBeUndefined();
    expect(healthy.sent[0]?.message.threadId).not.toBe('null');
    expect(healthy.sent[0]?.message.threadId).not.toBe('');
  });

  it('an empty-string inbound threadId is not resurrected as a thread', async () => {
    const store = ledger();
    const failing = stubAdapter({ ok: false });
    const gw = gatewayWith(loopYielding(plainTurn), store);

    await gw.handleMessage(msg({ threadId: '' }), failing);
    expect((await store.listPending(['bot-a']))[0]?.threadId).toBeUndefined();
  });

  it('a threaded errored / interrupted notice redelivers into that thread', async () => {
    const store = ledger();
    const gw = gatewayWith(
      loopYielding([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'model exploded', code: 'provider_error' },
      ]),
      store,
    );
    await gw.handleMessage(msg({ threadId: 'thread-9' }), stubAdapter({ ok: false }));

    const healthy = stubAdapter();
    const rebooted = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', healthy]]),
    });
    await rebooted.sweepPendingDeliveries();
    expect(healthy.sent[0]?.message.text).toContain('Response interrupted');
    expect(healthy.sent[0]?.message.threadId).toBe('thread-9');
  });

  it('a threaded hook-claimed reply redelivers into that thread', async () => {
    const store = ledger();
    const loop = loopYielding(plainTurn);
    loop.hooks.registerClaiming('gateway_message', async () => ({
      handled: true,
      reply: 'claimed answer',
    }));
    const gw = gatewayWith(loop, store);
    await gw.handleMessage(
      msg({ text: '/ping', threadId: 'thread-3' }),
      stubAdapter({ ok: false }),
    );

    const healthy = stubAdapter();
    const rebooted = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', healthy]]),
    });
    await rebooted.sweepPendingDeliveries();
    expect(healthy.sent[0]?.message.text).toBe('claimed answer');
    expect(healthy.sent[0]?.message.threadId).toBe('thread-3');
  });

  it('a threaded streaming terminal edit redelivers into that thread as a fresh send', async () => {
    const store = ledger();
    const gw = gatewayWith(
      loopYielding([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'done', text: 'Hello world', turnCount: 1 },
      ]),
      store,
      { streamingEditIntervalMs: 600_000 },
    );
    // The draft send lands in the thread; the TERMINAL edit fails, so its
    // obligation survives — and must carry the thread the draft went to.
    await gw.handleMessage(msg({ threadId: 'thread-5' }), editAdapter({ editOk: false }));

    const pending = await store.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.threadId).toBe('thread-5');

    // The draft message id does not survive a restart, so redelivery is a
    // fresh send() — which is exactly why it needs the thread.
    const healthy = stubAdapter();
    const rebooted = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', healthy]]),
    });
    await rebooted.sweepPendingDeliveries();
    expect(healthy.sent[0]?.message.text).toBe('Hello world');
    expect(healthy.sent[0]?.message.threadId).toBe('thread-5');
  });

  it('a row written by v1 code (no thread) still redelivers, to the root chat', async () => {
    const store = ledger();
    await store.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 'telegram:bot-a:chat-1',
      content: 'pre-migration reply',
    });
    const adapter = stubAdapter();
    const gw = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', adapter]]),
    });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(adapter.sent[0]?.message.text).toBe('pre-migration reply');
    expect(adapter.sent[0]?.message.threadId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('Gateway — ownership-checked redelivery', () => {
  it('a process with bots {A, B} leaves a bot-C obligation untouched', async () => {
    const store = ledger();
    const mine = await store.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 's',
      content: 'mine',
    });
    const theirs = await store.record({
      botKey: 'bot-c',
      platform: 'telegram',
      chatId: 'chat-9',
      sessionId: 's',
      content: 'someone else deployment',
    });

    const adapter = stubAdapter();
    const gw = gatewayWith(
      loopYielding(plainTurn),
      store,
      { adapters: new Map([['telegram', adapter]]) },
      ['bot-a', 'bot-b'],
    );

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });
    expect(adapter.sent.map((s) => s.message.text)).toEqual(['mine']);
    expect((await store.get(mine))?.status).toBe('delivered');
    expect((await store.get(theirs))?.status).toBe('pending');
  });

  it('two concurrent sweeps over one ledger deliver each obligation exactly once', async () => {
    const store = ledger();
    for (const content of ['one', 'two', 'three']) {
      await store.record({
        botKey: 'bot-a',
        platform: 'telegram',
        chatId: 'chat-1',
        sessionId: 's',
        content,
      });
    }

    const a = stubAdapter();
    const b = stubAdapter();
    const gwA = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', a]]),
    });
    const gwB = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', b]]),
    });

    const [resA, resB] = await Promise.all([
      gwA.sweepPendingDeliveries(),
      gwB.sweepPendingDeliveries(),
    ]);

    expect(resA.redelivered + resB.redelivered).toBe(3);
    const all = [...a.sent, ...b.sent].map((s) => s.message.text).sort();
    expect(all).toEqual(['one', 'three', 'two']);
    expect(await store.listPending(['bot-a'])).toHaveLength(0);
  });

  it('an obligation whose platform has no adapter here is released, not burned', async () => {
    const store = ledger();
    const id = await store.record({
      botKey: 'bot-a',
      platform: 'discord',
      chatId: 'chat-1',
      sessionId: 's',
      content: 'for a platform this process does not run',
    });
    const gw = gatewayWith(loopYielding(plainTurn), store, {
      adapters: new Map([['telegram', stubAdapter()]]),
    });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 1 });
    expect((await store.get(id))?.status).toBe('pending');
  });

  it('no ledger wired → sweeping is a no-op and replies still flow', async () => {
    const adapter = stubAdapter();
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: loopYielding(plainTurn) as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      clarifySweepIntervalMs: 0,
    });
    await gw.handleMessage(msg(), adapter);
    expect(adapter.sent).toHaveLength(1);
    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 0 });
  });
});
