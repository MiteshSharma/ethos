// Integration-style tests for the Slack clarify surface against a real
// ClarifyBridge + FileClarifyStore (in-memory storage) and a stub Slack
// adapter implementing the structural shape the surface uses.

import { ClarifyBridge, FileClarifyStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifyResponse, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type SessionRoutingForClarify, SlackClarifySurface } from '../clarify-surface';
import type { ClarifyActionEvent, ClarifyModalSubmissionEvent } from '../interactions/clarify';

const BOT_KEY = 'slack-key';

interface PostedCard {
  chatId: string;
  threadId?: string;
  blocks: unknown[];
}
interface UpdatedCard {
  chatId: string;
  messageTs: string;
  blocks: unknown[];
}
interface OpenedModal {
  triggerId: string;
  view: Record<string, unknown>;
}

function makeFakeAdapter(initialTs = 'ts-1') {
  const posted: PostedCard[] = [];
  const updated: UpdatedCard[] = [];
  const modals: OpenedModal[] = [];
  let actionHandler: ((evt: ClarifyActionEvent) => void) | null = null;
  let modalHandler: ((evt: ClarifyModalSubmissionEvent) => void) | null = null;
  let nextTs = initialTs;

  return {
    botKey: BOT_KEY,
    posted,
    updated,
    modals,
    fireAction(evt: ClarifyActionEvent): void {
      actionHandler?.(evt);
    },
    fireModal(evt: ClarifyModalSubmissionEvent): void {
      modalHandler?.(evt);
    },
    setNextTs(ts: string): void {
      nextTs = ts;
    },
    async postClarifyCard(input: PostedCard) {
      posted.push(input);
      return { messageTs: nextTs };
    },
    async updateClarifyCard(input: UpdatedCard) {
      updated.push(input);
      return { ok: true as const };
    },
    async openClarifyModal(input: OpenedModal) {
      modals.push(input);
      return { ok: true as const };
    },
    onClarifyAction(h: (evt: ClarifyActionEvent) => void) {
      actionHandler = h;
    },
    onClarifyModalSubmit(h: (evt: ClarifyModalSubmissionEvent) => void) {
      modalHandler = h;
    },
  };
}

function makeRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    surfaceType: 'slack',
    surfaceContext: {},
    question: 'Which database?',
    answerableBy: 'anyone',
    createdAt: '2026-05-15T00:00:00.000Z',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
    ...overrides,
  };
}

function makeHarness() {
  const store = new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify');
  const bridge = new ClarifyBridge(store);
  const adapter = makeFakeAdapter();
  const routing = new Map<string, SessionRoutingForClarify>();
  routing.set('sess-1', { chatId: 'C1', requesterUserId: 'U-orig' });
  const surface = new SlackClarifySurface({
    adapter,
    bridge,
    store,
    getSessionRouting: (id) => routing.get(id),
  });
  return { adapter, bridge, store, surface, routing };
}

describe('SlackClarifySurface — present()', () => {
  it('posts a card and writes (chatId, botKey, messageTs, originatorUserId) back to the row', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow({ options: ['a', 'b'], default: 'a' });
    await store.add(row);
    adapter.setNextTs('ts-99');
    await surface.present(row);

    expect(adapter.posted).toHaveLength(1);
    expect(adapter.posted[0]?.chatId).toBe('C1');

    const persisted = await store.get(row.requestId);
    expect(persisted?.surfaceContext).toMatchObject({
      chatId: 'C1',
      botKey: BOT_KEY,
      messageTs: 'ts-99',
      originatorUserId: 'U-orig',
    });
  });

  it('passes threadId through when the route has one (Slack thread routing)', async () => {
    const { adapter, store, surface, routing } = makeHarness();
    routing.set('sess-1', { chatId: 'C1', threadId: '111.222', requesterUserId: 'U-orig' });
    await store.add(makeRow({ options: ['a'] }));
    await surface.present(makeRow({ options: ['a'] }));
    expect(adapter.posted[0]?.threadId).toBe('111.222');
  });

  it('is a no-op for non-slack rows', async () => {
    const { adapter, surface } = makeHarness();
    await surface.present(makeRow({ surfaceType: 'cli' }));
    expect(adapter.posted).toHaveLength(0);
  });

  it('skips silently when the session has no routing (turn will time out)', async () => {
    const { adapter, routing, surface } = makeHarness();
    routing.clear();
    await surface.present(makeRow({ options: ['a'] }));
    expect(adapter.posted).toHaveLength(0);
  });
});

describe('SlackClarifySurface — handleAction (button taps)', () => {
  it('resolves the clarify with the chosen option', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['postgres', 'sqlite'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 1,
      userId: 'U1',
      channelId: 'C1',
      messageTs: 'ts-1',
      fromHome: false,
    });
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

  it('rejects clicks whose channel/messageTs/botKey do not match the stored row', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a', 'b'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    // Wrong channel
    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 0,
      userId: 'U1',
      channelId: 'C-other',
      messageTs: 'ts-1',
      fromHome: false,
    });
    // Wrong ts
    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 0,
      userId: 'U1',
      channelId: 'C1',
      messageTs: 'ts-other',
      fromHome: false,
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
    expect(await store.get(row.requestId)).not.toBeNull();
  });

  it('honours answerable_by=originator and rejects bystander clicks', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['yes', 'no'],
      answerableBy: 'originator',
      surfaceContext: {
        chatId: 'C1',
        botKey: BOT_KEY,
        messageTs: 'ts-1',
        originatorUserId: 'U-orig',
      },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    // Bystander
    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 0,
      userId: 'U-stranger',
      channelId: 'C1',
      messageTs: 'ts-1',
      fromHome: false,
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();

    // Originator
    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 0,
      userId: 'U-orig',
      channelId: 'C1',
      messageTs: 'ts-1',
      fromHome: false,
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'yes', source: 'user' });
  });

  it('refuses out-of-range choice index instead of resolving with empty string', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a', 'b'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 99,
      userId: 'U1',
      channelId: 'C1',
      messageTs: 'ts-1',
      fromHome: false,
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
    expect(await store.get(row.requestId)).not.toBeNull();
  });

  it('handles cancel button taps', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireAction({
      kind: 'cancel',
      requestId: row.requestId,
      userId: 'U1',
      channelId: 'C1',
      messageTs: 'ts-1',
      fromHome: false,
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ source: 'cancel' });
  });

  it('resolves Home-tab clicks even though they carry no channel/messageTs', async () => {
    // App Home block_actions payloads have no body.channel and no
    // body.message — the click happened on a per-user view, not a channel
    // message. The surface must still resolve the row (gated by botKey +
    // gateAnswerer); the channel/messageTs cross-tenant gate doesn't apply
    // because Home is intrinsically per-user.
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['postgres', 'sqlite'],
      surfaceContext: {
        chatId: 'C1',
        botKey: BOT_KEY,
        messageTs: 'ts-original',
        originatorUserId: 'U-orig',
      },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 0,
      userId: 'U-orig',
      channelId: '', // Home payloads have no channel
      messageTs: '', // and no messageTs
      fromHome: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'postgres', source: 'user' });
  });

  it('still rejects Home clicks across bots (botKey gate is preserved)', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a'],
      surfaceContext: {
        chatId: 'C1',
        botKey: 'other-bot',
        messageTs: 'ts-1',
      },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;
    adapter.fireAction({
      kind: 'choice',
      requestId: row.requestId,
      choiceIndex: 0,
      userId: 'U1',
      channelId: '',
      messageTs: '',
      fromHome: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
  });

  it('opens a modal for an Answer click on a free-form clarify', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow({
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
    });
    await store.add(row);
    void surface;

    adapter.fireAction({
      kind: 'open-modal',
      requestId: row.requestId,
      userId: 'U1',
      channelId: 'C1',
      messageTs: 'ts-1',
      triggerId: 'TRG',
      fromHome: false,
    });
    await new Promise((r) => setImmediate(r));

    expect(adapter.modals).toHaveLength(1);
    expect(adapter.modals[0]?.triggerId).toBe('TRG');
  });
});

describe('SlackClarifySurface — handleModalSubmit', () => {
  it('resolves with the modal answer and credits the submitter on the resolved card', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireModal({ requestId: row.requestId, answer: 'normalized 3NF', userId: 'U777' });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'normalized 3NF', source: 'user' });

    // The resolved card should credit the submitter via the responderById memo.
    expect(adapter.updated).toHaveLength(1);
    const ctx = adapter.updated[0]?.blocks.find(
      (b: unknown) => (b as { type: string }).type === 'context',
    ) as { elements: Array<{ text: string }> } | undefined;
    expect(ctx?.elements[0]?.text).toContain('<@U777>');
  });

  it('rejects modal submissions for a different botKey', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        surfaceContext: { chatId: 'C1', botKey: 'other-bot', messageTs: 'ts-1' },
      }),
    );
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;
    adapter.fireModal({ requestId: 'req-1', answer: 'x', userId: 'U1' });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
  });
});

describe('SlackClarifySurface — onResolved edits the card in place', () => {
  it('updates with the chosen answer on user response', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['postgres', 'sqlite'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
    });
    await store.add(row);
    void surface;

    await bridge.respond({ requestId: row.requestId, answer: 'postgres', source: 'user' });
    expect(adapter.updated).toHaveLength(1);
    const sections = (adapter.updated[0]?.blocks ?? [])
      .filter((b: unknown) => (b as { type: string }).type === 'section')
      .map((b: unknown) => (b as { text: { text: string } }).text.text);
    expect(sections.some((t: string) => t.includes('postgres'))).toBe(true);
  });

  it('updates with the timeout-default state via sweep', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        default: 'postgres',
        defaultDeadlineAt: '2026-05-15T00:00:00.000Z',
        surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
      }),
    );
    void surface;
    await bridge.sweep(new Date('2026-05-15T01:00:00.000Z'));
    expect(adapter.updated).toHaveLength(1);
    const sections = (adapter.updated[0]?.blocks ?? [])
      .filter((b: unknown) => (b as { type: string }).type === 'section')
      .map((b: unknown) => (b as { text: { text: string } }).text.text);
    expect(sections.some((t: string) => /timed out/.test(t))).toBe(true);
  });

  it('does not update rows from a different botKey', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        surfaceContext: { chatId: 'C1', botKey: 'other-bot', messageTs: 'ts-9' },
      }),
    );
    void surface;
    await bridge.respond({ requestId: 'req-1', answer: 'x', source: 'user' });
    expect(adapter.updated).toHaveLength(0);
  });
});

describe('SlackClarifySurface — listPendingForBot', () => {
  it('returns only this bot rows from the store', async () => {
    const { adapter, store, surface } = makeHarness();
    await store.add(
      makeRow({
        requestId: 'r-mine',
        surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageTs: 'ts-1' },
      }),
    );
    await store.add(
      makeRow({
        requestId: 'r-other',
        sessionId: 'sess-2',
        surfaceContext: { chatId: 'C2', botKey: 'other-bot', messageTs: 'ts-2' },
      }),
    );
    const pending = await surface.listPendingForBot();
    expect(pending.map((r) => r.requestId)).toEqual(['r-mine']);
    void adapter; // wired in constructor
  });
});
