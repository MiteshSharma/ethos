import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import type { AgentEvent } from '@ethosagent/core';
import { SQLiteCardStore } from '@ethosagent/session-cards';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { ActivityEvent, CardEnvelope, SseEvent } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateStructuredCard } from '../../features/chat/card-gate';
import { ChatRepository } from '../../features/chat/repository';
import { ChatService } from '../../features/chat/service';
import { SessionsRepository } from '../../features/sessions/repository';
import { SessionsService } from '../../features/sessions/service';
import { makeStubAgentLoop } from '../test-helpers';

// Contract tests for the card pipeline (ui-cards-canvas B1 + B2):
// emit → gate → persist → `sessions.get` replay. Real ChatService + real
// SQLite stores; only the AgentLoop is stubbed.

const EVERY_KIND: CardEnvelope[] = [
  { kind: 'text', specVersion: 1, payload: { title: 'Note', text: 'hello' } },
  { kind: 'code', specVersion: 1, payload: { language: 'sql', code: 'SELECT 1' } },
  { kind: 'alert', specVersion: 1, payload: { severity: 'error', message: 'it broke' } },
  {
    kind: 'detail',
    specVersion: 1,
    payload: { title: 'Position', status: 'open', fields: [{ label: 'Qty', value: '10' }] },
  },
  {
    kind: 'item_list',
    specVersion: 1,
    payload: { items: [{ id: 'nifty', name: 'NIFTY', status: 'ok' }] },
  },
  {
    kind: 'data_table',
    specVersion: 1,
    payload: {
      columns: [{ key: 'sym', label: 'Symbol' }],
      rows: [{ sym: 'NIFTY' }],
    },
  },
  {
    kind: 'metric_chart',
    specVersion: 1,
    payload: { series: [{ name: 'pnl', points: [{ x: '2026-01-01', y: 12 }] }] },
  },
  {
    kind: 'recommend_actions',
    specVersion: 1,
    payload: { actions: [{ label: 'Retry', prompt: 'retry the fetch' }] },
  },
  { kind: 'canvas', specVersion: 1, payload: { title: 'Chart', html: '<div id="c"></div>' } },
];

function cardToolEvents(envelopes: CardEnvelope[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  envelopes.forEach((envelope, i) => {
    events.push({
      type: 'tool_end',
      toolCallId: `call-${i}`,
      toolName: 'emit_card',
      ok: true,
      durationMs: 1,
      result: 'card emitted',
      structured: { card: envelope },
    });
  });
  events.push({ type: 'done', text: '', turnCount: 1 });
  return events;
}

describe('gateStructuredCard', () => {
  it('passes `structured` through untouched when there is no card key', () => {
    const structured = { _uiType: 'image', url: 'file:///tmp/x.png' };
    expect(gateStructuredCard(structured)).toEqual({ structured });
  });

  it('returns nothing when there is no structured payload at all', () => {
    expect(gateStructuredCard(undefined)).toEqual({});
  });

  it('accepts a valid envelope and hands back the parsed card', () => {
    const card = EVERY_KIND[0];
    const gated = gateStructuredCard({ card });
    expect(gated.card).toEqual(card);
    expect(gated.structured).toEqual({ card });
    expect(gated.issues).toBeUndefined();
  });

  it('drops an unknown kind and reports the issue path', () => {
    const gated = gateStructuredCard({
      card: { kind: 'mystery', specVersion: 1, payload: { text: 'hi' } },
    });
    expect(gated.card).toBeUndefined();
    expect(gated.structured).toBeUndefined();
    expect(gated.issues?.length).toBeGreaterThan(0);
    expect(gated.issues?.[0]).toContain('card.kind');
  });

  it('strips only the card key, keeping the rest of `structured`', () => {
    const gated = gateStructuredCard({
      card: { kind: 'text', specVersion: 1, payload: {} },
      _uiType: 'html',
    });
    expect(gated.card).toBeUndefined();
    expect(gated.structured).toEqual({ _uiType: 'html' });
    expect(gated.issues?.some((i) => i.includes('card.payload.text'))).toBe(true);
  });

  it('rejects an envelope whose specVersion is not the current one', () => {
    const gated = gateStructuredCard({
      card: { kind: 'text', specVersion: 2, payload: { text: 'hi' } },
    });
    expect(gated.card).toBeUndefined();
    expect(gated.issues?.length).toBeGreaterThan(0);
  });
});

describe('card wire + replay', () => {
  let store: SQLiteSessionStore;
  let cards: SQLiteCardStore;
  let buffer: SessionStreamBuffer<SseEvent>;
  let activityBuffer: SessionStreamBuffer<ActivityEvent>;
  let chatRepo: ChatRepository;
  let sessionsRepo: SessionsRepository;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    cards = new SQLiteCardStore(':memory:');
    buffer = new SessionStreamBuffer<SseEvent>();
    activityBuffer = new SessionStreamBuffer<ActivityEvent>();
    chatRepo = new ChatRepository(store);
    sessionsRepo = new SessionsRepository(store);
  });

  afterEach(() => {
    buffer.destroy();
    activityBuffer.destroy();
    cards.close();
    store.close();
    vi.restoreAllMocks();
  });

  function makeChat(events: AgentEvent[]): ChatService {
    return new ChatService({
      loop: makeStubAgentLoop({ events }),
      sessions: chatRepo,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      cardStore: cards,
    });
  }

  function makeSessions(): SessionsService {
    return new SessionsService({ sessions: sessionsRepo, cards });
  }

  /** Run one turn and return its sessionId once the stream reaches `done`. */
  async function runTurn(chat: ChatService): Promise<{ sessionId: string; seen: SseEvent[] }> {
    const { sessionId } = await chat.send({ clientId: 'tab-1', text: 'hi' });
    const seen: SseEvent[] = [];
    const unsubscribe = chat.subscribe(sessionId, 0, (b) => {
      seen.push(b.event);
    });
    await waitFor(() => seen.some((e) => e.type === 'done'));
    unsubscribe();
    return { sessionId, seen };
  }

  it('round-trips every card kind through the wire and back out of sessions.get', async () => {
    const chat = makeChat(cardToolEvents(EVERY_KIND));
    const { sessionId, seen } = await runTurn(chat);

    const broadcast = seen.filter((e) => e.type === 'tool_end');
    expect(broadcast).toHaveLength(EVERY_KIND.length);
    expect(broadcast.map((e) => (e.type === 'tool_end' ? e.structured?.card : null))).toEqual(
      EVERY_KIND,
    );

    // Replay after the stream is gone — the buffer is not consulted here.
    const replayed = await makeSessions().get(sessionId);
    expect(replayed.cards.map((c) => c.envelope)).toEqual(EVERY_KIND);
    expect(replayed.cards.map((c) => c.seq)).toEqual(EVERY_KIND.map((_, i) => i));
    expect(replayed.cards.map((c) => c.toolCallId)).toEqual(EVERY_KIND.map((_, i) => `call-${i}`));
  });

  it('an invalid envelope is neither broadcast nor persisted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chat = makeChat([
      {
        type: 'tool_end',
        toolCallId: 'call-bad',
        toolName: 'emit_card',
        ok: true,
        durationMs: 1,
        result: 'card emitted',
        structured: { card: { kind: 'text', specVersion: 1, payload: { text: '' } } },
      },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const { sessionId, seen } = await runTurn(chat);

    const toolEnd = seen.find((e) => e.type === 'tool_end');
    expect(toolEnd).toBeDefined();
    // The tool_end still reaches the client — only the card is gone.
    expect(toolEnd?.type === 'tool_end' && toolEnd.structured).toBeUndefined();
    expect((await makeSessions().get(sessionId)).cards).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('call-bad');
  });

  it('an unknown kind off the wire never reaches the client or the store', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chat = makeChat([
      {
        type: 'tool_end',
        toolCallId: 'call-x',
        toolName: 'render_ui',
        ok: true,
        durationMs: 1,
        structured: { card: { kind: 'hologram', specVersion: 1, payload: {} }, _uiType: 'html' },
      },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const { sessionId, seen } = await runTurn(chat);

    const toolEnd = seen.find((e) => e.type === 'tool_end');
    // The sibling `_uiType` key survives; the unknown card does not.
    expect(toolEnd?.type === 'tool_end' && toolEnd.structured).toEqual({ _uiType: 'html' });
    expect((await makeSessions().get(sessionId)).cards).toEqual([]);
  });

  it('a replayed tool_end persists exactly one card', async () => {
    const envelope = EVERY_KIND[0];
    const duplicate: AgentEvent = {
      type: 'tool_end',
      toolCallId: 'call-dup',
      toolName: 'emit_card',
      ok: true,
      durationMs: 1,
      structured: { card: envelope },
    };
    const chat = makeChat([duplicate, duplicate, { type: 'done', text: '', turnCount: 1 }]);
    const { sessionId, seen } = await runTurn(chat);

    // Both events reach the wire (dedup is not this layer's job) …
    expect(seen.filter((e) => e.type === 'tool_end')).toHaveLength(2);
    // … but replay carries one card.
    const replayed = await makeSessions().get(sessionId);
    expect(replayed.cards).toHaveLength(1);
    expect(replayed.cards[0]?.envelope).toEqual(envelope);
  });

  it('a row whose stored envelope no longer validates is skipped, not thrown', async () => {
    const chat = makeChat(cardToolEvents([EVERY_KIND[0], EVERY_KIND[1]]));
    const { sessionId } = await runTurn(chat);

    // Rewrite one row as an envelope from a future spec version.
    // biome-ignore lint/suspicious/noExplicitAny: reaching past the store API is how a stale row is simulated.
    const db = (cards as any).db;
    db.prepare('UPDATE session_cards SET envelope = ? WHERE tool_call_id = ?').run(
      JSON.stringify({ kind: 'text', specVersion: 42, payload: { text: 'from the future' } }),
      'call-0',
    );

    const replayed = await makeSessions().get(sessionId);
    expect(replayed.cards).toHaveLength(1);
    expect(replayed.cards[0]?.toolCallId).toBe('call-1');
  });

  it('deleting a session drops its cards', async () => {
    const chat = makeChat(cardToolEvents([EVERY_KIND[0]]));
    const { sessionId } = await runTurn(chat);
    const sessions = makeSessions();
    expect((await sessions.get(sessionId)).cards).toHaveLength(1);

    await sessions.delete(sessionId);
    expect(cards.list(sessionId)).toEqual([]);
  });

  it('forking a session carries its cards along with its messages', async () => {
    const chat = makeChat(cardToolEvents([EVERY_KIND[0]]));
    const { sessionId } = await runTurn(chat);
    const sessions = makeSessions();

    const forked = await sessions.fork(sessionId);
    const replayed = await sessions.get(forked.session.id);
    expect(replayed.cards.map((c) => c.envelope)).toEqual([EVERY_KIND[0]]);
    // The source keeps its own copy.
    expect((await sessions.get(sessionId)).cards).toHaveLength(1);
  });

  it('a chat service with no card store behaves exactly as before', async () => {
    const chat = new ChatService({
      loop: makeStubAgentLoop({ events: cardToolEvents([EVERY_KIND[0]]) }),
      sessions: chatRepo,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
    const { sessionId, seen } = await runTurn(chat);

    const toolEnd = seen.find((e) => e.type === 'tool_end');
    expect(toolEnd?.type === 'tool_end' && toolEnd.structured?.card).toEqual(EVERY_KIND[0]);
    // No store wired here, and `sessions.get` without one replays nothing.
    const bare = new SessionsService({ sessions: sessionsRepo });
    expect((await bare.get(sessionId)).cards).toEqual([]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
