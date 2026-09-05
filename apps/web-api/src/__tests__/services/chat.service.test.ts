import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { isEthosError } from '@ethosagent/types';
import type { ActivityEvent, SseEvent } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../../features/chat/repository';
import { ChatService } from '../../features/chat/service';
import { TeamLoopRegistry } from '../../features/chat/team-loops';
import { makeStubAgentLoop } from '../test-helpers';

// ChatService composes a real SessionStreamBuffer + SessionsRepository
// (against an in-memory SQLite) but stubs the AgentLoop. That gets us the
// full bridge → buffer → subscriber pipeline without needing LLM creds.

describe('ChatService', () => {
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
      activityBuffer,
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

  it('a refreshPersonalities that rejects does not abort send (serves last-good)', async () => {
    const loop = makeStubAgentLoop({ events: [{ type: 'done', text: 'ok', turnCount: 1 }] });
    const service = new ChatService({
      loop,
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      refreshPersonalities: async () => {
        throw new Error('malformed personality YAML on disk');
      },
    });
    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    expect(result.sessionId).toMatch(/^.+/);
    expect(result.turnId).toMatch(/^.+/);
  });

  it('subscribe receives bridge events as SseEvents (text_delta + done)', async () => {
    const service = makeService();
    const events: SseEvent[] = [];

    // Subscribe BEFORE sending so we catch live events. (Replay is empty
    // here because nothing has been appended yet.)
    // Use a placeholder id; we'll switch after send returns.
    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    const unsubscribe = service.subscribe(result.sessionId, 0, (b) => {
      events.push(b.event);
    });

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
    service.subscribe(result.sessionId, 0, (b) => {
      all.push(b.event);
    })();
    expect(all.length).toBe(headBefore);

    // Second subscribe with sinceSeq=headBefore replays nothing.
    const tail: SseEvent[] = [];
    service.subscribe(result.sessionId, headBefore, (b) => {
      tail.push(b.event);
    })();
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
    const unA = service.subscribe(result.sessionId, 0, (b) => {
      seenA.push(b.event);
    });
    const unB = service.subscribe(result.sessionId, 0, (b) => {
      seenB.push(b.event);
    });

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
    const unA = service.subscribe(a.sessionId, 0, (e) => {
      seenA.push(e.event);
    });
    const unB = service.subscribe(b.sessionId, 0, (e) => {
      seenB.push(e.event);
    });

    // Drain the bridge events first.
    await waitForEvent(seenA, (es) => es.some((x) => x.type === 'done'));
    await waitForEvent(seenB, (es) => es.some((x) => x.type === 'done'));

    const recipients = service.broadcastAll({
      type: 'cron.fired',
      jobId: 'morning',
      ranAt: '2026-04-28T10:00:00Z',
      outputPath: null,
    });

    // The count is a delivery answer, not a statistic: this is an ephemeral
    // multicast, so a caller that consumes state on the fan-out (the channel
    // digest's watermark) needs to know when it reached nobody.
    expect(recipients).toBe(2);

    await waitForEvent(seenA, (es) => es.some((x) => x.type === 'cron.fired'));
    await waitForEvent(seenB, (es) => es.some((x) => x.type === 'cron.fired'));

    expect(seenA.some((x) => x.type === 'cron.fired')).toBe(true);
    expect(seenB.some((x) => x.type === 'cron.fired')).toBe(true);

    unA();
    unB();
  });

  it('broadcastAll reports zero recipients when no session is open', () => {
    // The state a nightly cron fires into. `broadcastAll` writes to nothing
    // and keeps no record, so a caller told only "it returned" would be told
    // the digest landed.
    expect(
      makeService().broadcastAll({
        type: 'cron.fired',
        jobId: 'morning',
        ranAt: '2026-04-28T10:00:00Z',
        outputPath: null,
      }),
    ).toBe(0);
  });

  it('auto-titles on the first done even when turnCount > 1 (multi-turn first response)', async () => {
    let titleCalls = 0;
    const loop = makeStubAgentLoop({
      events: [
        { type: 'text_delta', text: 'hello' },
        { type: 'done', text: 'hello', turnCount: 3 },
      ],
    });
    const service = new ChatService({
      loop,
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      titleFn: async () => {
        titleCalls++;
        return 'Generated Title';
      },
    });
    const result = await service.send({ clientId: 'tab-1', text: 'first question' });
    await waitFor(() => titleCalls > 0);
    expect(titleCalls).toBe(1);
    const updated = await sessions.get(result.sessionId);
    expect(updated?.title).toBe('Generated Title');
  });

  it('uses the LLM title when titleFn returns a good title', async () => {
    const service = new ChatService({
      loop: makeStubAgentLoop({
        events: [
          { type: 'text_delta', text: 'hi' },
          { type: 'done', text: 'hi', turnCount: 1 },
        ],
      }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      titleFn: async () => 'A Fine Title',
    });
    const result = await service.send({ clientId: 'tab-1', text: 'first question' });
    expect(await waitForTitle(sessions, result.sessionId)).toBe('A Fine Title');
  });

  it('falls back to the first user message when titleFn returns an empty title', async () => {
    const service = new ChatService({
      loop: makeStubAgentLoop({
        events: [{ type: 'done', text: 'ok', turnCount: 1 }],
      }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      titleFn: async () => '   ',
    });
    const result = await service.send({ clientId: 'tab-1', text: 'How do I center a div?' });
    const title = await waitForTitle(sessions, result.sessionId);
    expect(title).toBe('How do I center a div?');
    expect(title?.length).toBeLessThanOrEqual(63);
  });

  it('falls back to the first user message when titleFn throws', async () => {
    const service = new ChatService({
      loop: makeStubAgentLoop({
        events: [{ type: 'done', text: 'ok', turnCount: 1 }],
      }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      titleFn: async () => {
        throw new Error('LLM unreachable');
      },
    });
    const result = await service.send({ clientId: 'tab-1', text: 'Fix the login bug' });
    expect(await waitForTitle(sessions, result.sessionId)).toBe('Fix the login bug');
  });

  it('falls back to the first user message when titleFn is absent', async () => {
    // makeService wires no titleFn.
    const service = makeService([{ type: 'done', text: 'ok', turnCount: 1 }]);
    const result = await service.send({ clientId: 'tab-1', text: 'Explain event loops' });
    expect(await waitForTitle(sessions, result.sessionId)).toBe('Explain event loops');
  });

  it('fallback title is single-line and truncated for long multi-line messages', async () => {
    const service = makeService([{ type: 'done', text: 'ok', turnCount: 1 }]);
    const longText = `${'word '.repeat(40)}\nsecond line should be dropped`;
    const result = await service.send({ clientId: 'tab-1', text: longText });
    const title = (await waitForTitle(sessions, result.sessionId)) ?? '';
    expect(title).not.toContain('\n');
    expect(title).not.toContain('second line');
    expect(title.length).toBeLessThanOrEqual(63);
    expect(title.endsWith('…')).toBe(true);
  });

  it('a rejecting subscriber does not crash the emitter or starve other subscribers', async () => {
    const service = makeService();
    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    // Let the initial turn drain into the buffer.
    await waitFor(() => buffer.head(result.sessionId) > 0);

    // Trap any unhandled rejection that escapes during this test.
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const good: SseEvent[] = [];
      // Bad subscriber: its onEvent rejects on every event.
      const headNow = buffer.head(result.sessionId);
      const unBad = service.subscribe(result.sessionId, headNow, async () => {
        throw new Error('subscriber boom');
      });
      const unGood = service.subscribe(result.sessionId, headNow, (b) => {
        good.push(b.event);
      });

      // Push a live event through the same path append/broadcast uses.
      service.broadcast(result.sessionId, {
        type: 'cron.fired',
        jobId: 'boom-test',
        ranAt: '2026-04-28T10:00:00Z',
        outputPath: null,
      });

      await waitForEvent(good, (es) => es.some((x) => x.type === 'cron.fired'));

      // The good subscriber still received the event despite the bad one rejecting.
      expect(good.some((x) => x.type === 'cron.fired')).toBe(true);

      // Flush microtasks + a macrotask so any floated rejection would surface.
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toBeNull();

      unBad();
      unGood();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // The idle watcher's busy predicate for the web-chat surface. `bridges` is
  // long-lived per session, so these tests pin the difference between "a
  // session has a bridge" and "a turn is in flight".
  it('hasActiveBridges is false when no bridge exists', () => {
    expect(makeService().hasActiveBridges()).toBe(false);
  });

  it('hasActiveBridges is false when a bridge exists but no turn is running', async () => {
    const service = makeService();
    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    await waitFor(() => buffer.head(result.sessionId) > 0);

    // The bridge is still in the map — it is only dropped by `forget`. A
    // `bridges.size > 0` implementation would wrongly report busy here, and
    // the idle watcher would never suspend an idle process.
    const bridges = (service as unknown as { bridges: Map<string, unknown> }).bridges;
    expect(bridges.size).toBe(1);
    expect(service.hasActiveBridges()).toBe(false);
  });

  it('hasActiveBridges is true while a turn runs and false again once it finishes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new ChatService({
      loop: makeStubAgentLoop({ events: [{ type: 'done', text: 'ok', turnCount: 1 }], gate }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });

    const result = await service.send({ clientId: 'tab-1', text: 'hi' });
    await waitFor(() => service.hasActiveBridges());
    expect(service.hasActiveBridges()).toBe(true);

    release();
    await waitFor(() => buffer.head(result.sessionId) > 0);
    await waitFor(() => !service.hasActiveBridges());
    expect(service.hasActiveBridges()).toBe(false);
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

/** Poll the session store until a title is set (auto-title runs async on `done`). */
async function waitForTitle(
  sessions: ChatRepository,
  sessionId: string,
  timeoutMs = 1000,
): Promise<string | undefined> {
  const start = Date.now();
  for (;;) {
    const session = await sessions.get(sessionId);
    if (session?.title) return session.title;
    if (Date.now() - start > timeoutMs) return undefined;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Talk-mode turns are ordinary chat turns on the ordinary chat session — same
// personality, same history. The ONLY thing that distinguishes them is that
// the text is a transcript, and the loop has to be told so, or the model
// answers a spoken question in markdown (voice V1a task A10).
describe('ChatService — voice-origin on talk-mode turns', () => {
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

  function serviceCapturing(runOpts: Array<Record<string, unknown>>) {
    const loop = makeStubAgentLoop({
      events: [{ type: 'done', text: 'ok', turnCount: 1 }],
      onRun: (_input, opts) => {
        runOpts.push(opts as Record<string, unknown>);
      },
    });
    return new ChatService({
      loop,
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
  }

  it("origin: 'voice' becomes an owner-spoken voiceOrigin on the run", async () => {
    const runOpts: Array<Record<string, unknown>> = [];
    await serviceCapturing(runOpts).send({ clientId: 'tab-1', text: 'call mum', origin: 'voice' });
    await new Promise((r) => setTimeout(r, 0));

    expect(runOpts).toHaveLength(1);
    expect(runOpts[0]?.voiceOrigin).toEqual({
      transport: 'browser-talk-mode',
      // The browser session IS the owner's, behind the same auth as the rest
      // of the surface. A far-end caller cannot reach this code path.
      speaker: 'owner',
    });
  });

  it('a typed send carries no voiceOrigin at all', async () => {
    const runOpts: Array<Record<string, unknown>> = [];
    await serviceCapturing(runOpts).send({ clientId: 'tab-1', text: 'call mum' });
    await new Promise((r) => setTimeout(r, 0));

    expect(runOpts).toHaveLength(1);
    expect(runOpts[0]?.voiceOrigin).toBeUndefined();
  });

  it("an explicit origin: 'text' is treated as typed", async () => {
    const runOpts: Array<Record<string, unknown>> = [];
    await serviceCapturing(runOpts).send({ clientId: 'tab-1', text: 'hi', origin: 'text' });
    await new Promise((r) => setTimeout(r, 0));

    expect(runOpts[0]?.voiceOrigin).toBeUndefined();
  });
});

// The activity fan-out is a SECOND read path over the same `append`
// chokepoint: every session's events land in one shared bucket, and scoping
// to a single agent is a read-time filter rather than a separate buffer.
describe('ChatService — activity fan-out', () => {
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

  function makeService() {
    return new ChatService({
      // The `text_delta` is what the activity filter must drop; the tool pair
      // gives each turn more than one activity event so the seq/replay cases
      // have something to page through.
      loop: makeStubAgentLoop({
        events: [
          { type: 'text_delta', text: 'hello' },
          { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: {} },
          { type: 'tool_end', toolCallId: 'tc1', toolName: 'read_file', ok: true, durationMs: 3 },
          { type: 'done', text: 'hello', turnCount: 1 },
        ],
      }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
  }

  /** Run one turn on a fresh session owned by `personalityId`. */
  async function runTurn(service: ChatService, personalityId: string): Promise<string> {
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'hi', personalityId });
    await waitFor(() => buffer.head(sessionId) > 0);
    return sessionId;
  }

  it('scopes the replay to one personality; null replays every personality', async () => {
    const service = makeService();
    const sessionA = await runTurn(service, 'agentA');
    const sessionB = await runTurn(service, 'agentB');
    await waitFor(() => activityBuffer.head('__activity__') >= 4);

    const scoped: ActivityEvent[] = [];
    service.subscribeActivity('agentA', 0, (b) => {
      scoped.push(b.event);
    })();

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((e) => e.personalityId === 'agentA')).toBe(true);
    expect(scoped.every((e) => e.sessionId === sessionA)).toBe(true);

    const global: ActivityEvent[] = [];
    service.subscribeActivity(null, 0, (b) => {
      global.push(b.event);
    })();

    expect(global.some((e) => e.sessionId === sessionA)).toBe(true);
    expect(global.some((e) => e.sessionId === sessionB)).toBe(true);
    expect(global.length).toBeGreaterThan(scoped.length);
  });

  it('delivers live events to a scoped subscriber, filtering out other agents', async () => {
    const service = makeService();
    const scoped: ActivityEvent[] = [];
    const unsubscribe = service.subscribeActivity('agentA', 0, (b) => {
      scoped.push(b.event);
    });

    await runTurn(service, 'agentB');
    await runTurn(service, 'agentA');
    await waitForEvent(scoped, (e) => e.some((x) => x.event.type === 'done'));

    expect(scoped.every((e) => e.personalityId === 'agentA')).toBe(true);
    expect(scoped.some((e) => e.event.type === 'done')).toBe(true);

    unsubscribe();
  });

  // The activity bucket takes only what the feed renders. Streaming tokens are
  // the reason this filter exists: without it every token of every session is
  // fanned out to every activity listener and evicts the shared replay buffer.
  it('keeps text_delta on the per-session stream and off the activity feed', async () => {
    const service = makeService();

    const perSession: SseEvent[] = [];
    const activity: ActivityEvent[] = [];
    const stopActivity = service.subscribeActivity(null, 0, (b) => {
      activity.push(b.event);
    });

    const { sessionId } = await service.send({
      clientId: 'tab-1',
      text: 'hi',
      personalityId: 'agentA',
    });
    const stopSession = service.subscribe(sessionId, 0, (b) => {
      perSession.push(b.event);
    });
    await waitForEvent(perSession, (e) => e.some((x) => x.type === 'done'));

    expect(perSession.some((e) => e.type === 'text_delta')).toBe(true);
    expect(activity.some((e) => e.event.type === 'text_delta')).toBe(false);
    // The activity feed still sees the same turn's discrete actions.
    expect(activity.some((e) => e.event.type === 'done' && e.sessionId === sessionId)).toBe(true);

    stopSession();
    stopActivity();
  });

  it('replays only events with seq > sinceSeq', async () => {
    const service = makeService();
    await runTurn(service, 'agentA');
    await waitFor(() => activityBuffer.head('__activity__') > 0);
    const head = activityBuffer.head('__activity__');

    const all: Array<{ seq: number }> = [];
    service.subscribeActivity(null, 0, (b) => {
      all.push({ seq: b.seq });
    })();
    expect(all.length).toBe(head);

    const tail: Array<{ seq: number }> = [];
    service.subscribeActivity(null, 1, (b) => {
      tail.push({ seq: b.seq });
    })();
    expect(tail.length).toBe(head - 1);
    expect(tail[0]?.seq).toBe(2);

    const none: Array<{ seq: number }> = [];
    service.subscribeActivity(null, head, (b) => {
      none.push({ seq: b.seq });
    })();
    expect(none.length).toBe(0);
  });

  it('tags a broadcast on an unknown session null, then backfills the next one', async () => {
    const service = makeService();
    const sessionId = await runTurn(service, 'agentA');

    // A fresh service has never seen this session through send()/requireSession(),
    // so the first broadcast misses the personality cache.
    const cold = new ChatService({
      loop: makeStubAgentLoop({ events: [] }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });

    const seen: ActivityEvent[] = [];
    const unsubscribe = cold.subscribeActivity(null, activityBuffer.head('__activity__'), (b) => {
      seen.push(b.event);
    });

    cold.broadcast(sessionId, { type: 'notification', message: 'first' });
    expect(seen[0]?.personalityId).toBeNull();

    // The miss kicked off a fire-and-forget lookup; the next event is tagged.
    await waitFor(() => {
      cold.broadcast(sessionId, { type: 'notification', message: 'later' });
      return seen[seen.length - 1]?.personalityId === 'agentA';
    });

    unsubscribe();
  });
});

// Team routing (plan/phases/teams-as-a-scope.md D4, §9): a personality that
// belongs to a team runs on that team's loop; everything else on the main one.
describe('ChatService — team-scoped loops', () => {
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

  const MEMBERSHIP = [{ name: 'marketing', members: ['cmo', 'writer'], coordinator: 'cmo' }];

  function makeRouted(opts: { failTeamBuild?: boolean } = {}) {
    const ran: Array<{ loop: string; personalityId: unknown }> = [];
    const record = (loop: string) => (_input: string, runOpts: unknown) => {
      ran.push({ loop, personalityId: (runOpts as { personalityId?: string }).personalityId });
    };
    const mainLoop = makeStubAgentLoop({ onRun: record('main') });
    const teamLoop = makeStubAgentLoop({ onRun: record('team:marketing') });
    let mainRefreshes = 0;
    let teamRefreshes = 0;
    const teamLoops = new TeamLoopRegistry({
      factory: async () => {
        if (opts.failTeamBuild) throw new Error('manifest broken');
        return {
          loop: teamLoop,
          refreshPersonalities: async () => {
            teamRefreshes++;
          },
        };
      },
      listTeams: async () => MEMBERSHIP,
    });
    const service = new ChatService({
      loop: mainLoop,
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
      refreshPersonalities: async () => {
        mainRefreshes++;
      },
      teamLoops,
    });
    return {
      service,
      ran,
      refreshes: () => ({ main: mainRefreshes, team: teamRefreshes }),
    };
  }

  it('a turn for a team member runs on the team loop; a non-member on the main loop', async () => {
    const { service, ran } = makeRouted();

    await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'writer' });
    await waitFor(() => ran.length === 1);
    expect(ran[0]).toEqual({ loop: 'team:marketing', personalityId: 'writer' });

    await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'researcher' });
    await waitFor(() => ran.length === 2);
    expect(ran[1]).toEqual({ loop: 'main', personalityId: 'researcher' });
  });

  it('the coordinator and a member share the team loop — one scope, two doors', async () => {
    const { service, ran } = makeRouted();
    await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'cmo' });
    await service.send({ clientId: 'tab-2', text: 'hi', personalityId: 'writer' });
    await waitFor(() => ran.length === 2);
    expect(ran.map((r) => r.loop)).toEqual(['team:marketing', 'team:marketing']);
  });

  it('a follow-up turn without personalityId routes by the session personality', async () => {
    const { service, ran } = makeRouted();
    const first = await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'cmo' });
    await waitFor(() => ran.length === 1);
    await service.send({ sessionId: first.sessionId, clientId: 'tab-1', text: 'again' });
    await waitFor(() => ran.length === 2);
    expect(ran[1]?.loop).toBe('team:marketing');
  });

  it('refreshes the personality registry of the loop the turn runs on', async () => {
    const { service, ran, refreshes } = makeRouted();
    await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'writer' });
    await waitFor(() => ran.length === 1);
    expect(refreshes()).toEqual({ main: 0, team: 1 });
    await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'researcher' });
    await waitFor(() => ran.length === 2);
    expect(refreshes()).toEqual({ main: 1, team: 1 });
  });

  it('a team loop that fails to build rejects the turn instead of silently dropping scope', async () => {
    const { service, ran } = makeRouted({ failTeamBuild: true });
    try {
      await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'writer' });
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
      if (isEthosError(err)) {
        expect(err.code).toBe('CONFIG_INVALID');
        expect(err.message).toContain('marketing');
      }
    }
    expect(ran).toHaveLength(0);
  });

  it('without a registry every turn runs on the main loop', async () => {
    const ran: string[] = [];
    const service = new ChatService({
      loop: makeStubAgentLoop({ onRun: () => ran.push('main') }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
    await service.send({ clientId: 'tab-1', text: 'hi', personalityId: 'cmo' });
    await waitFor(() => ran.length === 1);
    expect(ran).toEqual(['main']);
  });
});
