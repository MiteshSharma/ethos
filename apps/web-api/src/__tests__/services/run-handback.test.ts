import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { ActivityEvent, SseEvent } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatRunHandBack } from '../../features/chat/handback';
import { ChatRepository } from '../../features/chat/repository';
import { ChatService } from '../../features/chat/service';
import { makeStubAgentLoop } from '../test-helpers';

// I18 / §4.9 / D27 — the completion hand-back.
//
// The run ends where it started: as a message in the PARENT conversation, from
// Ethos. Not the runner's tokens pasted into the chat, and not a new
// notification bus — it rides the same `text_delta` + `done` pair a turn does,
// and is persisted first so a reload finds it in history.

describe('formatRunHandBack', () => {
  it('states the facts and offers to go further', () => {
    expect(
      formatRunHandBack({
        runner: 'pi',
        label: 'auth-refactor',
        status: 'done',
        summary: 'Took the dual-write path; deprecation window is in the migration notes.',
        error: undefined,
        spendUsd: 0.38,
        elapsedMs: 401_000,
      }),
    ).toMatchInlineSnapshot(`
      "Pi finished run auth-refactor — $0.38 in 6m 41s.

      Took the dual-write path; deprecation window is in the migration notes.

      Want me to go through it before you look?"
    `);
  });

  it('names the reason on a failure', () => {
    const text = formatRunHandBack({
      runner: 'pi',
      label: 'auth-refactor',
      status: 'failed',
      summary: undefined,
      error: 'exceeded max_cost_usd',
      spendUsd: 2,
      elapsedMs: 60_000,
    });
    expect(text).toContain('failed run auth-refactor');
    expect(text).toContain('exceeded max_cost_usd');
  });

  it('says nothing when the user cancelled it themselves', () => {
    // They pressed Cancel and watched the card go terminal. Announcing it back
    // to them is noise.
    expect(
      formatRunHandBack({
        runner: 'pi',
        label: 'x',
        status: 'aborted',
        summary: undefined,
        error: undefined,
        spendUsd: 0,
        elapsedMs: 1,
      }),
    ).toBeNull();
  });

  it('carries no harness name of its own', () => {
    const text = formatRunHandBack({
      runner: 'zzharness',
      label: undefined,
      status: 'done',
      summary: undefined,
      error: undefined,
      spendUsd: 0,
      elapsedMs: undefined,
    });
    expect(text).toContain('Zzharness finished the run');
    expect(text?.toLowerCase()).not.toContain('pi ');
  });
});

describe('ChatService.handBack', () => {
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
      loop: makeStubAgentLoop({
        events: [
          { type: 'text_delta', text: 'hello' },
          { type: 'done', text: 'hello', turnCount: 1 },
        ],
      }),
      sessions,
      buffer,
      activityBuffer,
      defaults: { model: 'claude-test', provider: 'anthropic' },
    });
  }

  it('persists the notice into the parent session as an assistant message', async () => {
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'hi' });
    await settle(service, sessionId);

    await service.handBack(sessionId, 'The run finished.');

    const messages = await store.getMessages(sessionId, { limit: 50 });
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('assistant');
    expect(last?.content).toBe('The run finished.');
  });

  it('rides the same text_delta + done pair a turn does', async () => {
    // D27 taken literally: no new notification bus. The browser already knows
    // how to render this shape, and a reload replays it from history.
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'hi' });
    await settle(service, sessionId);

    const seen: SseEvent[] = [];
    const unsubscribe = service.subscribe(sessionId, Number.MAX_SAFE_INTEGER, (e) => {
      seen.push(e.event);
    });
    await service.handBack(sessionId, 'The run finished.');
    unsubscribe();

    expect(seen.map((e) => e.type)).toEqual(['text_delta', 'done']);
  });

  it('is a no-op for empty text', async () => {
    const service = makeService();
    const { sessionId } = await service.send({ clientId: 'tab-1', text: 'hi' });
    await settle(service, sessionId);
    const before = (await store.getMessages(sessionId, { limit: 50 })).length;

    await service.handBack(sessionId, '');

    expect((await store.getMessages(sessionId, { limit: 50 })).length).toBe(before);
  });
});

/**
 * Let the stub turn finish. A hand-back arriving mid-turn is deliberately held
 * until the turn's own `done` — otherwise its text is spliced into the middle
 * of the bubble above it.
 */
async function settle(service: ChatService, sessionId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = service.subscribe(sessionId, 0, (e) => {
      if (e.event.type === 'done') {
        unsubscribe();
        resolve();
      }
    });
  });
}
