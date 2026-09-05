// Integration-style tests for the Discord clarify surface against a real
// ClarifyBridge + FileClarifyStore (in-memory storage) and a stub Discord
// adapter implementing the structural shape the surface uses.

import { ClarifyBridge, FileClarifyStore } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifyResponse, PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { clarifyModalPayload } from '../clarify-blocks';
import {
  type ClarifyInteractionRaw,
  DiscordClarifySurface,
  type SessionRoutingForClarify,
} from '../clarify-surface';

const BOT_KEY = 'discord-key';

interface PostedCard {
  chatId: string;
  content: string;
  components: unknown[];
}
interface UpdatedCard {
  chatId: string;
  messageId: string;
  content: string;
  components: unknown[];
}
interface OpenedModal {
  interactionId: string;
  interactionToken: string;
  modal: ReturnType<typeof clarifyModalPayload>;
}
interface AckCall {
  interactionId: string;
  kind: 'button' | 'modal';
}

function makeFakeAdapter(initialMessageId = 'msg-1') {
  const posted: PostedCard[] = [];
  const updated: UpdatedCard[] = [];
  const modals: OpenedModal[] = [];
  const acks: AckCall[] = [];
  let handler: ((raw: ClarifyInteractionRaw) => void) | null = null;
  let nextMessageId = initialMessageId;

  return {
    botKey: BOT_KEY,
    posted,
    updated,
    modals,
    acks,
    fireInteraction(raw: ClarifyInteractionRaw): void {
      handler?.(raw);
    },
    setNextMessageId(id: string): void {
      nextMessageId = id;
    },
    async postClarifyCard(input: PostedCard) {
      posted.push(input);
      return { messageId: nextMessageId };
    },
    async updateClarifyCard(input: UpdatedCard) {
      updated.push(input);
      return { ok: true as const };
    },
    async openClarifyModal(input: OpenedModal) {
      modals.push(input);
      return { ok: true as const };
    },
    async ackButtonClick(input: { interactionId: string; interactionToken: string }) {
      acks.push({ interactionId: input.interactionId, kind: 'button' });
    },
    async ackModalSubmit(input: { interactionId: string; interactionToken: string }) {
      acks.push({ interactionId: input.interactionId, kind: 'modal' });
    },
    onClarifyInteraction(h: (raw: ClarifyInteractionRaw) => void) {
      handler = h;
    },
  };
}

function makeRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    surfaceType: 'discord',
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
  const surface = new DiscordClarifySurface({
    adapter,
    bridge,
    store,
    getSessionRouting: (id) => routing.get(id),
  });
  return { adapter, bridge, store, surface, routing };
}

describe('DiscordClarifySurface — present()', () => {
  it('posts a card and writes (chatId, botKey, messageId, originatorUserId) back', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow({ options: ['a', 'b'] });
    await store.add(row);
    adapter.setNextMessageId('disc-99');
    await surface.present(row);

    expect(adapter.posted).toHaveLength(1);
    expect(adapter.posted[0]?.chatId).toBe('C1');
    const persisted = await store.get(row.requestId);
    expect(persisted?.surfaceContext).toMatchObject({
      chatId: 'C1',
      botKey: BOT_KEY,
      messageId: 'disc-99',
      originatorUserId: 'U-orig',
    });
  });

  it('is a no-op for non-discord rows', async () => {
    const { adapter, surface } = makeHarness();
    await surface.present(makeRow({ surfaceType: 'cli' }));
    expect(adapter.posted).toHaveLength(0);
  });
});

describe('DiscordClarifySurface — handleInteraction (buttons)', () => {
  it('resolves with the chosen option and acks the button', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['postgres', 'sqlite'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'choice',
        requestId: row.requestId,
        choiceIndex: 1,
        userId: 'U1',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'sqlite', source: 'user' });
    expect(adapter.acks).toContainEqual({ interactionId: 'I1', kind: 'button' });
  });

  it('rejects clicks whose channel/messageId/botKey do not match the stored row', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a', 'b'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'choice',
        requestId: row.requestId,
        choiceIndex: 0,
        userId: 'U1',
        channelId: 'C-other',
        messageId: 'M1',
      },
    });
    adapter.fireInteraction({
      interactionId: 'I2',
      interactionToken: 'TOK',
      event: {
        kind: 'choice',
        requestId: row.requestId,
        choiceIndex: 0,
        userId: 'U1',
        channelId: 'C1',
        messageId: 'M-other',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
    expect(await store.get(row.requestId)).not.toBeNull();
  });

  it('honours answerable_by=originator', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['yes', 'no'],
      answerableBy: 'originator',
      surfaceContext: {
        chatId: 'C1',
        botKey: BOT_KEY,
        messageId: 'M1',
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
    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'choice',
        requestId: row.requestId,
        choiceIndex: 0,
        userId: 'U-stranger',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();

    // Originator
    adapter.fireInteraction({
      interactionId: 'I2',
      interactionToken: 'TOK',
      event: {
        kind: 'choice',
        requestId: row.requestId,
        choiceIndex: 0,
        userId: 'U-orig',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'yes', source: 'user' });
  });

  it('refuses out-of-range choice index', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a', 'b'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'choice',
        requestId: row.requestId,
        choiceIndex: 99,
        userId: 'U1',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
  });

  it('handles cancel button clicks', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      options: ['a'],
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;
    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'cancel',
        requestId: row.requestId,
        userId: 'U1',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ source: 'cancel' });
  });

  it('opens a modal for an Answer click on a free-form clarify', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow({
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' },
    });
    await store.add(row);
    void surface;
    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'open-modal',
        requestId: row.requestId,
        userId: 'U1',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(adapter.modals).toHaveLength(1);
    expect(adapter.modals[0]?.interactionId).toBe('I1');
  });
});

describe('DiscordClarifySurface — modal submission', () => {
  it('resolves with the modal answer and credits the submitter on the resolved card', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    const row = makeRow({
      surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' },
    });
    await store.add(row);
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    adapter.fireInteraction({
      interactionId: 'I9',
      interactionToken: 'TOK',
      event: {
        kind: 'modal-submit',
        requestId: row.requestId,
        answer: 'normalized 3NF',
        userId: '123456789012345678', // valid snowflake
        channelId: 'C1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toMatchObject({ answer: 'normalized 3NF', source: 'user' });
    expect(adapter.acks).toContainEqual({ interactionId: 'I9', kind: 'modal' });
    expect(adapter.updated).toHaveLength(1);
    expect(adapter.updated[0]?.content).toContain('<@123456789012345678>');
  });

  it('rejects modal submissions for a different botKey', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        surfaceContext: { chatId: 'C1', botKey: 'other-bot', messageId: 'M1' },
      }),
    );
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;
    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'modal-submit',
        requestId: 'req-1',
        answer: 'x',
        userId: 'U1',
        channelId: 'C1',
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull();
  });
});

describe('DiscordClarifySurface — onResolved edits the card in place', () => {
  it('updates with the chosen answer on user response (via timeout-default sweep)', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        default: 'postgres',
        defaultDeadlineAt: '2026-05-15T00:00:00.000Z',
        surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' },
      }),
    );
    void surface;
    await bridge.sweep(new Date('2026-05-15T01:00:00.000Z'));
    expect(adapter.updated).toHaveLength(1);
    expect(adapter.updated[0]?.content).toMatch(/timed out.*postgres/);
    expect(adapter.updated[0]?.components).toEqual([]);
  });

  it('does not update rows from a different botKey', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({
        surfaceContext: { chatId: 'C1', botKey: 'other-bot', messageId: 'M9' },
      }),
    );
    void surface;
    await bridge.respond({ requestId: 'req-1', answer: 'x', source: 'user' });
    expect(adapter.updated).toHaveLength(0);
  });
});

// D3 — a `browser_takeover` cannot be answered on Discord: the browser is open
// on the machine running Ethos and the hand-back button lives in the web chat.
//
// This suite used to assert only the card's TEXT. The card itself contradicted
// it: a takeover carries no `options`, and no options was the free-form shape,
// so the card came with an "Answer" button that opened a text modal and
// resolved the clarify with `source: 'user'` — which
// `browser_request_takeover` reports to the agent as `handed_back: true`.
//
// Revert `answerable` in `../clarify-blocks` / `../clarify-surface` and/or the
// `acceptsUserAnswer` gate in `ClarifyBridge.respond()` and the middle three
// tests here fail.
describe('DiscordClarifySurface — browser takeover (D3)', () => {
  const TAKEOVER = {
    kind: 'browser_takeover' as const,
    question: 'stuck on a login',
    meta: {
      url: 'https://accounts.example.com/signin?flow=2',
      handbackUrl: 'https://ethos.local/chat/sess-1',
    },
  };

  /** Button labels on the posted card, flattened across action rows. */
  function labelsOf(components: unknown[]): string[] {
    const out: string[] = [];
    for (const row of components) {
      if (typeof row !== 'object' || row === null) continue;
      const inner = (row as { components?: unknown[] }).components ?? [];
      for (const btn of inner) {
        const label = (btn as { label?: unknown }).label;
        if (typeof label === 'string') out.push(label);
      }
    }
    return out;
  }

  it('posts the text form with the host and the hand-back link, and no Answer button', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow(TAKEOVER);
    await store.add(row);
    await surface.present(row);

    const card = adapter.posted[0];
    expect(card?.content ?? '').toContain('accounts.example.com');
    expect(card?.content ?? '').toContain('https://ethos.local/chat/sess-1');
    expect(card?.content ?? '').toContain(
      'the browser window is open on the machine running Ethos',
    );
    // Cancel only — giving up is the one thing Discord can do about a browser
    // it cannot see.
    expect(labelsOf(card?.components ?? [])).toEqual(['Cancel']);
    // And the card does not invite an answer it will refuse.
    expect(card?.content ?? '').not.toContain('answer by');
  });

  it('does not resolve when the Answer/modal path is driven anyway', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    await store.add(
      makeRow({ ...TAKEOVER, surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' } }),
    );
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });
    void surface;

    // The real interaction path, end to end: open the modal, submit text.
    adapter.fireInteraction({
      interactionId: 'I1',
      interactionToken: 'TOK',
      event: {
        kind: 'open-modal',
        requestId: 'req-1',
        userId: 'U-orig',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));
    adapter.fireInteraction({
      interactionId: 'I2',
      interactionToken: 'TOK',
      event: {
        kind: 'modal-submit',
        requestId: 'req-1',
        answer: 'ok logged in',
        userId: '123456789012345678',
        channelId: 'C1',
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(resolved).toBeNull();
    expect(adapter.updated).toHaveLength(0);
    // Still open, with no answer recorded on it.
    expect((await store.get('req-1'))?.answer).toBeUndefined();
  });

  it('does not resolve even if a response reaches the bridge anyway', async () => {
    const { bridge, store, surface } = makeHarness();
    void surface;
    await store.add(
      makeRow({ ...TAKEOVER, surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' } }),
    );
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });

    await bridge.respond({ requestId: 'req-1', answer: 'handed back', source: 'user' });

    expect(resolved).toBeNull();
    expect((await store.get('req-1'))?.answer).toBeUndefined();
  });

  // The takeover must still RESOLVE, or `browser_request_takeover`'s session
  // lock never clears — and the card must still edit to the same head.
  it('still cancels from the card, keeping the same head', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    void surface;
    void bridge;
    await store.add(
      makeRow({ ...TAKEOVER, surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' } }),
    );

    adapter.fireInteraction({
      interactionId: 'I3',
      interactionToken: 'TOK',
      event: {
        kind: 'cancel',
        requestId: 'req-1',
        userId: 'U-orig',
        channelId: 'C1',
        messageId: 'M1',
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(adapter.updated).toHaveLength(1);
    expect(adapter.updated[0]?.content).toContain('accounts.example.com');
    expect(adapter.updated[0]?.content).toContain('cancelled');
  });

  it('still answers an ordinary free-form question on the same path (control)', async () => {
    const { adapter, bridge, store, surface } = makeHarness();
    void surface;
    await store.add(
      makeRow({ surfaceContext: { chatId: 'C1', botKey: BOT_KEY, messageId: 'M1' } }),
    );
    let resolved: ClarifyResponse | null = null;
    bridge.onResolved((_r, resp) => {
      resolved = resp;
    });

    adapter.fireInteraction({
      interactionId: 'I4',
      interactionToken: 'TOK',
      event: {
        kind: 'modal-submit',
        requestId: 'req-1',
        answer: 'postgres',
        userId: '123456789012345678',
        channelId: 'C1',
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(resolved).toMatchObject({ answer: 'postgres', source: 'user' });
  });

  it('leaves an ordinary question exactly as it was', async () => {
    const { adapter, store, surface } = makeHarness();
    const row = makeRow();
    await store.add(row);
    await surface.present(row);
    expect(adapter.posted[0]?.content ?? '').toContain('Which database?');
    expect(labelsOf(adapter.posted[0]?.components ?? [])).toEqual(['Answer', 'Cancel']);
  });
});
