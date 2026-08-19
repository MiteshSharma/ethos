// TelegramClarifySurface — integration-style tests that exercise the surface
// against a real ClarifyBridge + FileClarifyStore (in-memory storage) and a
// stub Telegram adapter implementing the structural shape the surface uses.

import { ClarifyBridge, FileClarifyStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifyResponse, InboundMessage, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type SessionRoutingForClarify, TelegramClarifySurface } from '../clarify-surface';
import type { CallbackQueryEvent } from '../index';

const BOT_KEY = 'tg-key';

interface SentInline {
  chatId: string;
  text: string;
  rows: { label: string; data: string }[][];
}
interface SentForceReply {
  chatId: string;
  text: string;
}
interface EditCall {
  chatId: string;
  messageId: string;
  text: string;
}

function makeFakeAdapter(initialMessageId = 'msg-1') {
  const sentInline: SentInline[] = [];
  const sentForceReply: SentForceReply[] = [];
  const edits: EditCall[] = [];
  let cqHandler: ((evt: CallbackQueryEvent) => void) | null = null;
  let nextMessageId = initialMessageId;

  return {
    botKey: BOT_KEY,
    id: `telegram:${BOT_KEY}`,
    sentInline,
    sentForceReply,
    edits,
    fireCallback(evt: CallbackQueryEvent): void {
      cqHandler?.(evt);
    },
    setNextMessageId(id: string): void {
      nextMessageId = id;
    },
    async sendInlineKeyboard(chatId: string, text: string, rows: SentInline['rows']) {
      sentInline.push({ chatId, text, rows });
      return { ok: true as const, messageId: nextMessageId };
    },
    async sendForceReply(chatId: string, text: string) {
      sentForceReply.push({ chatId, text });
      return { ok: true as const, messageId: nextMessageId };
    },
    async editToPlainText(chatId: string, messageId: string, text: string) {
      edits.push({ chatId, messageId, text });
      return { ok: true as const, messageId };
    },
    onCallbackQuery(handler: (evt: CallbackQueryEvent) => void): void {
      cqHandler = handler;
    },
  };
}

function makeRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    surfaceType: 'telegram',
    surfaceContext: {},
    question: 'Which database?',
    answerableBy: 'anyone',
    createdAt: '2026-05-15T00:00:00.000Z',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    ...overrides,
  };
}

interface Harness {
  adapter: ReturnType<typeof makeFakeAdapter>;
  bridge: ClarifyBridge;
  store: FileClarifyStore;
  surface: TelegramClarifySurface;
  routing: Map<string, SessionRoutingForClarify>;
}

function makeHarness(): Harness {
  const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
  const bridge = new ClarifyBridge(store);
  const adapter = makeFakeAdapter();
  const routing = new Map<string, SessionRoutingForClarify>();
  routing.set('sess-1', { chatId: 'chat-1', requesterUserId: 'user-A' });
  const surface = new TelegramClarifySurface({
    adapter,
    bridge,
    store,
    getSessionRouting: (id) => routing.get(id),
  });
  return { adapter, bridge, store, surface, routing };
}

function fakeCallback(
  overrides: Partial<CallbackQueryEvent> & { data: string },
): CallbackQueryEvent {
  const answered: { text?: string }[] = [];
  return {
    queryId: 'q1',
    chatId: 'chat-1',
    messageId: 'msg-1',
    userId: 'user-A',
    username: 'alice',
    answer: async (text) => {
      answered.push(text !== undefined ? { text } : {});
    },
    ...overrides,
    // Preserve the spy on answer if the override didn't replace it.
    ...(overrides.answer ? {} : {}),
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: BOT_KEY,
    chatId: 'chat-1',
    userId: 'user-A',
    text: '',
    isDm: true,
    isGroupMention: false,
    messageId: 'inbound-1',
    raw: undefined,
    ...overrides,
  };
}

describe('TelegramClarifySurface — present()', () => {
  it('sends an inline keyboard for options and writes messageId back to the row', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow({ options: ['postgres', 'sqlite', 'mysql'], default: 'postgres' });
    await store.add(row);

    adapter.setNextMessageId('tg-99');
    await surface.present(row);

    expect(adapter.sentInline).toHaveLength(1);
    expect(adapter.sentInline[0]).toMatchObject({ chatId: 'chat-1' });
    // Two-column layout: rows are [[a,b],[c]] + cancel row.
    const rows = adapter.sentInline[0]?.rows ?? [];
    expect(rows.map((r) => r.map((b) => b.label))).toEqual([
      ['postgres', 'sqlite'],
      ['mysql'],
      ['Cancel'],
    ]);
    // Button data carries requestId so post-restart taps still correlate.
    expect(rows[0]?.[0]?.data).toBe(`clr:${row.requestId}:0`);

    const persisted = await store.get(row.requestId);
    expect(persisted?.surfaceContext).toMatchObject({
      chatId: 'chat-1',
      botKey: BOT_KEY,
      messageId: 'tg-99',
      originatorUserId: 'user-A',
    });
  });

  it('sends a force-reply prompt when no options are given', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow({ requestId: 'req-2' });
    await store.add(row);

    await surface.present(row);

    expect(adapter.sentInline).toHaveLength(0);
    expect(adapter.sentForceReply).toHaveLength(1);
    expect(adapter.sentForceReply[0]?.chatId).toBe('chat-1');
  });

  it('is a no-op for non-telegram rows', async () => {
    const { adapter, surface } = makeHarness();
    await surface.present(makeRow({ surfaceType: 'cli' }));
    expect(adapter.sentInline).toHaveLength(0);
    expect(adapter.sentForceReply).toHaveLength(0);
  });

  it('skips silently when the session has no routing (turn will time out)', async () => {
    const { adapter, routing, surface } = makeHarness();
    routing.clear();
    await surface.present(makeRow({ options: ['a', 'b'] }));
    expect(adapter.sentInline).toHaveLength(0);
  });
});

describe('TelegramClarifySurface — handleCallback (button taps)', () => {
  it('resolves the clarify with the chosen option', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['postgres', 'sqlite'],
      surfaceContext: {
        chatId: 'chat-1',
        botKey: BOT_KEY,
        messageId: 'msg-1',
        originatorUserId: 'user-A',
      },
    });
    await store.add(row);

    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface; // wired in constructor

    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:1` }));
    await new Promise((r) => setImmediate(r));

    expect(resolved).toMatchObject({ answer: 'sqlite', source: 'user' });
    // Fix 2 (pi-delegation.md §1b) — this row was never `request()`-ed on
    // THIS bridge instance (added straight to the store, mirroring a
    // cross-process answer), so `respond()` hits the no-local-entry branch:
    // it marks the row answered rather than deleting it, so a genuinely
    // live owner in a different process could still read the answer. It is
    // no longer removed outright.
    expect((await store.get(row.requestId))?.answer).toMatchObject({
      answer: 'sqlite',
      source: 'user',
    });
  });

  it('honours answerable_by=originator and rejects non-originator taps', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['yes', 'no'],
      answerableBy: 'originator',
      surfaceContext: {
        chatId: 'chat-1',
        botKey: BOT_KEY,
        messageId: 'msg-1',
        originatorUserId: 'user-A',
      },
    });
    await store.add(row);

    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    // Bystander taps — must be rejected, row stays pending.
    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:0`, userId: 'user-B' }));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
    expect(await store.get(row.requestId)).not.toBeNull();

    // Originator taps — accepted.
    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:0`, userId: 'user-A' }));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'yes', source: 'user' });
  });

  it('handles cancel button taps', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a', 'b'],
      surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'msg-1' },
    });
    await store.add(row);

    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:cancel` }));
    await new Promise((r) => setImmediate(r));

    expect(resolved).toMatchObject({ source: 'cancel' });
  });

  it('silently dismisses unparseable callback data', async () => {
    const { adapter, surface } = makeHarness();
    void surface;
    // Should not throw and should not touch the bridge.
    expect(() => adapter.fireCallback(fakeCallback({ data: 'garbage' }))).not.toThrow();
  });

  it('rejects a callback whose chatId/messageId/botKey does not match the stored row', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a', 'b'],
      surfaceContext: {
        chatId: 'chat-1',
        botKey: BOT_KEY,
        messageId: 'msg-1',
        originatorUserId: 'user-A',
      },
    });
    await store.add(row);

    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    // Wrong chat — must not resolve.
    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:0`, chatId: 'chat-other' }));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
    expect(await store.get(row.requestId)).not.toBeNull();

    // Wrong messageId (stale / replayed callback) — must not resolve.
    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:0`, messageId: 'msg-other' }));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
    expect(await store.get(row.requestId)).not.toBeNull();

    // Matching everything — accepted.
    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:0` }));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'a', source: 'user' });
  });

  it('refuses an out-of-range choice index instead of resolving with empty string', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a', 'b'],
      surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'msg-1' },
    });
    await store.add(row);

    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireCallback(fakeCallback({ data: `clr:${row.requestId}:99` }));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
    expect(await store.get(row.requestId)).not.toBeNull();
  });
});

describe('TelegramClarifySurface — correlateMessage (force-reply + /cancel)', () => {
  it('correlates a force-reply by replyToId + chatId', async () => {
    const { surface, store } = makeHarness();
    const row = makeRow({
      surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'prompt-77' },
    });
    await store.add(row);

    const res = await surface.correlateMessage(
      inbound({ replyToId: 'prompt-77', text: 'free-form answer' }),
    );
    expect(res).toEqual({
      requestId: row.requestId,
      answer: 'free-form answer',
      source: 'user',
    });
  });

  it('returns null for replies to unrelated messages', async () => {
    const { surface, store } = makeHarness();
    await store.add(
      makeRow({
        surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'prompt-77' },
      }),
    );
    const res = await surface.correlateMessage(inbound({ replyToId: 'something-else' }));
    expect(res).toBeNull();
  });

  it('handles `/cancel` slash without a requestId — cancels any pending in the chat', async () => {
    const { surface, store } = makeHarness();
    const row = makeRow({
      surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'prompt-77' },
    });
    await store.add(row);

    const res = await surface.correlateMessage(inbound({ text: '/cancel' }));
    expect(res).toEqual({ requestId: row.requestId, answer: '', source: 'cancel' });
  });

  it('handles `/cancel <requestId>` — only matches that row', async () => {
    const { surface, store } = makeHarness();
    await store.add(
      makeRow({
        requestId: 'req-a',
        surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'p1' },
      }),
    );
    await store.add(
      makeRow({
        requestId: 'req-b',
        sessionId: 'sess-2',
        surfaceContext: { chatId: 'chat-2', botKey: BOT_KEY, messageId: 'p2' },
      }),
    );
    const res = await surface.correlateMessage(inbound({ text: '/cancel req-b' }));
    // req-b is in chat-2, not chat-1 — won't match an inbound from chat-1.
    expect(res).toBeNull();

    const res2 = await surface.correlateMessage(
      inbound({ chatId: 'chat-2', text: '/cancel req-b' }),
    );
    expect(res2?.requestId).toBe('req-b');
  });

  it('ignores messages from a different botKey (multi-bot routing)', async () => {
    const { surface, store } = makeHarness();
    await store.add(
      makeRow({
        surfaceContext: { chatId: 'chat-1', botKey: 'other-bot', messageId: 'prompt-77' },
      }),
    );
    const res = await surface.correlateMessage(inbound({ replyToId: 'prompt-77' }));
    expect(res).toBeNull();
  });
});

describe('TelegramClarifySurface — onResolved edits the prompt in place', () => {
  it('edits the message with the chosen answer on user response', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['postgres', 'sqlite'],
      surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'msg-1' },
    });
    await store.add(row);
    void surface;

    // Degraded-mode respond — no in-memory entry — still fires onResolved.
    await bridge.respond({ requestId: row.requestId, answer: 'postgres', source: 'user' });

    expect(adapter.edits).toHaveLength(1);
    expect(adapter.edits[0]?.text).toContain('postgres');
    expect(adapter.edits[0]?.messageId).toBe('msg-1');
  });

  it('edits the message with a "(cancelled)" body on cancel', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'msg-1' },
    });
    await store.add(row);
    void surface;

    await bridge.respond({ requestId: row.requestId, answer: '', source: 'cancel' });
    expect(adapter.edits[0]?.text).toMatch(/cancelled/i);
  });

  it('edits with the default value on timeout-default via sweep', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        default: 'postgres',
        defaultDeadlineAt: '2026-05-15T00:00:00.000Z',
        surfaceContext: { chatId: 'chat-1', botKey: BOT_KEY, messageId: 'msg-1' },
      }),
    );
    void surface;

    await bridge.sweep(new Date('2026-05-15T01:00:00.000Z'));
    expect(adapter.edits[0]?.text).toMatch(/timed out.*postgres/);
  });

  it('does not edit rows from a different botKey', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        surfaceContext: { chatId: 'chat-1', botKey: 'other-bot', messageId: 'msg-9' },
      }),
    );
    void surface;
    await bridge.respond({ requestId: 'req-1', answer: 'x', source: 'user' });
    expect(adapter.edits).toHaveLength(0);
  });
});
