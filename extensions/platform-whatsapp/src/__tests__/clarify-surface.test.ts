// WhatsAppClarifySurface — integration-style tests against a real
// ClarifyBridge + FileClarifyStore (in-memory storage) and a stub WhatsApp
// adapter implementing the structural shape the surface uses. Mirrors
// extensions/platform-telegram/src/__tests__/clarify-surface.test.ts.

import { ClarifyBridge, FileClarifyStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { InboundMessage, OutboundMessage, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type SessionRoutingForClarify, WhatsAppClarifySurface } from '../clarify-surface';

const BOT_KEY = 'wa-key';

interface Sent {
  chatId: string;
  text: string;
}

function makeFakeAdapter(ok = true) {
  const sent: Sent[] = [];
  return {
    botKey: BOT_KEY,
    sent,
    async send(chatId: string, message: OutboundMessage) {
      sent.push({ chatId, text: message.text });
      return ok ? { ok: true, messageId: 'wa-99' } : { ok: false, error: 'Not connected' };
    },
  };
}

function makeRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    surfaceType: 'whatsapp',
    surfaceContext: {},
    question: 'Which database?',
    answerableBy: 'anyone',
    createdAt: '2026-05-15T00:00:00.000Z',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    ...overrides,
  };
}

function makeHarness(adapterOk = true) {
  const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
  const bridge = new ClarifyBridge(store);
  const adapter = makeFakeAdapter(adapterOk);
  const routing = new Map<string, SessionRoutingForClarify>();
  routing.set('sess-1', { chatId: '123@s.whatsapp.net', requesterUserId: 'user-A' });
  const surface = new WhatsAppClarifySurface({
    adapter,
    bridge,
    store,
    getSessionRouting: (id) => routing.get(id),
  });
  return { adapter, bridge, store, surface, routing };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'whatsapp',
    botKey: BOT_KEY,
    chatId: '123@s.whatsapp.net',
    userId: 'user-A',
    text: '',
    isDm: true,
    isGroupMention: false,
    messageId: 'inbound-1',
    raw: undefined,
    ...overrides,
  };
}

/** A row as it exists *after* present() stamped its correlation context. */
function presentedRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return makeRow({
    surfaceContext: {
      chatId: '123@s.whatsapp.net',
      botKey: BOT_KEY,
      originatorUserId: 'user-A',
    },
    ...overrides,
  });
}

describe('WhatsAppClarifySurface — present()', () => {
  it('sends a numbered prompt for a small option set (the button-card threshold)', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow({ options: ['postgres', 'sqlite', 'mysql'], default: 'postgres' });
    await store.add(row);

    await surface.present(row);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.chatId).toBe('123@s.whatsapp.net');
    const text = adapter.sent[0]?.text ?? '';
    expect(text).toContain('Which database?');
    expect(text).toContain('default in 15m: postgres');
    expect(text).toContain('1. postgres');
    expect(text).toContain('2. sqlite');
    expect(text).toContain('3. mysql');
    expect(text).toContain('Reply with the number of your choice.');
  });

  it('uses the same numbered prompt above the threshold — WhatsApp has no list transport', async () => {
    const { adapter, store, surface } = makeHarness();
    const options = ['a', 'b', 'c', 'd', 'e'];
    const row = makeRow({ options });
    await store.add(row);

    await surface.present(row);

    const text = adapter.sent[0]?.text ?? '';
    for (const [i, label] of options.entries()) {
      expect(text).toContain(`${i + 1}. ${label}`);
    }
    expect(text).toContain('Reply with the number of your choice.');
  });

  it('writes the chat + originator back into the persisted row', async () => {
    const { store, surface } = makeHarness();
    const row = makeRow({ options: ['yes', 'no'] });
    await store.add(row);

    await surface.present(row);

    const persisted = await store.get(row.requestId);
    expect(persisted?.surfaceContext).toMatchObject({
      chatId: '123@s.whatsapp.net',
      botKey: BOT_KEY,
      originatorUserId: 'user-A',
    });
  });

  it('sends the bare question when no options are given', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow();
    await store.add(row);

    await surface.present(row);

    const text = adapter.sent[0]?.text ?? '';
    expect(text).toContain('Which database?');
    expect(text).not.toContain('Reply with the number of your choice.');
  });

  it('is a no-op for non-whatsapp rows', async () => {
    const { adapter, surface } = makeHarness();
    await surface.present(makeRow({ surfaceType: 'cli' }));
    expect(adapter.sent).toHaveLength(0);
  });

  it('skips silently when the session has no routing (turn will time out)', async () => {
    const { adapter, routing, surface } = makeHarness();
    routing.clear();
    await surface.present(makeRow({ options: ['a', 'b'] }));
    expect(adapter.sent).toHaveLength(0);
  });

  it('leaves surfaceContext untouched when the send fails', async () => {
    const { store, surface } = makeHarness(false);
    const row = makeRow({ options: ['a'] });
    await store.add(row);

    await surface.present(row);

    const persisted = await store.get(row.requestId);
    expect(persisted?.surfaceContext).toEqual({});
  });
});

describe('WhatsAppClarifySurface — correlateMessage (numbered replies)', () => {
  it('resolves the clarify with the numbered choice', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow({ options: ['postgres', 'sqlite'] }));

    const resp = await surface.correlateMessage(inbound({ text: '2' }));

    expect(resp).toEqual({ requestId: 'req-1', answer: 'sqlite', source: 'user' });
  });

  it('resolves the clarify when the label is typed verbatim', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow({ options: ['postgres', 'sqlite'] }));

    const resp = await surface.correlateMessage(inbound({ text: 'SQLite' }));

    expect(resp).toEqual({ requestId: 'req-1', answer: 'sqlite', source: 'user' });
  });

  it('unblocks the pending clarify tool through the bridge', async () => {
    const { adapter, bridge, surface } = makeHarness();
    const pending = bridge.request({
      question: 'Which database?',
      options: ['postgres', 'sqlite'],
      timeoutMs: 60_000,
      answerableBy: 'anyone',
      sessionId: 'sess-1',
      surfaceType: 'whatsapp',
    });
    // Let present() finish so the row carries its correlation context.
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.sent).toHaveLength(1);

    const resp = await surface.correlateMessage(inbound({ text: '1' }));
    expect(resp).not.toBeNull();
    if (resp) await bridge.respond(resp);

    await expect(pending).resolves.toMatchObject({ answer: 'postgres', source: 'user' });
  });

  it('takes free-form text as the answer when the row has no options', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow());

    const resp = await surface.correlateMessage(inbound({ text: 'use duckdb' }));

    expect(resp).toEqual({ requestId: 'req-1', answer: 'use duckdb', source: 'user' });
  });

  it('cancels on /cancel', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow({ options: ['postgres', 'sqlite'] }));

    const resp = await surface.correlateMessage(inbound({ text: '/cancel' }));

    expect(resp).toEqual({ requestId: 'req-1', answer: '', source: 'cancel' });
  });

  it('ignores unrelated prose so it flows on as a normal message', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow({ options: ['postgres', 'sqlite'] }));

    expect(await surface.correlateMessage(inbound({ text: 'what time is it?' }))).toBeNull();
  });

  it('ignores an out-of-range choice number', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow({ options: ['postgres', 'sqlite'] }));

    expect(await surface.correlateMessage(inbound({ text: '7' }))).toBeNull();
    expect(await surface.correlateMessage(inbound({ text: '0' }))).toBeNull();
  });

  it('ignores messages from another chat or another bot', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow({ options: ['postgres', 'sqlite'] }));

    expect(await surface.correlateMessage(inbound({ text: '1', chatId: '999@g.us' }))).toBeNull();
    expect(await surface.correlateMessage(inbound({ text: '1', botKey: 'other' }))).toBeNull();
    expect(await surface.correlateMessage(inbound({ text: '1', platform: 'telegram' }))).toBeNull();
  });

  it('refuses a non-originator answer when answerableBy is originator', async () => {
    const { store, surface } = makeHarness();
    await store.add(presentedRow({ options: ['postgres', 'sqlite'], answerableBy: 'originator' }));

    expect(await surface.correlateMessage(inbound({ text: '1', userId: 'user-B' }))).toBeNull();
    expect(await surface.correlateMessage(inbound({ text: '1', userId: 'user-A' }))).toEqual({
      requestId: 'req-1',
      answer: 'postgres',
      source: 'user',
    });
  });

  it('returns null when no clarify is pending', async () => {
    const { surface } = makeHarness();
    expect(await surface.correlateMessage(inbound({ text: '1' }))).toBeNull();
  });
});

// D3 — a `browser_takeover` cannot be answered on WhatsApp: the browser is open
// on the machine running Ethos and the hand-back button lives in the web chat.
//
// This suite used to assert only the rendered text while carrying that name,
// and never touched `correlateMessage` — which was the whole hole. WhatsApp's
// free-form branch matched ANY message in the chat while a row was pending, so
// a takeover (no `options`, by construction) was handed back by the next
// person to say anything, and `browser_request_takeover` reported that to the
// agent as `handed_back: true`.
//
// Revert `isClarifyAnswerableOn` in `../clarify-surface` and/or the
// `acceptsUserAnswer` gate in `ClarifyBridge.respond()` and the middle three
// tests here fail.
describe('browser takeover (D3)', () => {
  const TAKEOVER = {
    kind: 'browser_takeover' as const,
    question: 'stuck on a login',
    meta: {
      url: 'https://accounts.example.com/signin?flow=2',
      handbackUrl: 'https://ethos.local/chat/sess-1',
    },
  };

  it('presents the text form with the host and the hand-back link', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow(TAKEOVER);
    await store.add(row);

    await surface.present(row);

    const text = adapter.sent[0]?.text ?? '';
    expect(text).toContain('accounts.example.com');
    expect(text).toContain('https://ethos.local/chat/sess-1');
    expect(text).toContain('the browser window is open on the machine running Ethos');
    expect(text.startsWith('stuck on a login')).toBe(false);
    // And it does not invite an answer this chat will refuse.
    expect(text).not.toContain('answer within');
  });

  it('does not resolve on an arbitrary group message while it is pending', async () => {
    const { bridge, store, surface } = makeHarness();
    const resolved: string[] = [];
    bridge.onResolved((_row, resp) => {
      if (resp) resolved.push(resp.source);
    });
    await store.add(presentedRow(TAKEOVER));

    // The real inbound path — any message in the chat, from anyone.
    const res = await surface.correlateMessage(
      inbound({ userId: 'user-B', text: 'ok done, logged in' }),
    );

    // Null, not a refused response: a correlated message is swallowed before
    // the normal pipeline, so an unrelated message must still reach the agent.
    expect(res).toBeNull();
    expect(resolved).toHaveLength(0);
    // Still open, and with no answer recorded on it — not merely un-removed.
    expect((await store.get('req-1'))?.answer).toBeUndefined();
  });

  it('does not resolve even if a response reaches the bridge anyway', async () => {
    const { bridge, store } = makeHarness();
    const resolved: string[] = [];
    bridge.onResolved((_row, resp) => {
      if (resp) resolved.push(resp.source);
    });
    await store.add(presentedRow(TAKEOVER));

    await bridge.respond({ requestId: 'req-1', answer: 'handed back', source: 'user' });

    expect(resolved).toHaveLength(0);
    // Still open, and with no answer recorded on it — not merely un-removed.
    expect((await store.get('req-1'))?.answer).toBeUndefined();
  });

  // The takeover must still RESOLVE, or `browser_request_takeover`'s session
  // lock never clears.
  it('still cancels from the chat', async () => {
    const { bridge, store, surface } = makeHarness();
    const resolved: string[] = [];
    bridge.onResolved((_row, resp) => {
      if (resp) resolved.push(resp.source);
    });
    await store.add(presentedRow(TAKEOVER));

    const res = await surface.correlateMessage(inbound({ text: '/cancel' }));
    expect(res).toEqual({ requestId: 'req-1', answer: '', source: 'cancel' });
    await bridge.respond(res ?? { requestId: 'req-1', answer: '', source: 'user' });
    expect(resolved).toEqual(['cancel']);
    // No live `request()` behind this row in the test, so `respond()` takes its
    // cross-process branch and records the answer instead of removing the row.
    expect((await store.get('req-1'))?.answer?.source).toBe('cancel');
  });

  it('still answers an ordinary free-form question on the same path (control)', async () => {
    const { bridge, store, surface } = makeHarness();
    const resolved: string[] = [];
    bridge.onResolved((_row, resp) => {
      if (resp) resolved.push(resp.source);
    });
    await store.add(presentedRow());

    const res = await surface.correlateMessage(inbound({ text: 'postgres' }));
    expect(res).toEqual({ requestId: 'req-1', answer: 'postgres', source: 'user' });
    await bridge.respond(res ?? { requestId: 'req-1', answer: '', source: 'cancel' });
    expect(resolved).toEqual(['user']);
  });

  it('leaves an ordinary question exactly as it was', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow();
    await store.add(row);
    await surface.present(row);
    expect((adapter.sent[0]?.text ?? '').startsWith('Which database?')).toBe(true);
  });
});
