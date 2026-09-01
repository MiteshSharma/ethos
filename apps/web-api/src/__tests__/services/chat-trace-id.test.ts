// B3 — web-api chat publishes the LOOP's turn identity, and mints none of its
// own.
//
// Two halves:
//   • the `traceId` on `run_start` / `done` is passed straight through onto the
//     SSE stream (via the bridge's trailing arg), so a tab can name the turn it
//     is watching, and
//   • `chat.send`'s `turnId` is the request id the HTTP layer supplied — the
//     `randomUUID()` that used to sit there named nothing else in the system.
//
// The events are parsed with the shared Zod schema (never cast) so a drift
// between the AgentEvent field and the wire contract fails here.

import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { type ActivityEvent, type SseEvent, SseEventSchema } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../../features/chat/repository';
import { ChatService } from '../../features/chat/service';
import { makeStubAgentLoop } from '../test-helpers';

describe('ChatService — turn identity (B3)', () => {
  let store: SQLiteSessionStore;
  let sessions: ChatRepository;
  let buffer: SessionStreamBuffer<SseEvent>;
  let activityBuffer: SessionStreamBuffer<ActivityEvent>;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    sessions = new ChatRepository(store);
    buffer = new SessionStreamBuffer<SseEvent>();
    activityBuffer = new SessionStreamBuffer<ActivityEvent>();
  });

  afterEach(() => {
    buffer.destroy();
    activityBuffer.destroy();
    store.close();
  });

  function makeService(events: import('@ethosagent/core').AgentEvent[]) {
    return new ChatService({
      loop: makeStubAgentLoop({ events }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
  }

  async function drain(service: ChatService, sessionId: string): Promise<SseEvent[]> {
    // The bridge runs async; `send` returns as soon as the turn is queued.
    await new Promise((r) => setTimeout(r, 50));
    const seen: SseEvent[] = [];
    const unsubscribe = service.subscribe(sessionId, 0, (b) => {
      seen.push(SseEventSchema.parse(b.event));
    });
    unsubscribe();
    return seen;
  }

  it('passes the turn traceId through onto run_start and done', async () => {
    const service = makeService([
      {
        type: 'run_start',
        provider: 'anthropic',
        model: 'm',
        source: 'global',
        traceId: 'trace-9',
      },
      { type: 'text_delta', text: 'hi' },
      { type: 'done', text: 'hi', turnCount: 1, traceId: 'trace-9' },
    ]);
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'hi' });

    const events = await drain(service, sessionId);
    const runStart = events.find((e) => e.type === 'run_start');
    const done = events.find((e) => e.type === 'done');
    expect(runStart?.type === 'run_start' ? runStart.traceId : null).toBe('trace-9');
    expect(done?.type === 'done' ? done.traceId : null).toBe('trace-9');
  });

  it('omits traceId on the wire when the loop emitted none', async () => {
    const service = makeService([
      { type: 'run_start', provider: 'anthropic', model: 'm', source: 'global' },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'hi' });

    const events = await drain(service, sessionId);
    const runStart = events.find((e) => e.type === 'run_start');
    const done = events.find((e) => e.type === 'done');
    expect(runStart?.type === 'run_start' ? runStart.traceId : 'set').toBeUndefined();
    expect(done?.type === 'done' ? done.traceId : 'set').toBeUndefined();
  });

  it('returns the caller-supplied request id as turnId instead of minting one', async () => {
    const service = makeService([{ type: 'done', text: '', turnCount: 1 }]);
    const result = await service.send({
      clientId: 'tab-1',
      text: 'hi',
      requestId: 'req-abc',
    });
    expect(result.turnId).toBe('req-abc');
  });
});
