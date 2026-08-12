// The browser end of the voice-origin chain (task A10).
//
// A talk-mode turn goes through the ordinary chat send, which is the point —
// same session, same personality, same persisted history as typing. The risk
// that creates is that it becomes INDISTINGUISHABLE from typing by the time it
// reaches the loop, and the model answers a spoken question with a markdown
// table. The runner is the one place that knows, so it is the one place that
// must say so.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscribe = vi.fn();
vi.mock('../../../sse', () => ({
  subscribeToSession: (sessionId: string, handlers: { onEvent: (e: unknown) => void }) => {
    subscribe(sessionId);
    // Deliver a terminal event on the next tick so the runner's stream ends.
    queueMicrotask(() => handlers.onEvent({ type: 'done', text: 'ok' }));
    return { close: () => {} };
  },
}));

const { runVoiceAgentTurn } = await import('../chat-voice-runner');

interface SendCall {
  text: string;
  opts: { origin?: 'text' | 'voice' } | undefined;
}

beforeEach(() => {
  subscribe.mockClear();
});

async function run(sessionId: string | null): Promise<SendCall[]> {
  const calls: SendCall[] = [];
  const stream = runVoiceAgentTurn('book me a table', new AbortController().signal, {
    sessionId: () => sessionId,
    sendMessage: async (text, _attachments, opts) => {
      calls.push({ text, opts });
    },
    abortTurn: async () => {},
  });
  for await (const _chunk of stream) {
    // drain
  }
  return calls;
}

describe('runVoiceAgentTurn', () => {
  it('marks the turn as spoken on an existing session', async () => {
    const calls = await run('sess-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('book me a table');
    expect(calls[0]?.opts).toEqual({ origin: 'voice' });
  });

  // The first utterance of a call creates the session, and takes a different
  // branch (await the send to learn the id). It must mark the turn too — the
  // opening question of a voice call is exactly the one you do not want
  // answered in markdown.
  it('marks the turn as spoken on the session-creating first utterance', async () => {
    const calls = await run(null);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toEqual({ origin: 'voice' });
  });
});
