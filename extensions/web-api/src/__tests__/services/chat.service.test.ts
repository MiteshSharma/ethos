import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { isEthosError } from '@ethosagent/types';
import type { SseEvent } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsRepository } from '../../repositories/sessions.repository';
import { ChatService } from '../../services/chat.service';
import { makeStubAgentLoop } from '../test-helpers';

// ChatService composes a real SessionStreamBuffer + SessionsRepository
// (against an in-memory SQLite) but stubs the AgentLoop. That gets us the
// full bridge → buffer → subscriber pipeline without needing LLM creds.

describe('ChatService', () => {
  let store: SQLiteSessionStore;
  let sessions: SessionsRepository;
  let buffer: SessionStreamBuffer<SseEvent>;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    sessions = new SessionsRepository(store);
    buffer = new SessionStreamBuffer<SseEvent>();
  });

  afterEach(() => {
    buffer.destroy();
    store.close();
  });

  function makeService(
    events: import('@ethosagent/core').AgentEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'done', text: 'hello', turnCount: 1 },
    ],
  ) {
    const loop = makeStubAgentLoop({ events });
    return new ChatService({
      loop,
      sessions,
      buffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
  }

  it('send creates a fresh session and returns its id when sessionId is omitted', async () => {
    const service = makeService();
    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    expect(result.sessionId).toMatch(/^.+/);
    expect(result.turnId).toMatch(/^.+/);

    const created = await sessions.get(result.sessionId);
    expect(created).not.toBeNull();
    expect(created?.platform).toBe('web');
    expect(created?.model).toBe('claude-test');
  });

  it('send reuses an existing session when sessionId is provided', async () => {
    const service = makeService();
    const first = await service.send({ clientId: 'tab-1', text: 'hi' });
    const second = await service.send({
      sessionId: first.sessionId,
      clientId: 'tab-1',
      text: 'second turn',
    });
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('send with unknown sessionId throws SESSION_NOT_FOUND', async () => {
    const service = makeService();
    try {
      await service.send({ sessionId: 'nope', clientId: 'tab-1', text: 'hi' });
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
      if (isEthosError(err)) expect(err.code).toBe('SESSION_NOT_FOUND');
    }
  });

  it('subscribe receives bridge events as SseEvents (text_delta + done)', async () => {
    const service = makeService();
    const events: SseEvent[] = [];

    // Subscribe BEFORE sending so we catch live events. (Replay is empty
    // here because nothing has been appended yet.)
    // Use a placeholder id; we'll switch after send returns.
    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    const unsubscribe = service.subscribe(result.sessionId, 0, (b) => events.push(b.event));

    // Bridge runs async — wait a tick for it to drain stub events.
    await waitForEvent(events, (e) => e.some((x) => x.type === 'done'));

    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);

    unsubscribe();
  });

  it('subscribe replays buffered events with seq > sinceSeq', async () => {
    const service = makeService();
    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    // Wait for the turn to flush so events land in the buffer.
    await waitFor(() => buffer.head(result.sessionId) > 0);
    const headBefore = buffer.head(result.sessionId);

    // First subscribe replays everything (sinceSeq=0).
    const all: SseEvent[] = [];
    service.subscribe(result.sessionId, 0, (b) => all.push(b.event))();
    expect(all.length).toBe(headBefore);

    // Second subscribe with sinceSeq=headBefore replays nothing.
    const tail: SseEvent[] = [];
    service.subscribe(result.sessionId, headBefore, (b) => tail.push(b.event))();
    expect(tail.length).toBe(0);
  });

  it('abort is idempotent for unknown sessions', async () => {
    const service = makeService();
    await expect(service.abort('does-not-exist')).resolves.toBeUndefined();
  });

  it('two subscribers on the same session both see live events', async () => {
    // Slow stub — we kick off the turn, then attach two subscribers, then
    // events arrive while both are listening.
    const ticks: import('@ethosagent/core').AgentEvent[] = [];
    for (let i = 0; i < 5; i++) ticks.push({ type: 'text_delta', text: `chunk-${i}` });
    ticks.push({ type: 'done', text: 'chunk-0chunk-1chunk-2chunk-3chunk-4', turnCount: 1 });
    const service = makeService(ticks);

    const result = await service.send({ clientId: 'tab-1', text: 'hi' });

    const seenA: SseEvent[] = [];
    const seenB: SseEvent[] = [];
    const unA = service.subscribe(result.sessionId, 0, (b) => seenA.push(b.event));
    const unB = service.subscribe(result.sessionId, 0, (b) => seenB.push(b.event));

    await waitForEvent(seenA, (e) => e.some((x) => x.type === 'done'));
    await waitForEvent(seenB, (e) => e.some((x) => x.type === 'done'));

    expect(seenA.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(seenB.filter((e) => e.type === 'done')).toHaveLength(1);

    unA();
    unB();
  });

  it('broadcastAll fans out to every active session', async () => {
    const service = makeService();
    const a = await service.send({ clientId: 'tab-1', text: 'hi a' });
    const b = await service.send({ clientId: 'tab-2', text: 'hi b' });

    const seenA: SseEvent[] = [];
    const seenB: SseEvent[] = [];
    const unA = service.subscribe(a.sessionId, 0, (e) => seenA.push(e.event));
    const unB = service.subscribe(b.sessionId, 0, (e) => seenB.push(e.event));

    // Drain the bridge events first.
    await waitForEvent(seenA, (es) => es.some((x) => x.type === 'done'));
    await waitForEvent(seenB, (es) => es.some((x) => x.type === 'done'));

    service.broadcastAll({
      type: 'cron.fired',
      jobId: 'morning',
      ranAt: '2026-04-28T10:00:00Z',
      outputPath: null,
    });

    await waitForEvent(seenA, (es) => es.some((x) => x.type === 'cron.fired'));
    await waitForEvent(seenB, (es) => es.some((x) => x.type === 'cron.fired'));

    expect(seenA.some((x) => x.type === 'cron.fired')).toBe(true);
    expect(seenB.some((x) => x.type === 'cron.fired')).toBe(true);

    unA();
    unB();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function waitForEvent<T>(
  collected: T[],
  predicate: (events: T[]) => boolean,
  timeoutMs = 1000,
): Promise<void> {
  await waitFor(() => predicate(collected), timeoutMs);
}
